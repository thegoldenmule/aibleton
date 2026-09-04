import { formLabels, parseForm } from "@aibleton/protocol";
import type { Band, BandPart, SongBrief, Template } from "@aibleton/protocol";

/**
 * Who plays in each occurrence of the form. The brief may say (its
 * `arrangement`); where it does not line up with the final form, or says
 * nothing about a part, a deterministic rule fills in: parts ranked by how
 * foundational their role is, each section's intensity deciding how many of
 * them play, and the first pass through a section thinner than later ones.
 * Pure; the same inputs always give the same lineup.
 */

/** Lower plays first: rhythm section, then harmony, then colour. Unknown roles sit with harmony. */
const FOUNDATION_RANK: Record<string, number> = {
  drums: 0,
  percussion: 1,
  bass: 2,
  keys: 3,
  guitar: 3,
  synth: 3,
  strings: 4,
  horns: 4,
  vocals: 4,
  fx: 5,
};
const UNKNOWN_RANK = 3;

/** Intensity for a section the brief and template are silent about, by the order the form introduces it: groove, lift, breakdown, variations. */
const DEFAULT_INTENSITY = [0.6, 0.9, 0.35];
const VARIATION_INTENSITY = 0.7;

/** How much thinner the first occurrence of a section plays than its later ones. */
const FIRST_PASS = 0.7;

/** Parts in foundation order, band order breaking ties. */
export function foundationOrder(parts: readonly BandPart[]): BandPart[] {
  return parts
    .map((part, i) => ({ part, i, rank: FOUNDATION_RANK[part.role] ?? UNKNOWN_RANK }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.part);
}

/** The section's intensity as saved, else a default by its position in the form. */
export function sectionIntensity(template: Template, label: string): number {
  const saved = template.sections[label]?.intensity;
  if (saved !== undefined) return saved;
  const index = formLabels(parseForm(template.form)).indexOf(label);
  return DEFAULT_INTENSITY[index] ?? VARIATION_INTENSITY;
}

/**
 * The rule alone: per occurrence, the first `ceil(n * intensity * pass)`
 * parts in foundation order, never fewer than one, where `pass` is thinner
 * for the first occurrence of each letter.
 */
export function fallbackLineup(template: Template, band: Band): Set<string>[] {
  const ordered = foundationOrder(band.parts);
  const seen = new Set<string>();
  return parseForm(template.form).map((entry) => {
    const pass = seen.has(entry.label) ? 1 : FIRST_PASS;
    seen.add(entry.label);
    const count = Math.min(ordered.length, Math.max(1, Math.ceil(ordered.length * sectionIntensity(template, entry.label) * pass - 1e-9)));
    return new Set(ordered.slice(0, count).map((p) => p.id));
  });
}

/**
 * The lineup the layout uses. The brief's `arrangement` is taken when it
 * has one entry per occurrence with matching letters; ids the band does
 * not have are ignored. A part the brief was never shown (one its
 * `bandFeedback` added, whose id it could not know) plays where the rule
 * would put it. An occurrence the brief leaves empty falls back to the
 * rule too.
 */
export function songLineup(template: Template, band: Band, brief: SongBrief): Set<string>[] {
  const fallback = fallbackLineup(template, band);
  const entries = parseForm(template.form);
  const given = brief.arrangement;
  const aligned = given.length === entries.length && given.every((g, i) => g.label === entries[i]!.label);
  if (!aligned) return fallback;

  const known = new Set(band.parts.map((p) => p.id));
  const shown = new Set(brief.parts.map((p) => p.partId));
  return given.map((g, i) => {
    const plays = new Set(g.parts.filter((id) => known.has(id)));
    for (const id of fallback[i]!) if (!shown.has(id)) plays.add(id);
    return plays.size > 0 ? plays : fallback[i]!;
  });
}
