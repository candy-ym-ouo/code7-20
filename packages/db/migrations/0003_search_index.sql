-- 全文检索模块
--
-- 设计要点：
--   1. search_documents 是地点(feature)与评论(comment)共用的反范式检索表。
--      业务表写入只通过触发器向 search_index_changes 追加一行轻量变更，
--      文档构建（拼音/分词/连表）全部由 Worker 异步完成，不阻塞业务写入。
--   2. Worker 用 FOR UPDATE SKIP LOCKED 批量认领变更并刷新文档；
--      全量重建走“快照入队 → 排空 → 清理”的并发切换，不锁业务表，
--      重建期间写入产生的变更照常入队并被处理。
--   3. 中文按单字/相邻双字切分写入 tsvector；拼音（全拼、紧凑全拼、首字母）
--      由应用层生成，pg_trgm GIN 索引支撑拼音前缀/模糊匹配。
--   4. 索引保留所有未软删状态（draft/pending/published/hidden/...），
--      可见性与对象级权限一律在查询层按调用者身份过滤，索引层不做权限决策。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE search_index_changes (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  doc_type text NOT NULL CHECK (doc_type IN ('feature', 'comment')),
  doc_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('upsert', 'delete')),
  enqueued_at timestamptz NOT NULL DEFAULT now()
);
-- 同一文档在队列里最多一条待处理变更：合并重复写入，Worker 处理完即释放。
CREATE UNIQUE INDEX search_index_changes_pending_idx
  ON search_index_changes(doc_type, doc_id);
CREATE INDEX search_index_changes_id_idx ON search_index_changes(id);

CREATE TABLE search_index_rebuilds (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  status text NOT NULL CHECK (status IN ('snapshotting', 'indexing', 'completed', 'failed')),
  queued_count integer NOT NULL DEFAULT 0,
  last_change_id bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE search_documents (
  doc_type text NOT NULL CHECK (doc_type IN ('feature', 'comment')),
  doc_id uuid NOT NULL,
  feature_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  status text NOT NULL,
  category_key text,
  tags text[] NOT NULL DEFAULT '{}',
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  author_name text NOT NULL DEFAULT '',
  longitude double precision,
  latitude double precision,
  pinyin_full text NOT NULL DEFAULT '',
  pinyin_compact text NOT NULL DEFAULT '',
  pinyin_initials text NOT NULL DEFAULT '',
  search_vector tsvector NOT NULL DEFAULT ''::tsvector,
  -- 稳定分页游标排序值，取内容自身的稳定时间，不随重新索引而变。
  sort_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_type, doc_id)
);
CREATE INDEX search_documents_status_sort_idx
  ON search_documents(status, doc_type, sort_at DESC, doc_id DESC);
CREATE INDEX search_documents_feature_idx ON search_documents(feature_id) WHERE doc_type = 'comment';
CREATE INDEX search_documents_category_idx
  ON search_documents(category_key) WHERE doc_type = 'feature';
