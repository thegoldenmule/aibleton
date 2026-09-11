import { mulberry32 } from "./rng.ts";

/**
 * Names for a rolled band or template.
 *
 * These used to be the seed: `` `${genre} band ${seed}` ``, and since the
 * default seed is the clock, a generate with the name left blank came out as
 * "hiphop band 1788541344590". The seed belongs in the record's `seed` field,
 * where it is exact and reproducible; the name belongs on a card, where it is
 * read. So a seeded draw from two word pools names the thing instead.
 *
 * Deterministic in the seed, like every other generator here: the same seed
 * names the same band, so a roll is still reproducible end to end.
 */

/** Shared first word. Textures and temperatures, nothing genre-specific — the genre is its own tag. */
const MODIFIERS = [
  "Velvet", "Brass", "Neon", "Paper", "Iron", "Glass", "Amber", "Hollow",
  "Crooked", "Midnight", "Quiet", "Slow", "Wired", "Salt", "Copper", "Cold",
  "Long", "Blue", "Dust", "Low", "Static", "Pale", "Wild", "Tender",
  "Spare", "Loose", "Heavy", "Sharp", "Second", "Distant", "Crimson", "Gold",
  "Marble", "Rough", "Silver", "Bitter", "Sweet", "Thin", "Open", "Sudden",
] as const;

/** A band is a group of people: rooms, trades and institutions. */
const BAND_NOUNS = [
  "Alibi", "Ninth", "Union", "Parade", "Circuit", "Chapel", "Harbour", "Signal",
  "Cadence", "Method", "Machine", "Orchard", "Avenue", "Bureau", "Tandem", "Anthem",
  "Lantern", "Quarry", "Motel", "Engine", "Ledger", "Meridian", "Practice", "Society",
  "Transit", "Junction", "Reverb", "Ferry", "Archive", "Almanac", "Tremolo", "Hotel",
  "Verdict", "Cartel", "Ensemble", "Foundry", "Pageant", "Delta", "Chorus", "Compass",
] as const;

/** A template is a route through a song: shapes of travel. */
const FORM_NOUNS = [
  "Route", "Detour", "Arc", "Climb", "Descent", "Loop", "Passage", "Crossing",
  "Ascent", "Turn", "Ramp", "Bridge", "Stretch", "Lap", "Run", "Spiral",
  "Cycle", "Traverse", "Sweep", "Return", "Approach", "Departure", "Landing", "Orbit",
  "Switchback", "Corridor", "Staircase", "Gradient", "Threshold", "Drift", "Coast", "Plateau",
  "Cascade", "Vault", "Ridge", "Horizon", "Furlong", "Waypoint", "Terminus", "Meander",
] as const;

function pair(seed: number, nouns: readonly string[]): string {
  const rng = mulberry32(seed);
  const modifier = MODIFIERS[Math.floor(rng() * MODIFIERS.length) % MODIFIERS.length]!;
  const noun = nouns[Math.floor(rng() * nouns.length) % nouns.length]!;
  return `${modifier} ${noun}`;
}

/** What a band rolled from `seed` is called when the drummer named nothing. */
export function bandName(seed: number): string {
  return pair(seed, BAND_NOUNS);
}

/** What a template rolled from `seed` is called when the drummer named nothing. */
export function templateName(seed: number): string {
  return pair(seed, FORM_NOUNS);
}
