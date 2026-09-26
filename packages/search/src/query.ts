import type { Pool, QueryResultRow } from "pg";
import { decodeCursor, encodeCursor, type SearchCursor, type SearchSortMode } from "./cursor";

export type SearchDocType = "feature" | "comment";
export type SearchPrincipal = {
  userId: string;
  role: "contributor" | "moderator" | "admin";
} | null;

export type SearchParams = {
  /** 搜索词：中文单字/双字、拉丁词、全拼/紧凑全拼/首字母，词项之间为 AND */
  q?: string;
  /** 限定文档类型；缺省同时搜索地点与评论 */
  type?: SearchDocType;
  /** 分类 key，仅对地点生效（评论继承所属地点分类） */
  categories?: string[];
  /** 标签交集过滤 */
  tags?: string[];
  sort?: SearchSortMode;
  limit?: number;
  cursor?: string;
  principal?: SearchPrincipal;
};

export type SearchResultItem = {
  type: SearchDocType;
  id: string;
  featureId: string;
  status: string;
  categoryKey: string | null;
  title: string;
  body: string;
  authorName: string;
  ownerId: string;
  tags: string[];
  longitude: number | null;
  latitude: number | null;
  sortAt: string;
  score: number;
};

export type SearchResponse = {
  items: SearchResultItem[];
  nextCursor: string | null;
};

type Row = QueryResultRow;

/**
 * 可见性完全在查询层按调用者身份推导，索引表不承担权限决策：
 *  - published 对所有人可见；
 *  - 非 published 文档仅作者本人或审核员/管理员可见；
 *  - 评论额外要求所属地点当前为 published，且地点未软删；
 *  - 地点/评论软删后任何人都查不到（与 REST 详情接口一致）。
 *
 * 权限判断一律 JOIN 权威表（map_features/comments），不依赖索引里
 * 可能滞后的 status 快照。
 */
function buildVisibility(type: "feature" | "comment", principal: SearchPrincipal, ownerParam: string): string {
  // feature 自连接别名 mfv；comment 行的所属地点连接别名 mfv2、作者连接 cv。
  if (type === "feature") {
    const staff = principal?.role === "moderator" || principal?.role === "admin";
    if (staff) return "mfv.deleted_at IS NULL";
    if (principal) {
      return `(mfv.deleted_at IS NULL AND (d.status = 'published' OR mfv.owner_id = ${ownerParam}))`;
    }
    return "(mfv.deleted_at IS NULL AND d.status = 'published')";
  }
  const staff = principal?.role === "moderator" || principal?.role === "admin";
  if (staff) return "(mfv2.status = 'published' AND mfv2.deleted_at IS NULL)";
  if (principal) {
    return `(mfv2.status = 'published' AND mfv2.deleted_at IS NULL
             AND (d.status = 'published' OR cv.author_id = ${ownerParam}))`;
  }
  return "(mfv2.status = 'published' AND mfv2.deleted_at IS NULL AND d.status = 'published')";
}

const MAX_LIMIT = 50;