CREATE INDEX search_documents_owner_idx ON search_documents(owner_id);
CREATE INDEX search_documents_tags_idx ON search_documents USING gin (tags);
CREATE INDEX search_documents_vector_idx ON search_documents USING gin (search_vector);
CREATE INDEX search_documents_pinyin_compact_trgm_idx ON search_documents USING gin (pinyin_compact gin_trgm_ops);
CREATE INDEX search_documents_pinyin_initials_trgm_idx ON search_documents USING gin (pinyin_initials gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 变更入队：业务事务内只做一次轻量 INSERT，ON CONFLICT 与已有待处理项合并
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_enqueue_change(p_doc_type text, p_doc_id uuid, p_op text)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO search_index_changes(doc_type, doc_id, op)
  VALUES (p_doc_type, p_doc_id, p_op)
  ON CONFLICT (doc_type, doc_id) DO UPDATE
    -- 待处理期间若发生删除，操作语义必须升级为 delete。
    SET op = CASE WHEN search_index_changes.op = 'delete' THEN 'delete' ELSE EXCLUDED.op END,
        enqueued_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION search_feature_changed()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM search_enqueue_change('feature', OLD.id, 'delete');
    INSERT INTO search_index_changes(doc_type, doc_id, op)
    SELECT 'comment', c.id, 'delete'
    FROM comments c
    WHERE c.feature_id = OLD.id AND c.deleted_at IS NULL
    ON CONFLICT (doc_type, doc_id) DO UPDATE
      SET op = 'delete', enqueued_at = now();
    RETURN NULL;
  END IF;

  -- 软删后对所有角色不可见（与 REST 详情接口一致），移出索引；
  -- 其余状态（draft/pending/published/hidden/rejected/...）全部保留，
  -- 由查询层按身份决定可见性。
  PERFORM search_enqueue_change(
    'feature', NEW.id,
    CASE WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'upsert' END
  );

  -- 地点可见性变化会级联影响其评论文档（评论行自身没变化）。
  IF TG_OP = 'UPDATE'
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
          OR NEW.category_key IS DISTINCT FROM OLD.category_key) THEN
    INSERT INTO search_index_changes(doc_type, doc_id, op)
    SELECT 'comment', c.id,
           CASE WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'upsert' END
    FROM comments c
    WHERE c.feature_id = NEW.id AND c.deleted_at IS NULL
    ON CONFLICT (doc_type, doc_id) DO UPDATE
      SET op = CASE
                 WHEN EXCLUDED.op = 'delete' THEN 'delete'
                 ELSE search_index_changes.op
               END,
          enqueued_at = now();
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS search_feature_changed_trg ON map_features;
CREATE TRIGGER search_feature_changed_trg
  AFTER INSERT OR UPDATE OF status, deleted_at, category_key, current_revision_id
  ON map_features
  FOR EACH ROW EXECUTE FUNCTION search_feature_changed();

DROP TRIGGER IF EXISTS search_feature_deleted_trg ON map_features;
CREATE TRIGGER search_feature_deleted_trg
  AFTER DELETE ON map_features
  FOR EACH ROW EXECUTE FUNCTION search_feature_changed();

-- 草稿/修订内容变更（作者编辑）也需要刷新作者自己能搜到的草稿文档。
CREATE OR REPLACE FUNCTION search_revision_changed()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  PERFORM search_enqueue_change('feature', NEW.feature_id, 'upsert');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS search_revision_changed_trg ON feature_revisions;
CREATE TRIGGER search_revision_changed_trg
  AFTER INSERT OR UPDATE OF payload, status
  ON feature_revisions
  FOR EACH ROW EXECUTE FUNCTION search_revision_changed();

CREATE OR REPLACE FUNCTION search_comment_changed()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_feature record;
  v_op text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM search_enqueue_change('comment', OLD.id, 'delete');
    RETURN NULL;
  END IF;

  SELECT status, deleted_at INTO v_feature
  FROM map_features WHERE id = NEW.feature_id;

  IF NEW.deleted_at IS NOT NULL
     OR v_feature IS NULL
     OR v_feature.deleted_at IS NOT NULL THEN
    v_op := 'delete';
  ELSE
    -- pending/published/hidden/rejected 全部入索引，查询层按身份过滤。
    v_op := 'upsert';
  END IF;

  PERFORM search_enqueue_change('comment', NEW.id, v_op);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS search_comment_changed_trg ON comments;
CREATE TRIGGER search_comment_changed_trg
  AFTER INSERT OR UPDATE OF feature_id, body, status, deleted_at
  ON comments
  FOR EACH ROW EXECUTE FUNCTION search_comment_changed();

DROP TRIGGER IF EXISTS search_comment_deleted_trg ON comments;
CREATE TRIGGER search_comment_deleted_trg
  AFTER DELETE ON comments
  FOR EACH ROW EXECUTE FUNCTION search_comment_changed();

