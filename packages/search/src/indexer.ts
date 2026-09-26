import type { Pool, PoolClient, QueryResultRow } from "pg";
import { buildPinyinFromParts } from "./pinyin";

export type SearchDocType = "feature" | "comment";

export type Change = {
  id: string;
  docType: SearchDocType;
  docId: string;
  op: "upsert" | "delete";
};

export type IndexStats = {
  claimed: number;
  upserted: number;
  deleted: number;
  missing: number;
};

type FeatureSource = QueryResultRow & {
  doc_id: string;
  owner_id: string;
  status: string;
  category_key: string;
  extra_text: string;
  longitude: number | null;
  latitude: number | null;
  tags: string[] | null;
  title: string | null;
  description: string | null;
  author_name: string;
  sort_at: Date;
};

type CommentSource = QueryResultRow & {
  doc_id: string;
  feature_id: string;
  author_id: string;
  author_name: string;
  status: string;
  body: string;
  extra_text: string;
  tags: string[] | null;
  longitude: number | null;
  latitude: number | null;
  sort_at: Date;
};

type IndexRow = {
  doc_type: SearchDocType;
  doc_id: string;
  feature_id: string;
  owner_id: string;
  status: string;
  category_key: string | null;
  tags: string[];
  title: string;
  body: string;
  author_name: string;
  longitude: number | null;
  latitude: number | null;
  pinyin_full: string;
  pinyin_compact: string;
  pinyin_initials: string;
  sort_at: string;
  extra_text: string;
};

const FEATURE_SOURCE_SQL = `
  SELECT
    q.doc_id,
    mf.owner_id,
    mf.status,
    mf.category_key,
    COALESCE(cat.name, '') AS extra_text,
    ST_X(mf.geom::geometry) AS longitude,
    ST_Y(mf.geom::geometry) AS latitude,
    -- 已发布内容索引当前批准版本（修订审核期间公开版本不变）；
    -- 未发布内容（草稿/待审/被拒）回退到最新修订，让作者能搜到自己的待处理内容。
    COALESCE(current_fr.payload->'tags', latest_fr.payload->'tags', '[]'::jsonb) AS tags,
    COALESCE(current_fr.payload->>'title', latest_fr.payload->>'title', '') AS title,
    COALESCE(current_fr.payload->>'description', latest_fr.payload->>'description', '') AS description,
    COALESCE(u.display_name, '') AS author_name,
    COALESCE(mf.first_published_at, mf.created_at) AS sort_at
  FROM unnest($1::uuid[]) AS q(doc_id)
  JOIN map_features mf ON mf.id = q.doc_id
  JOIN users u ON u.id = mf.owner_id
  LEFT JOIN categories cat ON cat.key = mf.category_key
  LEFT JOIN feature_revisions current_fr ON current_fr.id = mf.current_revision_id
  LEFT JOIN LATERAL (
    -- 仅在从未发布（current_revision_id 为空）时取最新修订：
    -- 已发布内容即使有待审新修订，也继续索引当前批准版本，避免提前泄露。
    SELECT fr.payload
    FROM feature_revisions fr
    WHERE mf.current_revision_id IS NULL AND fr.feature_id = mf.id
    ORDER BY fr.revision_no DESC
    LIMIT 1
  ) latest_fr ON true
  WHERE mf.deleted_at IS NULL
`;

const COMMENT_SOURCE_SQL = `
  SELECT
    q.doc_id,
    c.feature_id,
    c.author_id,
    COALESCE(u.display_name, '') AS author_name,
    c.status,
    c.body,
    concat_ws(' ', COALESCE(fr.payload->>'title', ''), COALESCE(cat.name, '')) AS extra_text,
    COALESCE(fr.payload->'tags', '[]'::jsonb) AS tags,
    ST_X(mf.geom::geometry) AS longitude,
    ST_Y(mf.geom::geometry) AS latitude,
    c.created_at AS sort_at
  FROM unnest($1::uuid[]) AS q(doc_id)
  JOIN comments c ON c.id = q.doc_id
  JOIN users u ON u.id = c.author_id
  JOIN map_features mf ON mf.id = c.feature_id
  LEFT JOIN categories cat ON cat.key = mf.category_key
  LEFT JOIN feature_revisions fr ON fr.id = mf.current_revision_id
  WHERE c.deleted_at IS NULL AND mf.deleted_at IS NULL
`;

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function featureIndexRow(row: FeatureSource): IndexRow {
  const title = row.title ?? "";
  const body = row.description ?? "";
  const tags = toTextArray(row.tags);
  const pinyin = buildPinyinFromParts(title, body, tags.join(" "), row.extra_text);
  return {
    doc_type: "feature",
    doc_id: row.doc_id,
    feature_id: row.doc_id,
    owner_id: row.owner_id,
    status: row.status,
    category_key: row.category_key,
    tags,
    title,
    body,
    author_name: row.author_name,
    longitude: row.longitude === null ? null : Number(row.longitude),
    latitude: row.latitude === null ? null : Number(row.latitude),
    pinyin_full: pinyin.full,
    pinyin_compact: pinyin.compact,
    pinyin_initials: pinyin.initials,
    sort_at: row.sort_at.toISOString(),
    extra_text: row.extra_text
  };
}

function commentIndexRow(row: CommentSource): IndexRow {
  const pinyin = buildPinyinFromParts(row.body, row.author_name, row.extra_text);
  return {
    doc_type: "comment",
    doc_id: row.doc_id,
    feature_id: row.feature_id,
    owner_id: row.author_id,
    status: row.status,
    category_key: null,
    tags: toTextArray(row.tags),
    title: "",
    body: row.body,
    author_name: row.author_name,
    longitude: row.longitude === null ? null : Number(row.longitude),
    latitude: row.latitude === null ? null : Number(row.latitude),
    pinyin_full: pinyin.full,
    pinyin_compact: pinyin.compact,
    pinyin_initials: pinyin.initials,
    sort_at: row.sort_at.toISOString(),
    extra_text: row.extra_text
  };
}

