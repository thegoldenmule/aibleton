import { describe, expect, test } from "bun:test";
import { mulberry32 } from "@aibleton/protocol";

describe("mulberry32", () => {
  test("same seed replays the same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 16; i++) expect(a()).toBe(b());
  });

  test("values stay inside [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("negative and oversized seeds fold onto 32 bits", () => {
    expect(mulberry32(-1)()).toBe(mulberry32(0xffffffff)());
    expect(mulberry32(2 ** 32 + 5)()).toBe(mulberry32(5)());
  });

  test("pinned first draws so the extraction cannot drift", () => {
    // Recorded from the copy that lived in generator.ts before the extraction.
    const rng = mulberry32(42);
    expect(rng()).toBeCloseTo(0.6011037519201636, 12);
    expect(rng()).toBeCloseTo(0.44829055899754167, 12);
  });
});
