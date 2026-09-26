import { apiFetch } from "./api";

export type SearchItem = {
  type: "feature" | "comment";
  id: string;
  featureId: string;
  status: string;
  categoryKey: string | null;
  title: string;
  snippet: string;
  body?: string;
  authorName: string;
  tags: string[];
  longitude: number | null;
  latitude: number | null;
  sortAt: string;
};

export type SearchResponse = {
  items: SearchItem[];
  nextCursor: string | null;
};

export type SearchParams = {
  q?: string;
  type?: "feature" | "comment";
  category?: string[];
  tag?: string[];
  sort?: "relevance" | "newest";
  limit?: number;
  cursor?: string;
};

/**
 * 检索地点与评论。中文、拼音（全拼/紧凑/首字母）、标签和分类可任意组合；
 * 使用返回的 nextCursor 做稳定键集分页。
 */
export async function search(params: SearchParams): Promise<SearchResponse> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.type) query.set("type", params.type);
  if (params.category?.length) query.set("category", params.category.join(","));
  if (params.tag?.length) query.set("tag", params.tag.join(","));
  if (params.sort) query.set("sort", params.sort);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.cursor) query.set("cursor", params.cursor);
  const suffix = query.size ? `?${query.toString()}` : "";
  return apiFetch<SearchResponse>(`/search${suffix}`);
}
