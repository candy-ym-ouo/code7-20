import { pinyin as toPinyin } from "pinyin-pro";

export type PinyinForms = {
  /** 空格分隔的全拼音节，直接进入 tsvector，如 "chang yi bei ke" */
  full: string;
  /** 无空格紧凑全拼，用于三字母以上的模糊/包含匹配，如 "changyibeke" */
  compact: string;
  /** 每个汉字的首字母串联，如 "cybk" */
  initials: string;
};

// 连续汉字段（含扩展 A 区）或连续拉丁字母/数字
const SEGMENT = /[㐀-䶿一-鿿豈-﫿]+|[A-Za-z0-9]+/gu;
const COMBINING_MARKS = /[̀-ͯ]/g;

// pinyin-pro 输出的带调/不带调 ü 系列（含四种声调预组合字符，大小写）
const U_UMLAUT_FORMS = /[üǖǘǚǜÜǕǗǙǛ]/g;

/** 与索引/查询两边保持一致的归一化：ü 系列必须先于 NFKD（否则变音符号被剥离成 u）。 */
export function normalizeLatin(value: string): string {
  return value
    .replace(U_UMLAUT_FORMS, "v")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 由多个文本片段构建三种拼音形式。
 *
 * - 每个连续汉字段整段交给 pinyin-pro，保证多音字的上下文消歧（如“长椅”→ chang yi）；
 * - 拉丁词原样小写保留在 full/compact 中，首字母串只取汉字声母；
 * - 片段之间用空格分隔，不产生跨片段相邻汉字。
 */
export function buildPinyinFromParts(...parts: Array<string | null | undefined>): PinyinForms {
  const text = parts.filter(Boolean).join(" ");
  const segments = text.match(SEGMENT) ?? [];

  const full: string[] = [];
  const compact: string[] = [];
  const initials: string[] = [];

  for (const segment of segments) {
    if (/^[A-Za-z0-9]+$/.test(segment)) {
      const word = segment.toLowerCase();
      full.push(word);
      compact.push(word);
      continue;
    }

    const syllables = (toPinyin(segment, { toneType: "none", type: "array" }) as string[])
      .map((value) => normalizeLatin(value).replaceAll(" ", ""))
      .filter(Boolean);
    if (syllables.length === 0) continue;

    full.push(...syllables);
    compact.push(syllables.join(""));

    const firsts = toPinyin(segment, { pattern: "first", toneType: "none", type: "array" }) as string[];
    for (const initial of firsts) {
      const normalized = initial.toLowerCase();
      if (/^[a-z]$/.test(normalized)) initials.push(normalized);
    }
  }

  return {
    full: full.join(" "),
    compact: compact.join(""),
    initials: initials.join("")
  };
}
