import { describe, expect, it } from "vitest";
import {
  buildPinyinIndex,
  buildPrefixTsquery,
  classifyQuery,
  compactPinyinQuery,
  escapeIlikePattern,
  extractAsciiTerms,
  extractCjkRuns,
  normalizeSearchQuery
} from "./pinyin";

describe("buildPinyinIndex", () => {
  it("converts Chinese text to compact pinyin and initials", () => {
    const index = buildPinyinIndex(["朝阳公园东门的长椅"]);
    expect(index.compact).toBe("chaoyanggongyuandongmendechangyi");
    expect(index.initials).toBe("cygydmdcy");
  });

  it("joins multiple fields and skips non-Chinese content", () => {
    const index = buildPinyinIndex(["长椅", "WiFi 覆盖", null, undefined]);
    expect(index.compact).toBe("changyi fugai");
    expect(index.initials).toBe("cy fg");
  });

  it("returns empty strings for text without Chinese characters", () => {
    expect(buildPinyinIndex(["wifi", "108"])).toEqual({ compact: "", initials: "" });
  });

  it("handles polyphonic characters with the most common reading", () => {
    const index = buildPinyinIndex(["重庆"]);
    expect(index.compact).toBe("chongqing");
  });
});

describe("query helpers", () => {
  it("normalizes whitespace, case and length", () => {
    expect(normalizeSearchQuery("  Chang   Yi  ")).toBe("chang yi");
    expect(normalizeSearchQuery("x".repeat(200))).toHaveLength(100);
  });

  it("classifies query content", () => {
    expect(classifyQuery("changyi")).toBe("ascii");
    expect(classifyQuery("长椅")).toBe("cjk");
    expect(classifyQuery("长椅 wifi")).toBe("mixed");
  });

  it("extracts CJK runs", () => {
    expect(extractCjkRuns("长椅A1遮雨棚")).toEqual(["长椅", "遮雨棚"]);
  });

  it("extracts safe ascii terms", () => {
    expect(extractAsciiTerms("chang yi! <script>")).toEqual(["chang", "yi", "script"]);
    expect(extractAsciiTerms("！！！")).toEqual([]);
  });

  it("builds prefix tsquery only from whitelisted terms", () => {
    expect(buildPrefixTsquery(["chang", "yi"])).toBe("chang:* & yi:*");
    expect(buildPrefixTsquery([])).toBeNull();
  });

  it("compacts pinyin queries by removing separators", () => {
    expect(compactPinyinQuery("chang yi-ce")).toBe("changyice");
  });

  it("escapes ILIKE wildcards", () => {
    expect(escapeIlikePattern("50%_\\")).toBe("50\\%\\_\\\\");
  });
});
