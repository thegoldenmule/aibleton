/**
 * mulberry32: a tiny seeded PRNG, good enough for song and band shapes.
 * Pure — never `Math.random()` — so the same seed always replays the same draws.
 * Negative and oversized seeds fold deterministically onto 32 bits.
 */
export function mulberry32(seed: number): () => number {
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
