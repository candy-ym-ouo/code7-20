import { createHash } from "node:crypto";
import { z } from "zod";
import {
  buildPrefixTsquery,
  classifyQuery,
  compactPinyinQuery,
  escapeIlikePattern,
  extractAsciiTerms
} from "@map/shared/pinyin";
import { AppError } from "./errors";
import { bboxCondition, type Bbox } from "./geo";

export type SearchType = "feature" | "comment";
export type SearchVisibility = "published" | "all";

export type SearchParams = {
  /** 已归一化（小写、压缩空白）的查询串，可为空串表示仅按筛选条件浏览。 */
  q: string;
  types: SearchType[];
  categories: string[];
  tags: string[];
  bbox: Bbox | null;
  visibility: SearchVisibility;
  limit: number;
};

export type SearchCursor = {
  m: "rank" | "ts";
  k: [number | string, string];
};

const cursorSchema = z.object({
  v: z.literal(1),
  m: z.enum(["rank", "ts"]),
  k: z.tuple([z.union([z.number(), z.string()]), z.string().uuid()]),
  h: z.string().min(8).max(32)
});

/** 查询条件指纹：换页游标与查询条件绑定，防止拿着旧游标翻不同查询的页。 */
export function searchFingerprint(params: SearchParams): string {
  const canonical = JSON.stringify({
    q: params.q,
    types: [...params.types].sort(),
    categories: [...params.categories].sort(),
    tags: [...params.tags].sort(),
    bbox: params.bbox,
    visibility: params.visibility
  });
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 16);
}

export function encodeCursor(cursor: SearchCursor, fingerprint: string): string {
  const payload = { v: 1 as const, m: cursor.m, k: cursor.k, h: fingerprint };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(raw: string, expectedFingerprint: string): SearchCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new AppError(400, "VALIDATION_FAILED", "Invalid pagination cursor");
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) throw new AppError(400, "VALIDATION_FAILED", "Invalid pagination cursor");
  if (result.data.h !== expectedFingerprint) {
    throw new AppError(400, "VALIDATION_FAILED", "Pagination cursor does not match the current query");
  }
  return { m: result.data.m, k: result.data.k };
}

export type BuiltSearchQuery = {
  text: string;
  values: unknown[];
  mode: "rank" | "ts";
};

/**
 * 拼装检索 SQL。权限过滤在这里（查询层）完成：
 *  - published：JOIN 回 map_features/comments 按当前 status 过滤，索引滞后不会泄露；
 *  - all（仅审核员）：仍排除已删除内容。
 * 分页为 keyset 游标：有查询词按 (rank, id)，无查询词按 (source_updated_at, id)，
 * 两者都是全序，翻页不受期间写入影响。
 */
