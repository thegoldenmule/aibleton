import { DEFAULT_SECTION_BARS, stringifyForm } from "@aibleton/protocol";
import type { FormEntry, Section } from "@aibleton/protocol";

/** Letters a form may use, in the order they are allowed to appear. */
const ALPHABET = ["a", "b", "c", "d", "e", "f"] as const;
const MIN_ALPHABET = 2;
const MAX_ALPHABET = ALPHABET.length;

/** Relative pull of each candidate label. `home` is deliberately the heaviest. */
const WEIGHT_HOME = 5;
const WEIGHT_FIRST = 2.5;
const WEIGHT_NEW = 2;
const WEIGHT_OTHER = 1.5;
/** Damps back-to-back repeats so doubles stay a flavour rather than the norm. */
const REPEAT_FACTOR = 0.6;

export interface GenerateFormOptions {
  /** Any integer. The same seed with the same options always yields the same form. */
  seed: number;
  /** How many distinct section letters to use. 2..6, default 3. */
  alphabet?: number;
  /** How many occurrences the form has. default 9. */
  count?: number;
  /** Label the form keeps returning to (the refrain). Defaults to the second letter, "b". */
  home?: string;
  /** Max consecutive identical labels. default 2. */
  maxRun?: number;
  /** Bars per occurrence. default DEFAULT_SECTION_BARS. */
  bars?: number;
}

/** mulberry32: tiny, fast, good enough for song shapes. Pure — no `Math.random()`. */
function mulberry32(seed: number): () => number {
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function requireInt(value: number, name: string, min: number, max?: number): void {
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number, got ${value}`);
  if (value < min) throw new Error(`${name} must be at least ${min}, got ${value}`);
  if (max !== undefined && value > max) throw new Error(`${name} must be at most ${max}, got ${value}`);
}

/**
 * Generate a song form string from a seed.
 *
 * The shape is a wandering walk that keeps falling back to `home`: it opens on
 * `a`, introduces letters strictly in order and never more than one per step,
 * and refuses to sit on any label for more than `maxRun` occurrences in a row.
 *
 * @example generateForm({ seed: 42 }) // "a8 b8 b8 c8 b8 a8 b8 a8 b8"
 * @throws if the options are out of range or `home` is not a letter in play.
 */
export function generateForm(opts: GenerateFormOptions): string {
  const alphabet = opts.alphabet ?? 3;
  const count = opts.count ?? 9;
  const maxRun = opts.maxRun ?? 2;
  const bars = opts.bars ?? DEFAULT_SECTION_BARS;

  if (!Number.isInteger(opts.seed)) throw new Error(`seed must be a whole number, got ${opts.seed}`);
  requireInt(alphabet, "alphabet", MIN_ALPHABET, MAX_ALPHABET);
  requireInt(count, "count", 1);
  requireInt(maxRun, "maxRun", 1);
  requireInt(bars, "bars", 1);

  const letters = ALPHABET.slice(0, alphabet);
  const home = opts.home ?? letters[1]!;
  if (!letters.includes(home as (typeof ALPHABET)[number])) {
    throw new Error(`home ${JSON.stringify(home)} is not one of the letters in play (${letters.join(", ")})`);
  }

  const rng = mulberry32(opts.seed);
  const labels: string[] = [letters[0]!];
  let introduced = 1;
  let run = 1;

  for (let i = 1; i < count; i++) {
    const last = labels[i - 1]!;
    const stepsLeft = count - i;
    const missing = alphabet - introduced;

    // Introduce the next letter as late as possible, but never so late that the
    // remaining steps cannot fit the letters still owed. A brand new letter can
    // never break a run, so this is always a legal pick.
    if (missing >= stepsLeft) {
      const next = letters[introduced]!;
      introduced++;
      labels.push(next);
      run = 1;
      continue;
    }

    const candidates: { label: string; weight: number }[] = [];
    const pool = missing > 0 ? letters.slice(0, introduced + 1) : letters.slice(0, introduced);
    for (const label of pool) {
      // Never exceed maxRun. The pool always holds another option: with one
      // letter introduced the next new letter is available, and with two or
      // more some other introduced letter is.
      if (label === last && run >= maxRun) continue;
      const isNew = label === letters[introduced];
      let weight = WEIGHT_OTHER;
      if (label === home) weight = WEIGHT_HOME;
      else if (isNew) weight = WEIGHT_NEW;
      else if (label === letters[0]) weight = WEIGHT_FIRST;
      if (label === last) weight *= REPEAT_FACTOR;
      candidates.push({ label, weight });
    }

    const total = candidates.reduce((n, c) => n + c.weight, 0);
    let pick = candidates[candidates.length - 1]!.label;
    let roll = rng() * total;
    for (const candidate of candidates) {
      roll -= candidate.weight;
      if (roll < 0) {
        pick = candidate.label;
        break;
      }
    }

    if (pick === letters[introduced]) introduced++;
    run = pick === last ? run + 1 : 1;
    labels.push(pick);
  }

  const entries: FormEntry[] = labels.map((label) => ({ label, bars }));
  return stringifyForm(entries);
}

function briefFor(label: string, index: number): string {
  switch (index) {
    case 0:
      return "main groove: the core beat and bassline the song keeps returning from";
    case 1:
      return "lift: chorus energy, brighter and busier than the groove";
    case 2:
      return "breakdown: stripped back and darker, space where the groove was";
    default:
      return `variation ${index - 2} on the groove (${label}): same feel, new texture`;
  }
}

/**
 * Starter sections for a set of labels, one per label, filed under its own
 * letter. Roles follow position: groove, lift, breakdown, then variations.
 * `intensity` is left unset — that field is reserved and nothing reads it.
 */
export function defaultSections(labels: readonly string[]): Record<string, Section> {
  const sections: Record<string, Section> = {};
  let index = 0;
  for (const label of labels) {
    if (sections[label]) continue;
    sections[label] = { label, brief: briefFor(label, index) };
    index++;
  }
  return sections;
}