export async function searchDocuments(pool: Pool, params: SearchParams): Promise<SearchResponse> {
  const sort: SearchSortMode = params.sort === "newest" ? "newest" : "relevance";
  const limit = Math.min(Math.max(params.limit ?? 20, 1), MAX_LIMIT);
  const q = params.q?.trim().slice(0, 100) ?? "";
  const tags = params.tags?.map((tag) => tag.trim()).filter(Boolean).slice(0, 8) ?? [];
  const categories = params.categories?.map((value) => value.trim()).filter(Boolean).slice(0, 10) ?? [];
  const includeFeatures = !params.type || params.type === "feature";
  const includeComments = !params.type || params.type === "comment";
  const principal = params.principal ?? null;

  const cursor = params.cursor ? decodeCursor(params.cursor, sort) : null;
  if (params.cursor && !cursor) {
    return { items: [], nextCursor: null };
  }

  const values: unknown[] = [];
  const addValue = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  const where: string[] = [];
  const keysetWhere: string[] = [];

  if (params.type === "feature" || params.type === "comment") {
    where.push(`d.doc_type = ${addValue(params.type)}`);
  }

  if (categories.length) {
    where.push(`d.category_key = ANY(${addValue(categories)}::text[])`);
  }
  if (tags.length) {
    where.push(`d.tags @> ${addValue(tags)}::text[]`);
  }

  if (q) {
    const qParam = addValue(q);
    // ILIKE 的用户输入必须转义 %/_ 通配符，避免一个 % 命中全部。
    const likeParam = addValue(q.replace(/[\\%_]/g, "\\$&"));
    // 中文/拉丁全文 AND、紧凑全拼包含、首字母前缀，任一命中即可。
    where.push(`(
      d.search_vector @@ search_build_tsquery(${qParam})
      OR d.pinyin_compact ILIKE '%' || ${likeParam} || '%' ESCAPE '\\'
      OR d.pinyin_initials ILIKE ${likeParam} || '%' ESCAPE '\\'
    )`);
  }

  const visibilityParts: string[] = [];
  // 仅非特权登录用户需要按作者 id 过滤；绑定的参数必须真的出现在 SQL 里，
  // 否则 PostgreSQL 无法推断参数类型。
  const ownerParam = principal && principal.role !== "moderator" && principal.role !== "admin"
    ? addValue(principal.userId)
    : "";
  if (includeFeatures) {
    visibilityParts.push(`(d.doc_type = 'feature' AND ${buildVisibility("feature", principal, ownerParam)})`);
  }
  if (includeComments) {
    visibilityParts.push(`(d.doc_type = 'comment' AND ${buildVisibility("comment", principal, ownerParam)})`);
  }
  where.push(`(${visibilityParts.join(" OR ")})`);

  const scoreExpression = q
    ? `(
        COALESCE(ts_rank(visible.search_vector, search_build_tsquery(${addValue(q)})), 0)::double precision
        + COALESCE(word_similarity(${addValue(q)}, visible.pinyin_compact), 0)::double precision * 0.5
      )`
    : "0::double precision";

  // 键集分页：严格落后于上一页最后一行
  if (cursor) {
    const atParam = addValue(cursor.sortAt);
    const typeParam = addValue(cursor.docType);
    const idParam = addValue(cursor.docId);
    if (sort === "relevance") {
      const scoreParam = addValue(cursor.score!);
      keysetWhere.push(`(
        score < ${scoreParam}::double precision
        OR (score = ${scoreParam}::double precision
            AND (sort_at < ${atParam}::timestamptz
                 OR (sort_at = ${atParam}::timestamptz
                     AND (type, id) < (${typeParam}, ${idParam}::uuid))))
      )`);
    } else {
      keysetWhere.push(`(
        sort_at < ${atParam}::timestamptz
        OR (sort_at = ${atParam}::timestamptz
            AND (type, id) < (${typeParam}, ${idParam}::uuid))
      )`);
    }
  }

  const orderBy =
    sort === "relevance"
      ? "d.score DESC, d.sort_at DESC, d.type DESC, d.id DESC"
      : "d.sort_at DESC, d.type DESC, d.id DESC";

  const sql = `
    WITH visible AS (
      SELECT
        d.doc_type AS type,
        d.doc_id AS id,
        d.feature_id,
        d.owner_id,
        d.status,
        d.category_key,
        d.title,
        d.body,
        d.author_name,
        d.tags,
        d.longitude,
        d.latitude,
        d.sort_at,
        d.search_vector,
        d.pinyin_compact
      FROM search_documents d
      LEFT JOIN map_features mfv ON mfv.id = d.doc_id AND d.doc_type = 'feature'
      LEFT JOIN comments cv ON cv.id = d.doc_id AND d.doc_type = 'comment'
      LEFT JOIN map_features mfv2 ON mfv2.id = d.feature_id AND d.doc_type = 'comment'
      WHERE ${where.join(" AND ")}
    ),
    scored AS (
      SELECT visible.*,
             ${scoreExpression} AS score,
             CASE WHEN visible.type = 'comment' THEN
               COALESCE(fr_title.payload->>'title', '')
             ELSE visible.title END AS resolved_title
      FROM visible
      LEFT JOIN map_features mft ON mft.id = visible.feature_id AND visible.type = 'comment'
      LEFT JOIN feature_revisions fr_title ON fr_title.id = mft.current_revision_id
    )
    SELECT * FROM scored d
    ${keysetWhere.length ? `WHERE ${keysetWhere.join(" AND ")}` : ""}
    ORDER BY ${orderBy}
    LIMIT ${addValue(limit + 1)}::integer
  `;

  const result = await pool.query<Row>(sql, values);
  const rows = result.rows;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]!;
    const cursorPayload: SearchCursor = {
      sort,
      sortAt: new Date(last.sort_at).toISOString(),
      docType: last.type,
      docId: last.id,
      ...(sort === "relevance" ? { score: Number(last.score) } : {})
    };
    nextCursor = encodeCursor(cursorPayload);
  }

  return {
    items: page.map((row) => ({
      type: row.type,
      id: row.id,
      featureId: row.feature_id,
      status: row.status,
      categoryKey: row.category_key,
      title: row.resolved_title ?? row.title,
      body: row.body,
      authorName: row.author_name,
      ownerId: row.owner_id,
      tags: row.tags,
      longitude: row.longitude === null ? null : Number(row.longitude),
      latitude: row.latitude === null ? null : Number(row.latitude),
      sortAt: new Date(row.sort_at).toISOString(),
      score: Number(row.score)
    })),
    nextCursor
  };
}
