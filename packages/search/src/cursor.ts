/**
 * 稳定分页游标。
 *
 * 相关性排序使用 (score DESC, sort_at DESC, doc_type, doc_id) 四元组，
 * 最新排序使用 (sort_at DESC, doc_type, doc_id) 三元组；末两位恒定唯一，
 * 因此翻页期间即使文档重新索引、评分微变，也不会出现重复或跳项
 * （同一查询参数下游标里的 score 只用于延续上一页位置）。
 */

export type SearchSortMode = "relevance" | "newest";

export type SearchCursor = {
  sort: SearchSortMode;
  sortAt: string;
  docType: string;
  docId: string;
  score?: number;
};

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function encodeCursor(cursor: SearchCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

export function decodeCursor(value: string, expectedSort: SearchSortMode): SearchCursor | null {
  try {
    const decoded = JSON.parse(fromBase64Url(value)) as Partial<SearchCursor>;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      decoded.sort !== expectedSort ||
      typeof decoded.sortAt !== "string" ||
      typeof decoded.docType !== "string" ||
      typeof decoded.docId !== "string" ||
      !Number.isFinite(Date.parse(decoded.sortAt))
    ) {
      return null;
    }
    if (decoded.sort === "relevance" && typeof decoded.score !== "number") return null;
    return decoded as SearchCursor;
  } catch {
    return null;
  }
}
