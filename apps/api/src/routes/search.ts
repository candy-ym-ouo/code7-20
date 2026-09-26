import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeSearchQuery } from "@map/shared/pinyin";
import { query } from "../db";
import { AppError } from "../errors";
import { optionalAuth, requireAdmin } from "../auth";
import { bboxFromString } from "../geo";
import { enqueueSearchRebuild } from "../queue";
import {
  buildSearchQuery,
  decodeCursor,
  encodeCursor,
  searchFingerprint,
  type SearchParams,
  type SearchType,
  type SearchVisibility
} from "../search";

const searchQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  type: z.enum(["feature", "comment"]).optional(),
  category: z.string().max(200).optional(),
  tags: z.string().max(200).optional(),
  bbox: z.string().max(64).optional(),
  visibility: z.enum(["published", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(400).optional()
});

function splitCsv(value: string | undefined, max: number): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, max);
}

type SearchRow = {
  id: string;
  doc_type: SearchType;
  doc_id: string;
  feature_id: string;
  category_key: string;
  title_text: string;
  tags: string[];
  source_updated_at: Date;
  snippet: string;
  rank: number;
  category_name: string;
  category_icon: string;
  longitude: number;
  latitude: number;
  feature_status: string;
  comment_status: string | null;
  comment_created_at: Date | null;
  author_name: string | null;
  published_title: string | null;
};

function serializeRow(row: SearchRow) {
  return {
    type: row.doc_type,
    id: row.doc_id,
    featureId: row.feature_id,
    categoryKey: row.category_key,
    categoryName: row.category_name,
    categoryIcon: row.category_icon,
    title: row.doc_type === "comment" ? row.published_title : row.title_text,
    snippet: row.snippet,
    tags: row.tags,
    longitude: Number(row.longitude),
    latitude: Number(row.latitude),
    featureStatus: row.feature_status,
    ...(row.doc_type === "comment"
      ? { commentStatus: row.comment_status, authorName: row.author_name, commentedAt: row.comment_created_at }
      : {}),
    updatedAt: row.source_updated_at,
    rank: Number(row.rank)
  };
}

export async function searchRoutes(app: FastifyInstance) {
  app.get("/search", {
    preHandler: optionalAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request) => {
    const input = searchQuerySchema.parse(request.query);
    const visibility: SearchVisibility = input.visibility ?? "published";
    if (visibility === "all") {
      const role = request.user?.role;
      if (role !== "moderator" && role !== "admin") {
        throw new AppError(403, "FORBIDDEN", "Moderator permission required for visibility=all");
      }
    }

    const params: SearchParams = {
      q: normalizeSearchQuery(input.q ?? ""),
      types: input.type ? [input.type] : ["feature", "comment"],
      categories: splitCsv(input.category, 8),
      tags: splitCsv(input.tags, 8),
      bbox: input.bbox ? bboxFromString(input.bbox) : null,
      visibility,
      limit: input.limit
    };

    const fingerprint = searchFingerprint(params);
    const cursor = input.cursor ? decodeCursor(input.cursor, fingerprint) : null;
    const built = buildSearchQuery(params, cursor);
    const result = await query<SearchRow>(built.text, built.values);

    const hasMore = result.rows.length > params.limit;
    const items = result.rows.slice(0, params.limit);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor(
          built.mode === "rank"
            ? { m: "rank", k: [Number(last.rank), last.id] }
            : { m: "ts", k: [last.source_updated_at.toISOString(), last.id] },
          fingerprint
        )
      : null;

    return { items: items.map(serializeRow), nextCursor };
  });

  app.post("/admin/search/reindex", { preHandler: requireAdmin }, async (_request, reply) => {
    await enqueueSearchRebuild();
    return reply.code(202).send({ status: "scheduled" });
  });

  app.get("/admin/search/status", { preHandler: requireAdmin }, async () => {
    const [documents, sync] = await Promise.all([
      query(
        `SELECT doc_type, count(*)::int AS count, max(indexed_at) AS last_indexed_at
         FROM search_documents GROUP BY doc_type ORDER BY doc_type`
      ),
      query(
        `SELECT source, last_source_updated_at, last_doc_id, updated_at
         FROM search_sync_state ORDER BY source`
      )
    ]);
    return { documents: documents.rows, sync: sync.rows };
  });
}
