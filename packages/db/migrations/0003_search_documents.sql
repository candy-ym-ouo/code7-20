-- 全文检索模块：独立的检索文档表 + 同步检查点。
--
-- 设计要点：
-- 1. search_documents 是读模型，由 worker 分批 upsert 维护；不建外键，
--    避免索引维护与内容写入互相加锁（索引重建不得阻塞写入）。
-- 2. 权限过滤不在索引层固化，查询时 JOIN map_features/comments 按当前
--    status/deleted_at 过滤，索引短暂滞后不会泄露未公开内容。
-- 3. 中文子串走 pg_trgm（search_text），拼音/首字母走预生成的
--    pinyin_compact / pinyin_initials（同样 pg_trgm），拉丁词走 tsv。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE search_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type text NOT NULL CHECK (doc_type IN ('feature', 'comment')),
  doc_id uuid NOT NULL,
  feature_id uuid NOT NULL,
  category_key text,
  title_text text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  -- tags 的空格拼接形式，由写入方维护（array_to_string 非 IMMUTABLE，不能进生成列）
  tags_text text NOT NULL DEFAULT '',
  pinyin_compact text NOT NULL DEFAULT '',
  pinyin_initials text NOT NULL DEFAULT '',
  search_text text GENERATED ALWAYS AS (
    title_text || E'\n' || body_text || E'\n' || tags_text
  ) STORED,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', title_text), 'A') ||
    setweight(to_tsvector('simple', tags_text), 'A') ||
    setweight(to_tsvector('simple', body_text), 'B')
  ) STORED,
  source_updated_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_type, doc_id)
);

CREATE INDEX search_documents_tsv_gix ON search_documents USING gin (tsv);
CREATE INDEX search_documents_search_text_gix ON search_documents USING gin (search_text gin_trgm_ops);
CREATE INDEX search_documents_pinyin_compact_gix ON search_documents USING gin (pinyin_compact gin_trgm_ops);
CREATE INDEX search_documents_pinyin_initials_gix ON search_documents USING gin (pinyin_initials gin_trgm_ops);
CREATE INDEX search_documents_tags_gix ON search_documents USING gin (tags);
CREATE INDEX search_documents_feature_idx ON search_documents(feature_id);
CREATE INDEX search_documents_sort_idx ON search_documents(doc_type, source_updated_at DESC, id DESC);

-- 增量同步检查点：每个来源一行，keyset 游标 (last_source_updated_at, last_doc_id)。
CREATE TABLE search_sync_state (
  source text PRIMARY KEY,
  last_source_updated_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  last_doc_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO search_sync_state(source) VALUES ('features'), ('comments');
