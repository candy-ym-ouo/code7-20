import { describe, expect, it } from "vitest";
import {
  buildSearchQuery,
  decodeCursor,
  encodeCursor,
  searchFingerprint,
  type SearchParams
} from "./search";

function params(overrides: Partial<SearchParams> = {}): SearchParams {
  return {
    q: "",
    types: ["feature", "comment"],
    categories: [],
    tags: [],
    bbox: null,
    visibility: "published",
    limit: 20,
    ...overrides
  };
}

describe("search cursor", () => {
  it("round-trips rank and timestamp cursors", () => {
    const fingerprint = searchFingerprint(params());
    const rankCursor = encodeCursor({ m: "rank", k: [0.42, "7c9e6679-7425-40de-944b-e07fc1f90ae7"] }, fingerprint);
    expect(decodeCursor(rankCursor, fingerprint)).toEqual({
      m: "rank",
      k: [0.42, "7c9e6679-7425-40de-944b-e07fc1f90ae7"]
    });
    const tsCursor = encodeCursor({ m: "ts", k: ["2026-09-26T01:00:00.000Z", "7c9e6679-7425-40de-944b-e07fc1f90ae7"] }, fingerprint);
    expect(decodeCursor(tsCursor, fingerprint).m).toBe("ts");
  });

  it("rejects malformed cursors and query mismatches", () => {
    const fingerprint = searchFingerprint(params());
    expect(() => decodeCursor("not-a-cursor", fingerprint)).toThrowError(/cursor/i);
    const cursor = encodeCursor({ m: "rank", k: [1, "7c9e6679-7425-40de-944b-e07fc1f90ae7"] }, fingerprint);
    const otherFingerprint = searchFingerprint(params({ q: "长椅" }));
    expect(() => decodeCursor(cursor, otherFingerprint)).toThrowError(/does not match/);
  });

  it("changes fingerprint when filters change", () => {
    const base = searchFingerprint(params());
    expect(searchFingerprint(params({ tags: ["安静"] }))).not.toBe(base);
    expect(searchFingerprint(params({ visibility: "all" }))).not.toBe(base);
    expect(searchFingerprint(params({ categories: ["bench"] }))).not.toBe(base);
  });
});

describe("buildSearchQuery", () => {
  it("applies published visibility filters at the query layer", () => {
    const built = buildSearchQuery(params(), null);
    expect(built.text).toContain("mf.status = 'published'");
    expect(built.text).toContain("cm.status = 'published'");
    expect(built.text).toContain("mf.deleted_at IS NULL");
    expect(built.mode).toBe("ts");
    expect(built.text).toContain("sd.source_updated_at DESC, sd.id DESC");
  });

  it("relaxes visibility for moderators but still excludes deleted content", () => {
    const built = buildSearchQuery(params({ visibility: "all" }), null);
    expect(built.text).not.toContain("mf.status = 'published'");
    expect(built.text).toContain("mf.deleted_at IS NULL");
    expect(built.text).toContain("cm.deleted_at IS NULL");
  });

  it("combines pinyin, trigram and tsvector matching for ascii queries", () => {
    const built = buildSearchQuery(params({ q: "changyi" }), null);
    expect(built.text).toContain("sd.pinyin_compact ILIKE");
    expect(built.text).toContain("sd.pinyin_initials ILIKE");
    expect(built.text).toContain("to_tsquery('simple',");
    expect(built.text).toContain("sd.search_text ILIKE");
    expect(built.text).toContain("ts_rank_cd");
    expect(built.mode).toBe("rank");
    expect(built.values).toContain("changyi:*");
    expect(built.values).toContain("%changyi%");
  });

  it("uses trigram substring matching for Chinese queries", () => {
    const built = buildSearchQuery(params({ q: "长椅" }), null);
    expect(built.text).toContain("sd.search_text ILIKE");
    expect(built.text).not.toContain("pinyin_compact ILIKE");
    expect(built.values).toContain("%长椅%");
    expect(built.values).toContain("长椅");
  });

  it("escapes ILIKE wildcards in user input", () => {
    const built = buildSearchQuery(params({ q: "50% 长椅" }), null);
    expect(built.values).toContain("%50\\% 长椅%");
  });

  it("combines category, tag, type and bbox filters", () => {
    const built = buildSearchQuery(
      params({
        types: ["feature"],
        categories: ["bench", "quiet_corner"],
        tags: ["安静", "有靠背"],
        bbox: [116.3, 39.8, 116.5, 40.0]
      }),
      null
    );
    expect(built.text).toContain("sd.doc_type = $");
    expect(built.text).toContain("sd.category_key = ANY(");
    expect(built.text).toContain("sd.tags @>");
    expect(built.text).toContain("ST_Intersects");
    expect(built.values).toEqual(
      expect.arrayContaining(["feature", ["bench", "quiet_corner"], ["安静", "有靠背"], 116.3, 39.8, 116.5, 40.0])
    );
  });

  it("applies keyset cursor conditions for both sort modes", () => {
    const fingerprintRank = searchFingerprint(params({ q: "长椅" }));
    const rankCursor = decodeCursor(
      encodeCursor({ m: "rank", k: [0.5, "7c9e6679-7425-40de-944b-e07fc1f90ae7"] }, fingerprintRank),
      fingerprintRank
    );
    const ranked = buildSearchQuery(params({ q: "长椅" }), rankCursor);
    expect(ranked.text).toContain("< (");
    expect(ranked.values).toContain(0.5);

    const fingerprintTs = searchFingerprint(params());
    const tsCursor = decodeCursor(
      encodeCursor({ m: "ts", k: ["2026-09-26T01:00:00.000Z", "7c9e6679-7425-40de-944b-e07fc1f90ae7"] }, fingerprintTs),
      fingerprintTs
    );
    const browsed = buildSearchQuery(params(), tsCursor);
    expect(browsed.text).toContain("(sd.source_updated_at, sd.id) < (");
  });

  it("rejects cursors with invalid sort keys", () => {
    const fingerprint = searchFingerprint(params({ q: "长椅" }));
    const cursor = decodeCursor(
      encodeCursor({ m: "rank", k: ["not-a-number", "7c9e6679-7425-40de-944b-e07fc1f90ae7"] }, fingerprint),
      fingerprint
    );
    expect(() => buildSearchQuery(params({ q: "长椅" }), cursor)).toThrowError(/cursor/i);
  });

  it("fetches limit + 1 rows to detect the next page", () => {
    const built = buildSearchQuery(params({ limit: 10 }), null);
    expect(built.values[built.values.length - 1]).toBe(11);
  });
});
