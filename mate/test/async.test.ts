import { describe, expect, test } from "bun:test";
import { mapLimit } from "../src/core/async.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("mapLimit", () => {
  test("keeps input order", async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => {
      for (let i = 0; i < n; i++) await tick();
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  test("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  test("rejects on the first failure and stops starting new work", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        await tick();
        if (n === 2) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await tick();
    expect(started.length).toBeLessThan(6);
  });

  test("handles empty input and a limit above the length", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit([1], 99, async (n) => n + 1)).toEqual([2]);
  });
});