-- ---------------------------------------------------------------------------
-- 中文分词函数（拼音文本由应用层生成后传入）
-- ---------------------------------------------------------------------------

-- 把文本拆成 CJK 单字与相邻双字，如“朝阳公园” -> {朝, 阳, 公, 园, 朝阳, 阳公, 公园}
CREATE OR REPLACE FUNCTION search_cjk_tokens(p_text text)
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  WITH chars AS (
    SELECT row_number() OVER () AS idx, match[1] AS ch
    FROM regexp_matches(p_text, '[一-鿿]', 'g') AS match
  )
  SELECT COALESCE(array_agg(token), '{}'::text[])
  FROM (
    SELECT ch AS token, idx FROM chars
    UNION ALL
    SELECT a.ch || b.ch, a.idx
    FROM chars a JOIN chars b ON b.idx = a.idx + 1
  ) AS tokens(token, idx)
$$;

-- ---------------------------------------------------------------------------
-- 索引与查询文本函数（拼音文本由应用层生成后传入）
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_build_tsvector(
  p_title text DEFAULT '',
  p_body text DEFAULT '',
  p_author text DEFAULT '',
  p_tags text[] DEFAULT '{}',
  p_pinyin_full text DEFAULT '',
  p_extra text DEFAULT ''
)
RETURNS tsvector
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_vector tsvector := ''::tsvector;
  v_token text;
BEGIN
  -- 标题权重 A：标签/作者权重 B；正文、全拼与附加文本（分类名/所属地点名）权重 C
  IF COALESCE(p_title, '') <> '' THEN
    v_vector := v_vector || setweight(to_tsvector('simple', p_title), 'A');
  END IF;
  IF array_length(p_tags, 1) IS NOT NULL THEN
    v_vector := v_vector || setweight(to_tsvector('simple', array_to_string(p_tags, ' ')), 'B');
  END IF;
  IF COALESCE(p_author, '') <> '' THEN
    v_vector := v_vector || setweight(to_tsvector('simple', p_author), 'B');
  END IF;
  IF COALESCE(p_body, '') <> '' THEN
    v_vector := v_vector || setweight(to_tsvector('simple', p_body), 'C');
  END IF;
  IF COALESCE(p_extra, '') <> '' THEN
    v_vector := v_vector || setweight(to_tsvector('simple', p_extra), 'C');
  END IF;
  IF COALESCE(p_pinyin_full, '') <> '' THEN
    v_vector := v_vector || setweight(to_tsvector('simple', p_pinyin_full), 'C');
  END IF;

  FOREACH v_token IN ARRAY COALESCE(
    search_cjk_tokens(concat_ws(' ', p_title, p_body, p_extra)), '{}'::text[]
  )
  LOOP
    v_vector := v_vector || setweight(to_tsvector('simple', v_token), 'C');
  END LOOP;
  RETURN v_vector;
END;
$$;

-- 查询词 → tsquery：每个“词”内部取 CJK 单字+相邻双字、拉丁/数字取整词，全部 AND。
-- 词之间（空格/标点）不产生跨词双字，如“长椅 休息”不会产生“椅休”。
-- 词元都经过白名单字符约束，可直接拼接为 tsquery，无需处理转义。
CREATE OR REPLACE FUNCTION search_build_tsquery(p_query text)
RETURNS tsquery
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE((
    SELECT string_agg(term, ' & ' ORDER BY term)::tsquery
    FROM (
      SELECT DISTINCT term
      FROM regexp_split_to_table(COALESCE(p_query, ''), '[^一-鿿A-Za-z0-9_]+') AS run,
      LATERAL unnest(
        CASE WHEN run ~ '[一-鿿]' THEN search_cjk_tokens(run) ELSE '{}'::text[] END
        || CASE WHEN run ~ '[A-Za-z0-9_]'
                THEN ARRAY[lower(regexp_replace(run, '[^A-Za-z0-9_]+', '', 'g'))]
                ELSE '{}'::text[] END
      ) AS term
      WHERE length(term) BETWEEN 1 AND 64
    ) terms
  ), NULL);
