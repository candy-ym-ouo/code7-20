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
});

describe("search index migration", () => {
  const search = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../migrations/0003_search_index.sql"),
    "utf8"
  );

  it("creates the denormalized documents table, change queue and rebuild ledger", () => {
    for (const table of ["search_documents", "search_index_changes", "search_index_rebuilds"]) {
      expect(search).toContain(`CREATE TABLE ${table}`);
    }
  });

  it("enqueues changes from business tables through triggers without touching the document", () => {
    expect(search).toContain("CREATE TRIGGER search_feature_changed_trg");
    expect(search).toContain("CREATE TRIGGER search_comment_changed_trg");
    expect(search).toContain("CREATE TRIGGER search_revision_changed_trg");
    // 触发器只往轻量队列表写，文档构建留给 worker
    expect(search).toContain("INSERT INTO search_index_changes");
    expect(search).not.toContain("AFTER TRIGGER");
  });

  it("provides the online snapshot rebuild functions and advisory lock", () => {
    expect(search).toContain("FUNCTION search_start_rebuild()");
    expect(search).toContain("FUNCTION search_finish_rebuild(p_rebuild_id bigint)");
    // 重建之间互斥但不阻塞业务写入
    expect(search).toContain("pg_advisory_xact_lock");
  });

  it("builds Chinese token and tsquery helpers backed by pg_trgm", () => {
    expect(search).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    expect(search).toContain("FUNCTION search_cjk_tokens(p_text text)");
    expect(search).toContain("FUNCTION search_build_tsquery(p_query text)");
    expect(search).toContain("gin_trgm_ops");
  });
});
