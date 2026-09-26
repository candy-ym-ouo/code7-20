import { buildPinyinIndex } from "@map/shared/pinyin";
import { pool } from "./db";

/**
 * 检索索引维护。
 *
 * 不阻塞写入的设计：
 *  - 增量同步与全量重建都按批执行（默认每批 500 行），每批一个短事务，
 *    只对当前批次的 search_documents 行加锁，内容表只读；
 *  - search_documents 不设外键，内容写入路径无需等待索引；
 *  - 可见性由查询层按内容表实时过滤，索引短暂滞后不会造成越权或泄露。
 *
 * 同步水位：只处理 updated_at <= now() - SYNC_LAG_MS 的行，避开刚启动
 * 尚未提交的事务，防止 keyset 检查点越过未提交行。
 *
 * 时间戳精度：keyset 比较统一使用 date_trunc('milliseconds', ...)，
 * 与 JS Date 的毫秒精度对齐，避免微秒截断导致末行被重复同步。
 */

const SYNC_BATCH_SIZE = 500;
const PURGE_BATCH_SIZE = 500;
const SYNC_LAG_MS = 5_000;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const EPOCH = "1970-01-01T00:00:00Z";

type Checkpoint = {
  last_source_updated_at: Date;
  last_doc_id: string;
};

type FeaturePayload = {
  title?: unknown;
  description?: unknown;
  tags?: unknown;
};

function payloadText(payload: FeaturePayload | null): { title: string; description: string; tags: string[] } {
  const title = typeof payload?.title === "string" ? payload.title : "";
  const description = typeof payload?.description === "string" ? payload.description : "";
  const tags = Array.isArray(payload?.tags)
    ? payload.tags.filter((item): item is string => typeof item === "string").slice(0, 8)
    : [];
  return { title, description, tags };
}

async function getCheckpoint(source: string): Promise<Checkpoint> {
  const result = await pool.query<Checkpoint>(
    "SELECT last_source_updated_at, last_doc_id FROM search_sync_state WHERE source = $1",
    [source]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`search_sync_state is missing source ${source}`);
  return row;
}

const UPSERT_SQL = `
  INSERT INTO search_documents (
    doc_type, doc_id, feature_id, category_key,
    title_text, body_text, tags, tags_text,
    pinyin_compact, pinyin_initials,
    source_updated_at, indexed_at
  )
  SELECT
    docs.doc_type, docs.doc_id, docs.feature_id, docs.category_key,
    docs.title_text, docs.body_text,
    -- 标签以 JSON 文本传递，避免 text[][] 锯齿数组在 PG 中不合法
    ARRAY(SELECT jsonb_array_elements_text(docs.tags_json::jsonb)),
    docs.tags_text,
    docs.pinyin_compact, docs.pinyin_initials,
    docs.source_updated_at, now()
  FROM unnest(
    $1::text[], $2::uuid[], $3::uuid[], $4::text[],
    $5::text[], $6::text[], $7::text[], $8::text[],
    $9::text[], $10::text[], $11::timestamptz[]
  ) AS docs(
    doc_type, doc_id, feature_id, category_key,
    title_text, body_text, tags_json, tags_text,
    pinyin_compact, pinyin_initials, source_updated_at
  )
  ON CONFLICT (doc_type, doc_id) DO UPDATE SET
    feature_id = EXCLUDED.feature_id,
    category_key = EXCLUDED.category_key,
    title_text = EXCLUDED.title_text,
    body_text = EXCLUDED.body_text,
    tags = EXCLUDED.tags,
    tags_text = EXCLUDED.tags_text,
    pinyin_compact = EXCLUDED.pinyin_compact,
    pinyin_initials = EXCLUDED.pinyin_initials,
    source_updated_at = EXCLUDED.source_updated_at,
    indexed_at = now()`;

type DocColumn = {
  docType: string[];
  docId: string[];
  featureId: string[];
  categoryKey: string[];
  title: string[];
  body: string[];
  /** 每行一个 JSON 数组字符串，如 '["安静","有靠背"]' */
  tags: string[];
  /** tags 的空格拼接，供生成列使用（array_to_string 非 IMMUTABLE） */
  tagsText: string[];
  pinyinCompact: string[];
  pinyinInitials: string[];
  sourceUpdatedAt: Date[];
};