export function buildSearchQuery(params: SearchParams, cursor: SearchCursor | null): BuiltSearchQuery {
  const values: unknown[] = [];
  const conditions: string[] = [];
  const push = (value: unknown): number => values.push(value);

  // ---- 权限过滤（查询层） ----
  if (params.visibility === "all") {
    conditions.push("mf.deleted_at IS NULL");
    conditions.push("(sd.doc_type = 'feature' OR cm.deleted_at IS NULL)");
  } else {
    conditions.push("mf.status = 'published'");
    conditions.push("mf.deleted_at IS NULL");
    conditions.push("(sd.doc_type = 'feature' OR (cm.status = 'published' AND cm.deleted_at IS NULL))");
  }

  // ---- 结构化筛选 ----
  if (params.types.length === 1) {
    conditions.push(`sd.doc_type = $${push(params.types[0])}`);
  }
  if (params.categories.length > 0) {
    conditions.push(`sd.category_key = ANY($${push(params.categories)}::text[])`);
  }
  if (params.tags.length > 0) {
    conditions.push(`sd.tags @> $${push(params.tags)}::text[]`);
  }
  if (params.bbox) {
    conditions.push(bboxCondition(params.bbox, values.length + 1));
    values.push(...params.bbox);
  }

  // ---- 全文条件与排序表达式 ----
  let rankExpr = "0::float8";
  let mode: "rank" | "ts" = "ts";
  if (params.q.length > 0) {
    mode = "rank";
    const kind = classifyQuery(params.q);
    const textConditions: string[] = [];
    const rankParts: string[] = [];

    if (kind === "ascii" || kind === "mixed") {
      const terms = extractAsciiTerms(params.q);
      const tsquery = buildPrefixTsquery(terms);
      const compact = compactPinyinQuery(params.q);
      if (tsquery) {
        const idx = push(tsquery);
        textConditions.push(`sd.tsv @@ to_tsquery('simple', $${idx})`);
        rankParts.push(`COALESCE(ts_rank_cd(sd.tsv, to_tsquery('simple', $${idx})), 0)::float8`);
      }
      if (compact.length > 0) {
        const likeIdx = push(`%${escapeIlikePattern(compact)}%`);
        const rawIdx = push(compact);
        textConditions.push(
          `(sd.pinyin_compact ILIKE $${likeIdx} ESCAPE '\\' OR sd.pinyin_initials ILIKE $${likeIdx} ESCAPE '\\')`
        );
        rankParts.push(`similarity(sd.pinyin_compact, $${rawIdx})::float8 * 0.7`);
        rankParts.push(`similarity(sd.pinyin_initials, $${rawIdx})::float8 * 0.5`);
      }
    }

    // 中文子串（以及 ascii 原文子串）走 search_text 三元组
    const rawLikeIdx = push(`%${escapeIlikePattern(params.q)}%`);
    const rawIdx = push(params.q);
    textConditions.push(`sd.search_text ILIKE $${rawLikeIdx} ESCAPE '\\'`);
    rankParts.push(`similarity(sd.search_text, $${rawIdx})::float8 * 0.8`);

    conditions.push(`(${textConditions.join(" OR ")})`);
    rankExpr = `GREATEST(${rankParts.join(", ")})`;
  }

  // ---- keyset 游标 ----
  if (cursor) {
    if (cursor.m === "rank") {
      const rankValue = Number(cursor.k[0]);
      if (!Number.isFinite(rankValue)) throw new AppError(400, "VALIDATION_FAILED", "Invalid pagination cursor");
      conditions.push(`((${rankExpr}), sd.id) < ($${push(rankValue)}::float8, $${push(cursor.k[1])}::uuid)`);
    } else {
      const ts = new Date(String(cursor.k[0]));
      if (Number.isNaN(ts.getTime())) throw new AppError(400, "VALIDATION_FAILED", "Invalid pagination cursor");
      conditions.push(`(sd.source_updated_at, sd.id) < ($${push(ts)}::timestamptz, $${push(cursor.k[1])}::uuid)`);
    }
  }

  const orderBy = mode === "rank"
    ? `(${rankExpr}) DESC, sd.id DESC`
    : "sd.source_updated_at DESC, sd.id DESC";
  const limitIdx = push(params.limit + 1);

  const text = `
    SELECT
      sd.id,
      sd.doc_type,
      sd.doc_id,
      sd.feature_id,
      sd.category_key,
      sd.title_text,
      sd.tags,
      sd.source_updated_at,
      left(sd.body_text, 180) AS snippet,
      (${rankExpr}) AS rank,
      cat.name AS category_name,
      cat.icon AS category_icon,
      ST_X(mf.geom::geometry) AS longitude,
      ST_Y(mf.geom::geometry) AS latitude,
      mf.status AS feature_status,
      cm.status AS comment_status,
      cm.created_at AS comment_created_at,
      author.display_name AS author_name,
      published_revision.payload->>'title' AS published_title
    FROM search_documents sd
    JOIN map_features mf ON mf.id = sd.feature_id
    JOIN categories cat ON cat.key = sd.category_key
    LEFT JOIN comments cm ON sd.doc_type = 'comment' AND cm.id = sd.doc_id
    LEFT JOIN users author ON author.id = cm.author_id
    LEFT JOIN feature_revisions published_revision ON published_revision.id = mf.current_revision_id
    WHERE ${conditions.join("\n      AND ")}
    ORDER BY ${orderBy}
    LIMIT $${limitIdx}`;

  return { text, values, mode };
}
