import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";

const redisOptions = { maxRetriesPerRequest: null } as const;
export const mediaRedis = new IORedis(config.REDIS_URL, redisOptions);
export const outboxRedis = new IORedis(config.REDIS_URL, redisOptions);
export const searchRedis = new IORedis(config.REDIS_URL, redisOptions);
mediaRedis.on("error", (error) => console.error({ error }, "media Redis connection error"));
outboxRedis.on("error", (error) => console.error({ error }, "outbox Redis connection error"));
searchRedis.on("error", (error) => console.error({ error }, "search Redis connection error"));

export const mediaQueue = new Queue("media", { connection: mediaRedis });
export const outboxQueue = new Queue("outbox", { connection: outboxRedis });
export const searchQueue = new Queue("search", { connection: searchRedis });

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Redis queue operation timed out after ${timeoutMs}ms`)), timeoutMs).unref();
    })
  ]);
}

export async function enqueueMediaProcessing(mediaId: string, jobId: string): Promise<void> {
  await withTimeout(
    mediaQueue.add("process", { mediaId }, {
      jobId,
      removeOnComplete: 1000,
      removeOnFail: 1000
    }),
    3_000
  );
}

export async function enqueueOutbox(eventId: string): Promise<void> {
  try {
    await withTimeout(
      outboxQueue.add("dispatch", { eventId }, { removeOnComplete: 1000, removeOnFail: 1000 }),
      3_000
    );
  } catch (error) {
    // The database outbox remains the source of truth. A worker maintenance tick retries pending rows.
    console.error({ eventId, error }, "failed to enqueue outbox event");
  }
}

/**
 * 触发一次全量索引重建。固定 jobId 让进行中的重建去重；
 * 重建本身在 worker 中分批执行，不阻塞内容写入。
 */
export async function enqueueSearchRebuild(): Promise<void> {
  await withTimeout(
    searchQueue.add("rebuild", {}, {
      jobId: "search-rebuild",
      removeOnComplete: true,
      removeOnFail: 100
    }),
    3_000
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.all([mediaQueue.close(), outboxQueue.close(), searchQueue.close()]);
  if (mediaRedis.status !== "end") mediaRedis.disconnect();
  if (outboxRedis.status !== "end") outboxRedis.disconnect();
  if (searchRedis.status !== "end") searchRedis.disconnect();
}
