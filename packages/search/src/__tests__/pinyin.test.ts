import { describe, expect, it } from "vitest";
import { buildPinyinFromParts, normalizeLatin } from "../pinyin";

describe("normalizeLatin", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeLatin("Cháng-Yǐ!")).toBe("chang yi");
  });

  it("maps ü to v", () => {
    expect(normalizeLatin("Lǜ sè")).toBe("lv se");
  });
});

describe("buildPinyinFromParts", () => {
  it("builds full, compact and initial forms with contextual disambiguation", () => {
    const forms = buildPinyinFromParts("朝阳公园长椅");
    expect(forms.full).toBe("chao yang gong yuan chang yi");
    expect(forms.compact).toBe("chaoyanggongyuanchangyi");
    expect(forms.initials).toBe("cygycy");
  });

  it("keeps latin words in full and compact but not in initials", () => {
    const forms = buildPinyinFromParts("绿色饮水处 water");
    expect(forms.full.split(" ")).toContain("water");
    expect(forms.compact).toContain("water");
    // 首字母只来自汉字：5 个汉字 -> 5 个首字母，不含 water 的字母
    expect(forms.initials).toHaveLength(5);
  });

  it("combines multiple parts without cross-part bigrams", () => {
    const forms = buildPinyinFromParts("长椅", "遮雨棚");
    expect(forms.full).toBe("chang yi zhe yu peng");
    expect(forms.initials).toBe("cyzyp");
  });

  it("handles empty input", () => {
    expect(buildPinyinFromParts("", null, undefined)).toEqual({
      full: "",
      compact: "",
      initials: ""
    });
  });

  it("includes digits", () => {
    const forms = buildPinyinFromParts("3号长椅");
    expect(forms.full).toContain("3");
    expect(forms.compact).toContain("3");
  });
});
