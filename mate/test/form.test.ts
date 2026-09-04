import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SECTION_BARS,
  FormStringSchema,
  TemplateSchema,
  formLabels,
  formTotalBars,
  parseForm,
  stringifyForm,
} from "@aibleton/protocol";

const CANONICAL = "a8 b8 a8 b8 b8 c4 c4 b8 b8";

describe("parseForm", () => {
  test("parses letter and bar count", () => {
    expect(parseForm("a8 b4")).toEqual([
      { label: "a", bars: 8 },
      { label: "b", bars: 4 },
    ]);
  });

  test("a bare letter takes the default bars", () => {
    expect(parseForm("a b")).toEqual([
      { label: "a", bars: DEFAULT_SECTION_BARS },
      { label: "b", bars: DEFAULT_SECTION_BARS },
    ]);
  });

  test("honours an explicit default", () => {
    expect(parseForm("a b", 16)).toEqual([
      { label: "a", bars: 16 },
      { label: "b", bars: 16 },
    ]);
  });

  test("tolerates commas and extra whitespace", () => {
    expect(parseForm("  a, b ,  a  ")).toEqual(parseForm("a b a"));
  });

  test("rejects an empty form", () => {
    expect(() => parseForm("   ")).toThrow(/empty/);
  });

  test.each(["A8", "ab8", "8", "a-8", "a0"])("rejects %p", (bad) => {
    expect(() => parseForm(bad)).toThrow();
  });
});

describe("stringifyForm", () => {
  test("round-trips a canonical form", () => {
    expect(stringifyForm(parseForm(CANONICAL))).toBe(CANONICAL);
  });

  test("makes implicit bars explicit", () => {
    expect(stringifyForm(parseForm("a b a"))).toBe("a8 b8 a8");
  });
});

describe("form helpers", () => {
  test("formLabels is distinct and in first-appearance order", () => {
    expect(formLabels(parseForm("b8 a8 b8 c8 a8"))).toEqual(["b", "a", "c"]);
  });

  test("formTotalBars sums occurrences", () => {
    expect(formTotalBars(parseForm(CANONICAL))).toBe(64);
  });
});

describe("FormStringSchema", () => {
  test("accepts a parseable form", () => {
    expect(FormStringSchema.safeParse(CANONICAL).success).toBe(true);
  });

  test("rejects an unparseable form with the parser's message", () => {
    const result = FormStringSchema.safeParse("a8 QQ");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/bad form token/);
  });
});

function template(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "Jam",
    form: "a8 b8",
    sections: {
      a: { label: "a", brief: "groove" },
      b: { label: "b", brief: "lift" },
    },
    createdAt: 0,
    ...over,
  };
}

describe("TemplateSchema", () => {
  test("accepts a template whose sections cover the form", () => {
    expect(TemplateSchema.safeParse(template()).success).toBe(true);
  });

  test("rejects a form that uses an undefined section", () => {
    const result = TemplateSchema.safeParse(template({ form: "a8 b8 c8" }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/no section defines it/);
  });

  test("rejects a section filed under the wrong key", () => {
    const result = TemplateSchema.safeParse(
      template({ sections: { a: { label: "a", brief: "groove" }, b: { label: "c", brief: "lift" } } }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/is labelled/);
  });

  test("unused sections are allowed", () => {
    const result = TemplateSchema.safeParse(
      template({ form: "a8", sections: { a: { label: "a", brief: "groove" }, z: { label: "z", brief: "spare" } } }),
    );
    expect(result.success).toBe(true);
  });
});
