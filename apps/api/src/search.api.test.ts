import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { processSearchChanges } from "@map/search";

const connectionString = process.env.SEARCH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

process.env.NODE_ENV ??= "test";
process.env.S3_ENDPOINT ??= "http://minio.example.test";
process.env.S3_PUBLIC_ENDPOINT ??= "http://minio.example.test";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test-secret";
process.env.S3_QUARANTINE_BUCKET ??= "quarantine";
process.env.S3_PUBLIC_BUCKET ??= "public";
process.env.PUBLIC_MEDIA_BASE_URL ??= "http://media.example.test";
process.env.JWT_ACCESS_SECRET ??= "test-secret-at-least-32-characters-long";

describeIfDb("GET /api/v1/search (HTTP)", () => {
  const pool = new pg.Pool({ connectionString, max: 4 });
  let app: Awaited<ReturnType<typeof import("./app").buildApp>>;
  let ownerToken = "";
  let adminToken = "";

  async function reset() {
    await pool.query(`
      TRUNCATE search_documents, search_index_changes, search_index_rebuilds,
                feature_confirmations, reports, moderation_actions,
                revision_media, media_assets, comments, feature_revisions,
                map_features, users, categories RESTART IDENTITY CASCADE
    `);
    await pool.query(
      `INSERT INTO categories(key, name, icon, detail_schema) VALUES
       ('bench','长椅','bench','{}'::jsonb),
       ('drinking_water','饮水处','water','{}'::jsonb)`
    );
  }

  async function makeUser(email: string, displayName: string, role: "contributor" | "admin" = "contributor") {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO users(email, email_normalized, password_hash, display_name, role, status, email_verified_at)
       VALUES ($1,$1,'x',$2,$3,'active', now()) RETURNING id`,
      [email, displayName, role]
    );
    return r.rows[0]!.id;
  }

  async function makeFeature(ownerId: string, status: string, title: string, description: string,
                              category = "bench", tags: string[] = []) {
    const f = await pool.query<{ id: string }>(
      `INSERT INTO map_features(category_key, owner_id, geom, location_accuracy_m, status, first_published_at)
       VALUES ($1,$2, ST_SetSRID(ST_MakePoint(116.4,39.9),4326)::geography, 10, $3::content_status,
               CASE WHEN $3='published' THEN now() ELSE NULL END) RETURNING id`,
      [category, ownerId, status]
    );
    const fid = f.rows[0]!.id;
    const rev = await pool.query<{ id: string }>(
      `INSERT INTO feature_revisions(feature_id, author_id, revision_no, payload, status)
       VALUES ($1,$2,1,$3::jsonb, $4) RETURNING id`,
      [fid, ownerId, JSON.stringify({ title, description, tags }),
       status === "published" ? "published" : "draft"]
    );
    await pool.query("UPDATE map_features SET current_revision_id=$2 WHERE id=$1", [fid, rev.rows[0]!.id]);
    return fid;
  }

  beforeAll(async () => {
    const [{ buildApp }, { signAccessToken }] = await Promise.all([import("./app"), import("./auth")]);
    app = await buildApp();
    await reset();

    const owner = await makeUser("owner@example.test", "作者甲");
    const admin = await makeUser("admin@example.test", "管理员", "admin");
    await makeFeature(owner, "published", "朝阳公园南侧长椅", "靠近南门，有靠背和遮阳棚，适合休息。", "bench", ["休息", "遮阳"]);
    await makeFeature(owner, "published", "绿色饮水处", "直饮水，水质干净。", "drinking_water", ["饮水"]);
    await makeFeature(owner, "draft", "未发布的草稿", "草稿内容。", "bench");
    await processSearchChanges(pool, 100);

    ownerToken = signAccessToken({ id: owner, email: "owner@example.test", displayName: "作者甲",
      role: "contributor", status: "active", emailVerified: true });
    adminToken = signAccessToken({ id: admin, email: "admin@example.test", displayName: "管理员",
      role: "admin", status: "active", emailVerified: true });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("returns public features for an anonymous caller", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/search?q=长椅" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ title: string }>; nextCursor: string | null }>();
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.title).toBe("朝阳公园南侧长椅");
  });

  it("matches pinyin queries", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/search?q=changyi" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items.length).toBe(1);
  });

  it("combines category and tag filters", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/search?category=bench&tag=遮阳" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: Array<{ categoryKey: string }> }>().items.length).toBe(1);

    const none = await app.inject({ method: "GET", url: "/api/v1/search?category=bench&tag=饮水" });
    expect(none.json<{ items: unknown[] }>().items.length).toBe(0);
  });

  it("hides drafts from anonymous but shows them to the owner", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/v1/search?q=草稿" });
    expect(anon.json<{ items: unknown[] }>().items.length).toBe(0);

    const ownerRes = await app.inject({
      method: "GET", url: "/api/v1/search?q=草稿",
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    expect(ownerRes.json<{ items: unknown[] }>().items.length).toBe(1);
  });

  it("walks stable cursor pages without duplicates", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const url = `/api/v1/search?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await app.inject({ method: "GET", url });
      const body = res.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
      for (const item of body.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    expect(seen.size).toBe(2); // 匿名只能看到 2 条已发布地点
  });

  it("rejects invalid query params with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/search?type=nope" });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe("VALIDATION_FAILED");
  });

  it("guards the rebuild endpoint", async () => {
    const anon = await app.inject({ method: "POST", url: "/api/v1/search/reindex" });
    expect(anon.statusCode).toBe(401);

    const forbidden = await app.inject({
      method: "POST", url: "/api/v1/search/reindex",
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST", url: "/api/v1/search/reindex",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ status: string }>().status).toBe("indexing");
  });
});
