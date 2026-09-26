import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { processSearchChanges, rebuildSearchIndex, searchDocuments } from "../index.js";

// 需要真实 PostgreSQL/PostGIS；设置 SEARCH_TEST_DATABASE_URL（或 DATABASE_URL）
// 指向一个可任意清空的测试库后运行，否则整个用例组跳过。
const connectionString = process.env.SEARCH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb("search index integration", () => {
  const pool = new pg.Pool({ connectionString, max: 4 });

  async function reset() {
    await pool.query(`
      TRUNCATE search_documents, search_index_changes, search_index_rebuilds,
                feature_confirmations, reports, moderation_actions,
                revision_media, media_assets, comments, feature_revisions,
                map_features, users, categories RESTART IDENTITY CASCADE
    `);
    for (const [key, name, icon] of [
      ["bench", "长椅", "bench"],
      ["drinking_water", "饮水处", "water"],
      ["quiet_corner", "安静角落", "quiet"]
    ] as const) {
      await pool.query(
        `INSERT INTO categories(key, name, icon, detail_schema) VALUES ($1,$2,$3,'{}'::jsonb)`,
        [key, name, icon]
      );
    }
  }

  async function makeUser(email: string, role: "contributor" | "admin" = "contributor") {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO users(email, email_normalized, password_hash, display_name, role, status, email_verified_at)
       VALUES ($1,$1,'x',$2,$3,'active', now()) RETURNING id`,
      [email, role === "admin" ? "管理员" : email.split("@")[0], role]
    );
    return r.rows[0]!.id;
  }

  async function makeFeature(ownerId: string, opts: {
    status: string; title: string; description: string; category?: string; tags?: string[];
  }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const f = await client.query<{ id: string }>(
        `INSERT INTO map_features(category_key, owner_id, geom, location_accuracy_m, status, first_published_at)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint(116.4 + random()*0.01, 39.9 + random()*0.01),4326)::geography, 10,
                 $3::content_status, CASE WHEN $3='published' THEN now() ELSE NULL END)
         RETURNING id`,
        [opts.category ?? "bench", ownerId, opts.status]
      );
      const fid = f.rows[0]!.id;
      const rev = await client.query<{ id: string }>(
        `INSERT INTO feature_revisions(feature_id, author_id, revision_no, payload, status)
         VALUES ($1,$2,1,$3::jsonb, $4) RETURNING id`,
        [fid, ownerId, JSON.stringify({
          title: opts.title, description: opts.description, tags: opts.tags ?? []
        }), opts.status === "published" ? "published" : "draft"]
      );
      await client.query("UPDATE map_features SET current_revision_id = $2 WHERE id = $1", [fid, rev.rows[0]!.id]);
      await client.query("COMMIT");
      return fid;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function makeComment(authorId: string, featureId: string, body: string, status = "published") {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO comments(feature_id, author_id, body, status, reviewed_at)
       VALUES ($1,$2,$3,$4::comment_status, CASE WHEN $4='published' THEN now() ELSE NULL END) RETURNING id`,
      [featureId, authorId, body, status]
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    await reset();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("indexes writes asynchronously and keeps the change queue drained", async () => {
    const ownerA = await makeUser("zhangsan@example.test");
    const ownerB = await makeUser("lisi@example.test");

    const f1 = await makeFeature(ownerA, {
      status: "published",
      title: "朝阳公园南侧长椅",
      description: "靠近公园南门入口，有靠背和遮阳棚，适合休息。",
      tags: ["休息", "遮阳"]
    });
    await makeFeature(ownerB, {
      status: "published",
      title: "绿色饮水处",
      description: "直饮水 fountain，水质干净，旁边有遮雨棚。",
      category: "drinking_water",
      tags: ["饮水"]
    });
    await makeFeature(ownerA, {
      status: "draft",
      title: "我的草稿长椅",
      description: "尚未提交审核的内容。"
    });
    await makeFeature(ownerB, {
      status: "published",
      title: "河边安静角落",
      description: "可以看夜景的位置，灯光柔和。",
      category: "quiet_corner"
    });
    await makeComment(ownerB, f1, "这个长椅下午阳光很好，推荐。", "published");
    await makeComment(ownerA, f1, "水压有点低。", "pending");

    const queued = await pool.query("SELECT count(*)::int AS n FROM search_index_changes");
    expect(queued.rows[0]!.n).toBeGreaterThan(0);

    const stats = await processSearchChanges(pool, 100);
    expect(stats.claimed).toBe(6);
    expect(stats.upserted).toBe(6);
    const after = await pool.query("SELECT count(*)::int AS n FROM search_index_changes");
    expect(after.rows[0]!.n).toBe(0);
  });

  it("filters visibility at the query layer per principal", async () => {
    const anon = null;
    const count = (params: Parameters<typeof searchDocuments>[1]) =>
      searchDocuments(pool, params).then((r) => r.items.length);
    const ownerA = (await pool.query<{ id: string }>("SELECT id FROM users WHERE email=$1", ["zhangsan@example.test"])).rows[0]!.id;
    const ownerB = (await pool.query<{ id: string }>("SELECT id FROM users WHERE email=$1", ["lisi@example.test"])).rows[0]!.id;
    const modId = await makeUser("mod@example.test", "admin");
    const mod = { userId: modId, role: "admin" as const };
    const userA = { userId: ownerA, role: "contributor" as const };
    const userB = { userId: ownerB, role: "contributor" as const };

    // 匿名：3 个已发布地点 + 1 条已发布评论；草稿/pending 均不可见
    expect(await count({ principal: anon, limit: 50 })).toBe(4);
    expect(await count({ q: "草稿", principal: anon })).toBe(0);
    expect(await count({ q: "水压", principal: anon })).toBe(0);

    // 作者本人：能看到自己的草稿与自己的 pending 评论
    expect(await count({ principal: userA, limit: 50 })).toBe(6);
    expect(await count({ q: "草稿", principal: userA })).toBe(1);
    expect(await count({ q: "草稿", principal: userB })).toBe(0);
    expect(await count({ q: "水压", principal: userA })).toBe(1);

    // 管理员：可见全部未软删文档（含草稿、pending）
    expect(await count({ principal: mod, limit: 50 })).toBe(6);
    expect(await count({ q: "草稿", principal: mod })).toBe(1);
    expect(await count({ q: "水压", principal: mod })).toBe(1);
  });

  it("matches Chinese bigrams, latin, tags and combines terms with AND", async () => {
    const count = (q: string) =>
      searchDocuments(pool, { q, principal: null }).then((r) => r.items.length);
    expect(await count("长椅")).toBe(2); // 地点 + 其评论（评论继承地点标题）
    expect(await count("公园")).toBe(2);
    expect(await count("长椅 休息")).toBe(1); // 跨词 AND，不产生“椅休”
    expect(await count("不存在")).toBe(0);
    expect(await count("遮阳")).toBe(1);
  });

  it("matches full pinyin, compact pinyin and initials", async () => {
    const count = (q: string) =>
      searchDocuments(pool, { q, principal: null }).then((r) => r.items.length);
    expect(await count("changyi")).toBe(2);
    expect(await count("chang yi")).toBe(2);
    expect(await count("cygy")).toBe(1);
    expect(await count("ls")).toBe(1); // 绿色 -> lv se, 首字母 ls
    expect(await count("lvse")).toBe(1);
  });

  it("escapes ILIKE wildcards in pinyin matching", async () => {
    // 一个 % 不能命中全部；下划线/反斜杠按字面处理。
    const count = (q: string) =>
      searchDocuments(pool, { q, principal: null }).then((r) => r.items.length);
    expect(await count("%")).toBe(0);
    expect(await count("_")).toBe(0);
    expect(await count("ch_ngyi")).toBe(0);
  });

  it("filters by category, tags and doc type", async () => {
    const count = (params: Parameters<typeof searchDocuments>[1]) =>
      searchDocuments(pool, { principal: null, limit: 50, ...params }).then((r) => r.items.length);
    expect(await count({ categories: ["bench"] })).toBe(1);
    expect(await count({ categories: ["drinking_water"] })).toBe(1);
    expect(await count({ tags: ["饮水"] })).toBe(1);
    expect(await count({ type: "feature" })).toBe(3);
    expect(await count({ type: "comment" })).toBe(1);
  });

  it("paginates with stable keyset cursors under both sort modes", async () => {
    const principal = null;
    for (const sort of ["newest", "relevance"] as const) {
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page = await searchDocuments(pool, { sort, limit: 2, ...(cursor ? { cursor } : {}), principal });
        for (const item of page.items) {
          const key = `${item.type}:${item.id}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
        pages += 1;
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        if (pages > 10) throw new Error("pagination did not terminate");
      }
      expect(seen.size).toBe(4);
    }
  });

  it("rebuilds online without blocking concurrent writes", async () => {    const ownerA = (await pool.query<{ id: string }>("SELECT id FROM users WHERE email=$1", ["zhangsan@example.test"])).rows[0]!.id;
    await makeFeature(ownerA, {
      status: "published",
      title: "测试重建期间的新地点",
      description: "重建进行中写入的内容。"
    });
    const result = await rebuildSearchIndex(pool);
    expect(result.status).toBe("completed");

    const hits = await searchDocuments(pool, { q: "重建期间", principal: null });
    expect(hits.items).toHaveLength(1);

    // 软删后文档应从索引中移除
    const target = (await pool.query<{ id: string }>(
      "SELECT id FROM map_features WHERE current_revision_id IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"
    )).rows[0]!.id;
    await pool.query("UPDATE map_features SET deleted_at = now(), status='deleted' WHERE id=$1", [target]);
    await processSearchChanges(pool, 10);
    const stillThere = await pool.query(
      "SELECT 1 FROM search_documents WHERE doc_type='feature' AND doc_id=$1",
      [target]
    );
    expect(stillThere.rowCount).toBe(0);
  });

  it("does not block business writes while the worker drains changes", async () => {
    const owner = await makeUser("writer@example.test");
    // 先制造一大批积压变更，模拟“正在重建/大量追平”。
    for (let index = 0; index < 40; index += 1) {
      await makeFeature(owner, {
        status: "published",
        title: `并发地点${index}`,
        description: `并发描述内容 ${index} 号。`
      });
    }

    // 在 Worker 认领并处理变更的同时，新的业务写入必须立刻成功。
    const writer = pool.connect();
    const drainer = processSearchChanges(pool, 30);
    const beforeWrite = Date.now();
    const concurrent = await writer.then(async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO map_features(category_key, owner_id, geom, location_accuracy_m, status, first_published_at)
         VALUES ('bench',$1, ST_SetSRID(ST_MakePoint(116.4,39.9),4326)::geography, 10,
                 'published'::content_status, now()) RETURNING id`,
        [owner]
      );
      return { client, id: r.rows[0]!.id, elapsedMs: Date.now() - beforeWrite };
    });
    await drainer;
    (await writer).release();

    // 写入立即完成（<2s 是非常宽松的上界，重点是没有被重建事务长时间锁住）。
    expect(concurrent.id).toBeTruthy();
    expect(concurrent.elapsedMs).toBeLessThan(2000);

    // 新写入产生的变更随后也被排空，文档可搜。
    await processSearchChanges(pool, 100);
    const hits = await searchDocuments(pool, { q: "并发地点39", principal: null });
    expect(hits.items.length).toBe(1);
  });

  it("coalesces repeated changes for the same document in the queue", async () => {
    const owner = await makeUser("coalesce@example.test");
    const fid = await makeFeature(owner, { status: "published", title: "合并测试", description: "初始描述内容。" });
    // 在 worker 处理前连续更新多次，队列里同一文档应只有一条待处理变更。
    for (const text of ["改一", "改二", "改三"]) {
      await pool.query(
        `UPDATE feature_revisions SET payload = jsonb_set(payload, '{description}', to_jsonb($2::text))
         WHERE feature_id = $1`,
        [fid, `描述${text}内容。`]
      );
    }
    const pending = await pool.query(
      "SELECT count(*)::int AS n FROM search_index_changes WHERE doc_type='feature' AND doc_id=$1",
      [fid]
    );
    expect(pending.rows[0]!.n).toBe(1);
  });

  it("tracks the draft→pending→published→hidden→deleted lifecycle", async () => {
    const owner = await makeUser("lifecycle@example.test");
    const author = { userId: owner, role: "contributor" as const };

    // 真实流程：建草稿时 current_revision_id 为空，批准时才指向已发布修订。
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO map_features(category_key, owner_id, geom, location_accuracy_m, status)
       VALUES ('bench',$1,ST_SetSRID(ST_MakePoint(116.4,39.9),4326)::geography,5,'draft'::content_status)
       RETURNING id`,
      [owner]
    );
    const fid = inserted.rows[0]!.id;
    const rev = await pool.query<{ id: string }>(
      `INSERT INTO feature_revisions(feature_id, author_id, revision_no, payload, status)
       VALUES ($1,$2,1,$3::jsonb,'draft') RETURNING id`,
      [fid, owner, JSON.stringify({ title: "生命周期测试长椅", description: "完整状态流转的描述。", tags: ["流转"] })]
    );
    const rid = rev.rows[0]!.id;

    const drain = () => processSearchChanges(pool, 100);
    const hits = (principal: typeof author | null) =>
      searchDocuments(pool, { q: "生命周期", principal }).then((r) => r.items.length);
    const indexed = () => pool.query("SELECT count(*)::int n FROM search_documents WHERE doc_id=$1", [fid]);

    // 草稿：作者可搜，匿名不可
    await drain();
    expect((await indexed()).rows[0]!.n).toBe(1);
    expect(await hits(null)).toBe(0);
    expect(await hits(author)).toBe(1);

    // 提交待审：仍只有作者可见
    await pool.query("UPDATE feature_revisions SET status='pending',submitted_at=now() WHERE id=$1", [rid]);
    await pool.query("UPDATE map_features SET status='pending' WHERE id=$1", [fid]);
    await drain();
    expect(await hits(null)).toBe(0);
    expect(await hits(author)).toBe(1);

    // 批准：current_revision_id 指向已发布修订，所有人可见
    await pool.query("UPDATE feature_revisions SET status='published',reviewed_at=now() WHERE id=$1", [rid]);
    await pool.query(
      `UPDATE map_features SET status='published', current_revision_id=$2,
              first_published_at=now(), updated_at=now() WHERE id=$1`,
      [fid, rid]
    );
    await drain();
    expect(await hits(null)).toBe(1);

    // 待审新修订期间，公开索引仍指向旧批准版本（此处旧版标题不变）
    const rev2 = await pool.query<{ id: string }>(
      `INSERT INTO feature_revisions(feature_id, author_id, revision_no, payload, status)
       VALUES ($1,$2,2,$3::jsonb,'pending') RETURNING id`,
      [fid, owner, JSON.stringify({ title: "修订后新标题", description: "等待审核不应公开。", tags: [] })]
    );
    await drain();
    expect(
      (await searchDocuments(pool, { q: "修订后新标题", principal: null })).items.length
    ).toBe(0);

    // 隐藏：仅作者
    await pool.query("UPDATE map_features SET status='hidden',updated_at=now() WHERE id=$1", [fid]);
    await drain();
    expect(await hits(null)).toBe(0);
    expect(await hits(author)).toBe(1);

    // 软删：文档移除
    await pool.query("UPDATE map_features SET status='deleted',deleted_at=now() WHERE id=$1", [fid]);
    await drain();
    expect((await indexed()).rows[0]!.n).toBe(0);
    expect(rev2.rows[0]!.id).toBeDefined();
  });
});
