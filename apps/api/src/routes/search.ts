import type { FastifyInstance } from "fastify";
import { searchQuerySchema, splitCsv } from "@map/shared/contracts";
import { searchDocuments } from "@map/search";
import { pool } from "../db";
import { optionalAuth, requireAdmin } from "../auth";

export async function searchRoutes(app: FastifyInstance) {
  // 全文检索：中文（单字/相邻双字）、拼音（全拼/紧凑/首字母）、标签与分类可组合。
  // 权限过滤完全在查询层根据调用者身份完成，索引本身不做权限决策。
  app.get("/search", { preHandler: optionalAuth }, async (request) => {
    const input = searchQuerySchema.parse(request.query);

    const result = await searchDocuments(pool, {
      ...(input.q ? { q: input.q } : {}),
      ...(input.type ? { type: input.type } : {}),
      categories: splitCsv(input.category, 10),
      tags: splitCsv(input.tag, 8),
      sort: input.sort,
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      principal: request.user
        ? { userId: request.user.id, role: request.user.role }
        : null
    });

    return {
      items: result.items.map((item) => ({
        type: item.type,
        id: item.id,
        featureId: item.featureId,
        status: item.status,
        categoryKey: item.categoryKey,
        title: item.title,
        snippet: item.body.length > 200 ? `${item.body.slice(0, 200)}…` : item.body,
        body: item.type === "comment" ? item.body : undefined,
        authorName: item.authorName,
        tags: item.tags,
        longitude: item.longitude,
        latitude: item.latitude,
        sortAt: item.sortAt
      })),
      nextCursor: result.nextCursor
    };
  });

  // 触发一次全量在线重建。只做快照入队，实际刷新与孤儿清理由 Worker 完成，
  // 因此不阻塞业务写入。重建状态通过 GET 查询。
  app.post("/search/reindex", { preHandler: requireAdmin }, async () => {
    const started = await pool.query<{ id: string }>("SELECT search_start_rebuild() AS id");
    return { rebuildId: started.rows[0]!.id, status: "indexing" };
  });

  app.get("/search/reindex", { preHandler: requireAdmin }, async () => {
    const result = await pool.query<{
      id: string;
      status: string;
      queued_count: number;
      started_at: Date;
      completed_at: Date | null;
      pending_changes: number;
    }>(
      `SELECT r.id, r.status, r.queued_count, r.started_at, r.completed_at,
              (SELECT count(*)::int FROM search_index_changes) AS pending_changes
       FROM search_index_rebuilds r
       ORDER BY r.id DESC
       LIMIT 10`
    );
    return {
      rebuilds: result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        queuedCount: row.queued_count,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        pendingChanges: row.pending_changes
      }))
    };
  });
}