function emptyColumns(): DocColumn {
  return {
    docType: [], docId: [], featureId: [], categoryKey: [],
    title: [], body: [], tags: [], tagsText: [], pinyinCompact: [], pinyinInitials: [], sourceUpdatedAt: []
  };
}

async function applyBatch(source: string, columns: DocColumn, checkpoint: { ts: Date; id: string }): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(UPSERT_SQL, [
      columns.docType, columns.docId, columns.featureId, columns.categoryKey,
      columns.title, columns.body, columns.tags, columns.tagsText,
      columns.pinyinCompact, columns.pinyinInitials, columns.sourceUpdatedAt
    ]);
    // 检查点只允许单调前进，避免并发执行时回退造成重复扫描
    await client.query(
      `UPDATE search_sync_state
       SET last_source_updated_at = $2, last_doc_id = $3, updated_at = now()
       WHERE source = $1 AND (last_source_updated_at, last_doc_id) < ($2, $3)`,
      [source, checkpoint.ts, checkpoint.id]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 同步地点文档：取当前公开修订（无公开修订时取最新修订）的文本。 */
export async function syncFeatureDocuments(batchSize = SYNC_BATCH_SIZE): Promise<number> {
  const checkpoint = await getCheckpoint("features");
  const cutoff = new Date(Date.now() - SYNC_LAG_MS);
  const result = await pool.query<{
    id: string;
    category_key: string;
    updated_at: Date;
    payload: FeaturePayload | null;
  }>(
    `SELECT mf.id, mf.category_key,
            date_trunc('milliseconds', mf.updated_at) AS updated_at,
            COALESCE(current_revision.payload, latest.payload) AS payload
     FROM map_features mf
     LEFT JOIN feature_revisions current_revision ON current_revision.id = mf.current_revision_id
     LEFT JOIN LATERAL (
       SELECT payload FROM feature_revisions
       WHERE feature_id = mf.id ORDER BY revision_no DESC LIMIT 1
     ) latest ON true
     WHERE mf.deleted_at IS NULL
       AND (date_trunc('milliseconds', mf.updated_at), mf.id) > ($1, $2)
       AND mf.updated_at <= $3
     ORDER BY date_trunc('milliseconds', mf.updated_at), mf.id
     LIMIT $4`,
    [checkpoint.last_source_updated_at, checkpoint.last_doc_id, cutoff, batchSize]
  );
  if (!result.rowCount) return 0;

  const columns = emptyColumns();
  for (const row of result.rows) {
    const { title, description, tags } = payloadText(row.payload);
    const pinyin = buildPinyinIndex([title, description, ...tags]);
    columns.docType.push("feature");
    columns.docId.push(row.id);
    columns.featureId.push(row.id);
    columns.categoryKey.push(row.category_key);
    columns.title.push(title);
    columns.body.push(description);
    columns.tags.push(JSON.stringify(tags));
    columns.tagsText.push(tags.join(" "));
    columns.pinyinCompact.push(pinyin.compact);
    columns.pinyinInitials.push(pinyin.initials);
    columns.sourceUpdatedAt.push(row.updated_at);
  }
  const last = result.rows[result.rowCount - 1]!;
  await applyBatch("features", columns, { ts: last.updated_at, id: last.id });
  return result.rowCount;
}

/** 同步评论文档：分类与标签继承所属地点，便于组合筛选。 */
export async function syncCommentDocuments(batchSize = SYNC_BATCH_SIZE): Promise<number> {
  const checkpoint = await getCheckpoint("comments");
  const cutoff = new Date(Date.now() - SYNC_LAG_MS);
  const result = await pool.query<{
    id: string;
    feature_id: string;
    body: string;
    updated_at: Date;
    category_key: string;
    feature_payload: FeaturePayload | null;
  }>(
    `SELECT cm.id, cm.feature_id, cm.body,
            date_trunc('milliseconds', cm.updated_at) AS updated_at,
            mf.category_key,
            COALESCE(current_revision.payload, latest.payload) AS feature_payload
     FROM comments cm
     JOIN map_features mf ON mf.id = cm.feature_id AND mf.deleted_at IS NULL
     LEFT JOIN feature_revisions current_revision ON current_revision.id = mf.current_revision_id
     LEFT JOIN LATERAL (
       SELECT payload FROM feature_revisions
       WHERE feature_id = mf.id ORDER BY revision_no DESC LIMIT 1
     ) latest ON true
     WHERE cm.deleted_at IS NULL
       AND (date_trunc('milliseconds', cm.updated_at), cm.id) > ($1, $2)
       AND cm.updated_at <= $3
     ORDER BY date_trunc('milliseconds', cm.updated_at), cm.id
     LIMIT $4`,
    [checkpoint.last_source_updated_at, checkpoint.last_doc_id, cutoff, batchSize]
  );
  if (!result.rowCount) return 0;

  const columns = emptyColumns();
  for (const row of result.rows) {
    const { tags } = payloadText(row.feature_payload);
    const pinyin = buildPinyinIndex([row.body]);
    columns.docType.push("comment");
    columns.docId.push(row.id);
    columns.featureId.push(row.feature_id);
    columns.categoryKey.push(row.category_key);
    columns.title.push("");
    columns.body.push(row.body);
    columns.tags.push(JSON.stringify(tags));
    columns.tagsText.push(tags.join(" "));
    columns.pinyinCompact.push(pinyin.compact);
    columns.pinyinInitials.push(pinyin.initials);
    columns.sourceUpdatedAt.push(row.updated_at);
  }
  const last = result.rows[result.rowCount - 1]!;
  await applyBatch("comments", columns, { ts: last.updated_at, id: last.id });
  return result.rowCount;
}

/** 清理来源已删除的文档（分批，避免长事务持锁）。 */
export async function purgeStaleDocuments(batchSize = PURGE_BATCH_SIZE): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM search_documents WHERE id IN (
         SELECT sd.id FROM search_documents sd
         WHERE (sd.doc_type = 'feature'
                AND NOT EXISTS (SELECT 1 FROM map_features mf WHERE mf.id = sd.doc_id AND mf.deleted_at IS NULL))
            OR (sd.doc_type = 'comment'
                AND (NOT EXISTS (SELECT 1 FROM comments cm WHERE cm.id = sd.doc_id AND cm.deleted_at IS NULL)
                     OR NOT EXISTS (SELECT 1 FROM map_features mf WHERE mf.id = sd.feature_id AND mf.deleted_at IS NULL)))
         LIMIT $1
       )`,
      [batchSize]
    );
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

let maintenanceActive = false;

/** 周期性增量同步入口（由 worker 定时器调用，保证不并发重入）。 */
export async function runSearchSyncTick(): Promise<void> {
  if (maintenanceActive) return;
  maintenanceActive = true;
  try {
    const features = await syncFeatureDocuments();
    const comments = await syncCommentDocuments();
    if (features + comments > 0) {
      console.log({ features, comments }, "search index sync applied");
    }
  } catch (error) {
    console.error({ error }, "search index sync failed");
  } finally {
    maintenanceActive = false;
  }
}

async function acquireMaintenanceLock(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (maintenanceActive) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  maintenanceActive = true;
  return true;
}

/**
 * 全量重建：重置检查点后分批重放全部内容，最后清理孤儿文档。
 * 全程小事务 upsert，不锁内容表、不锁索引表，写入与查询可正常进行。
 * 重建期间周期性增量同步暂停，由本函数独占推进检查点。
 */
export async function rebuildSearchIndexes(): Promise<void> {
  // 增量同步通常亚秒完成，短暂等待即可；超时则让 BullMQ 记录失败以便重试
  if (!(await acquireMaintenanceLock(30_000))) {
    throw new Error("search index maintenance is busy, rebuild not started");
  }
  try {
    console.log("search index rebuild started");
    await pool.query(
      "UPDATE search_sync_state SET last_source_updated_at = $2, last_doc_id = $3, updated_at = now() WHERE source = $1",
      ["features", EPOCH, ZERO_UUID]
    );
    await pool.query(
      "UPDATE search_sync_state SET last_source_updated_at = $2, last_doc_id = $3, updated_at = now() WHERE source = $1",
      ["comments", EPOCH, ZERO_UUID]
    );
    for (;;) {
      const features = await syncFeatureDocuments();
      const comments = await syncCommentDocuments();
      if (features === 0 && comments === 0) break;
      console.log({ features, comments }, "search index rebuild progress");
    }
    const purged = await purgeStaleDocuments();
    console.log({ purged }, "search index rebuild finished");
  } finally {
    maintenanceActive = false;
  }
}
