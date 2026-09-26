import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

dotenv.config({ path: process.env.ENV_FILE || join(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

import { rebuildSearchIndex } from "@map/search";
import { pool } from "./db";

async function main() {
  console.log("starting online search index rebuild (writes are not blocked)…");
  const result = await rebuildSearchIndex(pool);
  console.log(`rebuild ${result.rebuildId}: ${result.status}`);
  if (result.status !== "completed") {
    console.log("large rebuild is still settling; the worker will finish it in the background");
  }
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