const UPSERT_SQL = `
  INSERT INTO search_documents (
    doc_type, doc_id, feature_id, owner_id, status, category_key, tags,
    title, body, author_name, longitude, latitude,
    pinyin_full, pinyin_compact, pinyin_initials, search_vector, sort_at, indexed_at
  )
  SELECT
    r.doc_type, r.doc_id::uuid, r.feature_id::uuid, r.owner_id::uuid,
    r.status, NULLIF(r.category_key, ''), r.tags,
    r.title, r.body, r.author_name, r.longitude, r.latitude,
    r.pinyin_full, r.pinyin_compact, r.pinyin_initials,
    search_build_tsvector(r.title, r.body, r.author_name, r.tags,
                          r.pinyin_full, r.extra_text),
    r.sort_at::timestamptz, now()
  FROM jsonb_to_recordset($1::jsonb) AS r(
    doc_type text, doc_id text, feature_id text, owner_id text,
    status text, category_key text, tags text[],
    title text, body text, author_name text,
    longitude double precision, latitude double precision,
    pinyin_full text, pinyin_compact text, pinyin_initials text,
    sort_at text, extra_text text
  )
  ON CONFLICT (doc_type, doc_id) DO UPDATE SET
    feature_id = EXCLUDED.feature_id,
    owner_id = EXCLUDED.owner_id,
    status = EXCLUDED.status,
    category_key = EXCLUDED.category_key,
    tags = EXCLUDED.tags,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    author_name = EXCLUDED.author_name,
    longitude = EXCLUDED.longitude,
    latitude = EXCLUDED.latitude,
    pinyin_full = EXCLUDED.pinyin_full,
    pinyin_compact = EXCLUDED.pinyin_compact,
    pinyin_initials = EXCLUDED.pinyin_initials,
    search_vector = EXCLUDED.search_vector,
    sort_at = EXCLUDED.sort_at,
    indexed_at = now()
`;

async function loadIndexRows(
  client: PoolClient,
  docType: SearchDocType,
  ids: string[]
): Promise<IndexRow[]> {
  if (ids.length === 0) return [];
  const result = await client.query<FeatureSource | CommentSource>(
    docType === "feature" ? FEATURE_SOURCE_SQL : COMMENT_SOURCE_SQL,
    [ids]
  );
  return result.rows.map((row) =>
    docType === "feature"
      ? featureIndexRow(row as FeatureSource)
      : commentIndexRow(row as CommentSource)
  );
}

/**
 * 认领并处理一批索引变更。使用 FOR UPDATE SKIP LOCKED：
 * 多个 Worker 不会抢同一行，认领与删除在同一事务里完成；
 * 业务表上不持有长锁，索引刷新/重建天然不阻塞业务写入。
 */
export async function processSearchChanges(pool: Pool, batchSize = 200): Promise<IndexStats> {
  const client = await pool.connect();
  const stats: IndexStats = { claimed: 0, upserted: 0, deleted: 0, missing: 0 };
  try {
    await client.query("BEGIN");
    const claimed = await client.query<Change>(
      `DELETE FROM search_index_changes
       WHERE id IN (
         SELECT id FROM search_index_changes
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       RETURNING id::text, doc_type AS "docType", doc_id::text AS "docId", op`,
      [batchSize]
    );
    stats.claimed = claimed.rowCount ?? 0;

    for (const docType of ["feature", "comment"] as const) {
      const changes = claimed.rows.filter((change) => change.docType === docType);
      const upsertIds = new Set(
        changes.filter((change) => change.op === "upsert").map((change) => change.docId)
      );
      const deleteIds = [
        ...new Set(
          changes
            .filter((change) => change.op === "delete" && !upsertIds.has(change.docId))
            .map((change) => change.docId)
        )
      ];

      if (upsertIds.size) {
        const rows = await loadIndexRows(client, docType, [...upsertIds]);
        const foundIds = new Set(rows.map((row) => row.doc_id));
        const missingIds = [...upsertIds].filter((id) => !foundIds.has(id));
        stats.missing += missingIds.length;

        if (rows.length) {
          await client.query(UPSERT_SQL, [JSON.stringify(rows)]);
          stats.upserted += rows.length;
        }
        // 源行已不存在（硬删）或已软删：清理可能残留的文档。
        if (missingIds.length) {
          await client.query(
            "DELETE FROM search_documents WHERE doc_type = $1 AND doc_id = ANY($2::uuid[])",
            [docType, missingIds]
          );
          stats.deleted += missingIds.length;
        }
      }

      if (deleteIds.length) {
        const result = await client.query(
          "DELETE FROM search_documents WHERE doc_type = $1 AND doc_id = ANY($2::uuid[])",
          [docType, deleteIds]
        );
        stats.deleted += result.rowCount ?? 0;
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return stats;
}

/** Worker 轮询调用：排空队列，返回本轮统计。 */
export async function drainSearchIndex(pool: Pool, maxBatches = 20, batchSize = 200): Promise<IndexStats> {
  const totals: IndexStats = { claimed: 0, upserted: 0, deleted: 0, missing: 0 };
  for (let index = 0; index < maxBatches; index++) {
    const stats = await processSearchChanges(pool, batchSize);
    totals.claimed += stats.claimed;
    totals.upserted += stats.upserted;
    totals.deleted += stats.deleted;
    totals.missing += stats.missing;
    if (stats.claimed < batchSize) break;
  }
  return totals;
}
