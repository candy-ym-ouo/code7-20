import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../cursor";

const base = {
  sort: "relevance" as const,
  sortAt: "2026-09-26T01:00:00.000Z",
  docType: "feature",
  docId: "00000000-0000-4000-8000-000000000001",
  score: 1.25
};

describe("search cursor", () => {
  it("round trips an opaque cursor", () => {
    const encoded = encodeCursor(base);
    expect(encoded).not.toContain("feature");
    expect(decodeCursor(encoded, "relevance")).toEqual(base);
  });

  it("rejects cursors from a different sort mode", () => {
    const encoded = encodeCursor(base);
    expect(decodeCursor(encoded, "newest")).toBeNull();
  });

  it("rejects malformed cursors", () => {
    expect(decodeCursor("not-base64!!", "relevance")).toBeNull();
    expect(decodeCursor(Buffer.from("{}").toString("base64url"), "relevance")).toBeNull();
  });

  it("requires score for relevance cursors", () => {
    const encoded = encodeCursor({ sort: "relevance", sortAt: base.sortAt, docType: "feature", docId: base.docId });
    expect(decodeCursor(encoded, "relevance")).toBeNull();
  });

  it("accepts newest cursors without score", () => {
    const newest = { sort: "newest" as const, sortAt: base.sortAt, docType: "comment", docId: base.docId };
    expect(decodeCursor(encodeCursor(newest), "newest")?.sort).toBe("newest");
  });
});
