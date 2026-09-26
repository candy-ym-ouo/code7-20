import { drainSearchIndex, settleRebuilds } from "@map/search";
import { pool } from "./db";

/**
 * 周期性排空搜索变更队列并推进在线重建。
 *
 * 触发器在业务事务内只往 search_index_changes 追加一行轻量变更，
 * 真正的文档构建（连表、拼音、分词）都在这里异步完成；
 * 因此业务写入路径上没有额外的重建开销，也不会被索引刷新阻塞。
 */
export async function syncSearchIndex(): Promise<void> {
  const stats = await drainSearchIndex(pool, 50, 200);
  if (stats.claimed > 0) {
    console.info(
      { stats },
      "search index drained"
    );
  }

  const settled = await settleRebuilds(pool);
  for (const rebuildId of settled) {
    console.info({ rebuildId }, "search index rebuild completed");
  }
}
