import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../migrations/0001_init.sql"),
  "utf8"
);

describe("initial migration", () => {
  it("contains the core audited entities", () => {
    for (const table of [
      "users", "sessions", "auth_tokens", "categories", "map_features",
      "feature_revisions", "media_assets", "comments", "reports",
      "moderation_actions", "outbox_events", "audit_logs", "notifications"
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
  });

  it("adds public thumbnail and outbox recovery fields in migration 0002", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0002_media_public_thumb.sql"),
      "utf8"
    );
    expect(followup).toContain("public_thumbnail_object_key");
    expect(followup).toContain("updated_at timestamptz");
  });

  it("uses PostGIS geography points and spatial indexes", () => {
    expect(migration).toContain("geography(Point, 4326)");
    expect(migration).toContain("USING gist (geom)");
  });

  it("adds the search document store in migration 0003", () => {
    const search = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0003_search_documents.sql"),
      "utf8"
    );
    expect(search).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    expect(search).toContain("CREATE TABLE search_documents");
    expect(search).toContain("CREATE TABLE search_sync_state");
    // 拼音与中文子串依赖三元组索引
    expect(search).toContain("gin_trgm_ops");
    // 索引表不建外键，避免索引维护阻塞内容写入
    expect(search).not.toContain("REFERENCES");
  });
});
