import type { Pool } from "pg";
import { drainSearchIndex } from "./indexer";

export type RebuildResult = {
  rebuildId: string;
  status: "completed" | "indexing";
};

/**
 * 启动一次全量重建：
 * 1. 对全部地点与评论做快照并入变更队列（与触发器共用同一个轻量队列表）；
 * 2. 调用方排空队列，期间业务写入产生的变更照常由触发器入队并被处理；
 * 3. 追平后调用 search_finish_rebuild 清理孤儿文档。
 *
 * 全程不锁业务表、不需要停写。
 */
export async function rebuildSearchIndex(pool: Pool, options?: { maxBatches?: number }): Promise<RebuildResult> {
  const started = await pool.query<{ id: string }>("SELECT search_start_rebuild() AS id");
  const rebuildId = started.rows[0]!.id;

  await drainSearchIndex(pool, options?.maxBatches ?? 500, 200);

  const finished = await pool.query<{ search_finish_rebuild: string }>(
    "SELECT search_finish_rebuild($1::bigint) AS search_finish_rebuild",
    [rebuildId]
  );
  const status = finished.rows[0]!.search_finish_rebuild;
  return {
    rebuildId,
    status: status === "completed" ? "completed" : "indexing"
  };
}

/** Worker 周期性调用：完成处于 indexing 状态的重建（数据量很大时用于追平+清理）。 */
export async function settleRebuilds(pool: Pool): Promise<string[]> {
  const pending = await pool.query<{ id: string }>(
    "SELECT id FROM search_index_rebuilds WHERE status = 'indexing' ORDER BY id"
  );
  const settled: string[] = [];
  for (const row of pending.rows) {
    await drainSearchIndex(pool, 50, 200);
    const result = await pool.query<{ search_finish_rebuild: string }>(
      "SELECT search_finish_rebuild($1::bigint) AS search_finish_rebuild",
      [row.id]
    );
    if (result.rows[0]!.search_finish_rebuild === "completed") settled.push(row.id);
  }
  return settled;
}
