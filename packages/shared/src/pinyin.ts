import { pinyin } from "pinyin-pro";

// CJK 统一表意文字（含扩展 A 与兼容表意文字），覆盖常见地名/评论用字。
const CJK_RUN_PATTERN = /[㐀-䶿一-鿿豈-﫿]+/g;
const CJK_CHAR_PATTERN = /[㐀-䶿一-鿿豈-﫿]/;
const ASCII_WORD_PATTERN = /^[a-z0-9]+$/;

export type PinyinIndex = {
  /** 每个汉字run的音节直接拼接（无空格），用于子串匹配，如 "chaoyanggongyuanchangyi"。 */
  compact: string;
  /** 每个音节首字母拼接，用于首字母缩写检索，如 "cygycy"。 */
  initials: string;
};

/**
 * 为索引侧生成拼音检索文本。输入可以是多个字段（标题、描述、标签……），
 * 每个字段中的连续汉字段独立转拼音后全部拼接。非汉字内容不进入拼音列
 * （拉丁词由 tsvector/search_text 覆盖）。
 */
export function buildPinyinIndex(texts: Array<string | null | undefined>): PinyinIndex {
  const compactParts: string[] = [];
  const initialParts: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const run of extractCjkRuns(text)) {
      const syllables = pinyin(run, { toneType: "none", type: "array" })
        .map((item) => item.trim().toLowerCase())
        .filter((item) => ASCII_WORD_PATTERN.test(item));
      if (syllables.length === 0) continue;
      compactParts.push(syllables.join(""));
      initialParts.push(syllables.map((item) => item[0]).join(""));
    }
  }
  return {
    compact: compactParts.join(" "),
    initials: initialParts.join(" ")
  };
}

export function extractCjkRuns(text: string): string[] {
  return text.match(CJK_RUN_PATTERN) ?? [];
}

export function containsCjk(text: string): boolean {
  return CJK_CHAR_PATTERN.test(text);
}

/** 查询串归一化：去首尾空白、小写、压缩连续空白、限制长度。 */
export function normalizeSearchQuery(raw: string, maxLength = 100): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, maxLength);
}

export type QueryKind = "ascii" | "cjk" | "mixed";

export function classifyQuery(query: string): QueryKind {
  const hasCjk = containsCjk(query);
  const hasAscii = /[a-z0-9]/.test(query);
  if (hasCjk && hasAscii) return "mixed";
  return hasCjk ? "cjk" : "ascii";
}

/**
 * 从归一化查询中提取可进入 tsquery 的拉丁词项。
 * 只保留 [a-z0-9] 词，保证拼出的 tsquery 字符串语法安全。
 */
export function extractAsciiTerms(query: string, maxTerms = 8): string[] {
  const terms = query
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term.length <= 40);
  return terms.slice(0, maxTerms);
}

/** 构造 `a:* & b:*` 形式的前缀 tsquery 文本（词项已白名单过滤）。 */
export function buildPrefixTsquery(terms: string[]): string | null {
  if (terms.length === 0) return null;
  return terms.map((term) => `${term}:*`).join(" & ");
}

/** 拼音匹配用的查询串：去掉所有空白，只保留拉丁字母与数字。 */
export function compactPinyinQuery(query: string): string {
  return query.replace(/[^a-z0-9]+/g, "").slice(0, 60);
}

/** 转义 ILIKE 模式中的特殊字符（配合 ESCAPE '\'）。 */
export function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