$$;

-- ---------------------------------------------------------------------------
-- 并发重建：建快照 → Worker 排空队列(含快照) → 清理孤儿文档
-- 全程不锁业务表；重建期间触发器持续为业务写入追加变更。
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_start_rebuild()
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_rebuild_id bigint;
BEGIN
  -- 仅重建之间互斥，与业务写入不冲突。
  PERFORM pg_advisory_xact_lock(91727345);

  INSERT INTO search_index_rebuilds(status) VALUES ('snapshotting') RETURNING id INTO v_rebuild_id;

  INSERT INTO search_index_changes(doc_type, doc_id, op)
  SELECT 'feature', mf.id,
         CASE WHEN mf.deleted_at IS NOT NULL THEN 'delete' ELSE 'upsert' END
  FROM map_features mf
  ON CONFLICT (doc_type, doc_id) DO UPDATE
    SET op = CASE WHEN EXCLUDED.op = 'delete' THEN 'delete' ELSE search_index_changes.op END,
        enqueued_at = now();

  INSERT INTO search_index_changes(doc_type, doc_id, op)
  SELECT 'comment', c.id,
         CASE
           WHEN c.deleted_at IS NOT NULL OR mf.deleted_at IS NOT NULL THEN 'delete'
           ELSE 'upsert'
         END
  FROM comments c
  JOIN map_features mf ON mf.id = c.feature_id
  ON CONFLICT (doc_type, doc_id) DO UPDATE
    SET op = CASE WHEN EXCLUDED.op = 'delete' THEN 'delete' ELSE search_index_changes.op END,
        enqueued_at = now();

  UPDATE search_index_rebuilds r
  SET queued_count = (SELECT count(*) FROM search_index_changes),
      last_change_id = COALESCE((SELECT max(id) FROM search_index_changes), 0),
      status = 'indexing'
  WHERE r.id = v_rebuild_id;

  RETURN v_rebuild_id;
END;
$$;

CREATE OR REPLACE FUNCTION search_finish_rebuild(p_rebuild_id bigint)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_rebuild search_index_rebuilds%ROWTYPE;
BEGIN
  SELECT * INTO v_rebuild FROM search_index_rebuilds WHERE id = p_rebuild_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rebuild % not found', p_rebuild_id;
  END IF;
  IF v_rebuild.status = 'completed' THEN
    RETURN 'completed';
  END IF;

  -- last_change_id 之后仍有变更，说明 Worker 尚未追平；保持 indexing，
  -- 由调用方（Worker 定时轮询）稍后重试。
  IF EXISTS (SELECT 1 FROM search_index_changes WHERE id > v_rebuild.last_change_id LIMIT 1) THEN
    RETURN 'indexing';
  END IF;

  -- 仅清理快照之前构建、且源行已不存在或已软删的孤儿文档；
  -- 快照之后新产生/刷新的文档 indexed_at 晚于 started_at，不会被误删。
  DELETE FROM search_documents d
  USING search_index_rebuilds r
  WHERE r.id = p_rebuild_id
    AND d.indexed_at < r.started_at
    AND (
      (d.doc_type = 'feature'
       AND NOT EXISTS (
         SELECT 1 FROM map_features mf
         WHERE mf.id = d.doc_id AND mf.deleted_at IS NULL
       ))
      OR
      (d.doc_type = 'comment'
       AND NOT EXISTS (
         SELECT 1 FROM comments c
         WHERE c.id = d.doc_id AND c.deleted_at IS NULL
       ))
    );

  UPDATE search_index_rebuilds
  SET status = 'completed', completed_at = now()
  WHERE id = p_rebuild_id;
  RETURN 'completed';
END;
$$;
