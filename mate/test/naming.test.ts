import { describe, expect, test } from "bun:test";
import { bandName, templateName } from "../src/core/naming.ts";

/**
 * The seed used to *be* the name — `${genre} band ${seed}` — and since the
 * default seed is the clock, that shipped bands called "hiphop band
 * 1788541344590". These are the two rules that replaced it: a name reads, and
 * the same seed always names the same thing.
 */
describe("naming", () => {
  test("a name is two capitalised words and no digits", () => {
    for (const seed of [0, 1, 42, 555, 1788541344590, 2_147_483_647]) {
      expect(bandName(seed)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(templateName(seed)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    }
  });

  test("the same seed always names the same band", () => {
    expect(bandName(42)).toBe(bandName(42));
    expect(templateName(42)).toBe(templateName(42));
  });

  test("a band and a form drawn from one seed read differently", () => {
    // Same modifier, different noun pools: a band is a room, a form is a route.
    expect(bandName(42)).not.toBe(templateName(42));
  });

  /**
   * Names are not keys — ids are — so collisions are allowed. They just have to
   * be rare enough that a library of a few dozen reads as a few dozen things.
   */
  test("a thousand consecutive seeds spread across the pools", () => {
    const names = new Set<string>();
    for (let seed = 1_788_541_344_000; seed < 1_788_541_345_000; seed++) names.add(bandName(seed));
    expect(names.size).toBeGreaterThan(600);
  });

  test("a negative or oversized seed still names something", () => {
    expect(bandName(-1)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(bandName(Number.MAX_SAFE_INTEGER)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });
});
