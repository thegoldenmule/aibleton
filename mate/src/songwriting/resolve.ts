import { KEY_ROOTS, SongSchema, beatsPerBar, keyName } from "@aibleton/protocol";
import type { KeyMode, MusicalKey, SampleSlot, Song, SoundKey, SpliceCandidate, TimeSignature } from "@aibleton/protocol";
import { mapLimit } from "../core/async.ts";
import type { Logger } from "../log.ts";
import type { Sound, SplicePort } from "../ports/splice/types.ts";

/**
 * Turns each sample slot of a song into ranked Splice candidates. Splice's
 * search is one query in, ten hits out, no key filter and no pagination
 * (docs/splice-integration.md), so the resolver fans several short queries
 * out per slot, merges the hits and scores them here on bpm, key, loop
 * length and instrument. Everything except `resolveSong` is pure.
 */

export const MAX_CANDIDATES = 5;
export const MAX_QUERIES_PER_SLOT = 4;
export const SEARCH_CONCURRENCY = 4;
/** Roles whose material has no key; key scoring is skipped for them. */
export const UNPITCHED_ROLES: ReadonlySet<string> = new Set(["drums", "percussion", "fx"]);

export class SlotNotFoundError extends Error {
  constructor(readonly slotId: string) {
    super(`no slot ${JSON.stringify(slotId)}`);
  }
}

export class NotACandidateError extends Error {
  constructor(readonly slotId: string, readonly soundUuid: string) {
    super(`${soundUuid} is not a candidate for slot ${JSON.stringify(slotId)}`);
  }
}

/** Everything the resolver knows about one slot, pulled from the structured song parts. */
export interface SlotContext {
  slot: SampleSlot;
  role: string;
  name: string;
  partBrief: string;
  sectionBrief: string;
  soundHints: string[];
  sectionDescriptors: string[];
  genres: string[];
  descriptors: string[];
  timeSignature: TimeSignature;
}

export function slotContext(song: Song, slot: SampleSlot): SlotContext {
  const track = song.plan.tracks.find((t) => t.partId === slot.partId);
  const part = song.band.parts.find((p) => p.id === slot.partId);
  const briefPart = song.brief.parts.find((p) => p.partId === slot.partId);
  const briefSection = song.brief.sections.find((s) => s.label === slot.label);
  return {
    slot,
    role: track?.role ?? part?.role ?? "unknown",
    name: track?.name ?? part?.name ?? slot.partId,
    partBrief: part?.brief ?? "",
    sectionBrief: song.template.sections[slot.label]?.brief ?? "",
    soundHints: briefPart?.soundHints ?? [],
    sectionDescriptors: briefSection?.descriptors ?? [],
    genres: song.brief.genres,
    descriptors: song.brief.descriptors,
    timeSignature: song.plan.timeSignature,
  };
}

// ---- queries ---------------------------------------------------------------

/** What to ask Splice for per role. "grooves" makes Splice return whole-kit drum patterns. */
const INSTRUMENT: Record<string, string> = {
  drums: "drum grooves",
  percussion: "percussion grooves",
  bass: "bass loop",
  guitar: "guitar loop",
  keys: "keys loop",
  synth: "synth loop",
  horns: "horns loop",
  strings: "strings loop",
  vocals: "vocal loop",
  fx: "fx loop",
};

/** Words in tags or file names that mark a sound as belonging to a role. */
const ROLE_WORDS: Record<string, string[]> = {
  drums: ["drums", "drum", "grooves", "breaks", "breakbeat", "kit"],
  percussion: ["percussion", "perc", "shaker", "conga", "bongo", "tambourine"],
  bass: ["bass", "sub"],
  guitar: ["guitar", "gtr"],
  keys: ["keys", "piano", "rhodes", "organ", "wurli", "clav"],
  synth: ["synth", "pad", "pads", "lead", "arp"],
  horns: ["horns", "brass", "sax", "trumpet", "trombone"],
  strings: ["strings", "violin", "cello", "viola"],
  vocals: ["vocals", "vocal", "vox"],
  fx: ["fx", "riser", "impact", "transition", "texture"],
};

const STOP_WORDS = new Set(["the", "and", "with", "for", "some", "that", "this", "very", "into", "over", "under"]);
const KEY_TEXT = /^[a-g](#|b)?\s*(major|minor|maj|min|m|dorian|mixolydian|lydian|phrygian)?$/i;
const BAR_COUNT = /\b\d+\s*bars?\b/i;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9#]+/)
    .filter(Boolean);
}

function instrumentPhrase(role: string): string {
  return INSTRUMENT[role] ?? `${role} loop`;
}

/** Descriptor words that add signal: not key text, bar counts, genres, role words or filler. */
function usable(word: string, ctx: SlotContext): boolean {
  const w = word.trim();
  if (w.length < 3 || STOP_WORDS.has(w.toLowerCase())) return false;
  if (KEY_TEXT.test(w) || BAR_COUNT.test(w)) return false;
  if (w.toLowerCase() === keyName(ctx.slot.key).toLowerCase()) return false;
  const lower = w.toLowerCase();
  if (ctx.genres.some((g) => g.toLowerCase() === lower)) return false;
  if (lower === ctx.role || (ROLE_WORDS[ctx.role] ?? []).includes(lower)) return false;
  return true;
}

function distinct(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const key = w.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(w.trim());
  }
  return out;
}

function phrase(parts: readonly (string | undefined)[]): string {
  return distinct(parts.filter((p): p is string => Boolean(p && p.trim()))).join(", ");
}

/**
 * Short Splice queries for a slot, instrument first, then a couple of
 * descriptors, then a genre. Never the layout's comma-joined `slot.query`,
 * which returns the wrong instrument (docs/splice-integration.md).
 */
export function composeQueries(ctx: SlotContext): string[] {
  const instrument = instrumentPhrase(ctx.role);
  const genre = ctx.genres[0];
  const moods = distinct([...ctx.soundHints, ...ctx.sectionDescriptors, ...ctx.descriptors]).filter((w) => usable(w, ctx));
  const queries: string[] = [];

  queries.push(phrase([instrument, ...moods.slice(0, 2), genre]));

  const briefWords = tokens(ctx.partBrief)
    .filter((w) => !KEY_TEXT.test(w) && !STOP_WORDS.has(w))
    .slice(0, 6);
  if (briefWords.length) {
    const roleWords = ROLE_WORDS[ctx.role] ?? [ctx.role];
    if (!briefWords.some((w) => roleWords.includes(w))) briefWords.push(roleWords[0] ?? ctx.role);
    if ((ctx.role === "drums" || ctx.role === "percussion") && !briefWords.includes("grooves")) briefWords.push("grooves");
    queries.push(phrase([briefWords.join(" "), genre]));
  }

  const sectionWords = distinct([...ctx.sectionDescriptors, ...tokens(ctx.sectionBrief)]).filter((w) => usable(w, ctx));
  if (sectionWords.length) queries.push(phrase([instrument, ...sectionWords.slice(0, 2), genre]));

  if (ctx.genres[1]) queries.push(phrase([instrument, ...moods.slice(0, 1), ctx.genres[1]]));

  return distinct(queries).slice(0, MAX_QUERIES_PER_SLOT);
}

// ---- scoring ---------------------------------------------------------------

const SCALES: Record<KeyMode, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

function pitchClass(root: string): number {
  return KEY_ROOTS.indexOf(root as (typeof KEY_ROOTS)[number]);
}

/** Pitch classes (0 = C) in a key's scale. */
export function scalePitchClasses(key: MusicalKey): Set<number> {
  const root = pitchClass(key.root);
  return new Set(SCALES[key.mode].map((i) => (root + i) % 12));
}

/** The major/minor flavour of a mode, which is what Splice's tags distinguish. */
export function parallelMode(mode: KeyMode): "major" | "minor" {
  return mode === "major" || mode === "mixolydian" || mode === "lydian" ? "major" : "minor";
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export const KEY_WEIGHT = 25;

/**
 * How well a sound's key suits the slot's, 0..25. Same root in the parallel
 * mode beats a relative key: a C dorian brief wants C minor loops, not
 * A#/Bb major ones.
 */
export function keyScore(slotKey: MusicalKey, sound: SoundKey | null): number {
  if (!sound) return 5;
  const sameRoot = sound.root === slotKey.root;
  if (sound.mode === null) {
    if (sameRoot) return 20;
    return scalePitchClasses(slotKey).has(pitchClass(sound.root)) ? 8 : 0;
  }
  if (sameRoot && sound.mode === parallelMode(slotKey.mode)) return KEY_WEIGHT;
  if (sameSet(scalePitchClasses(slotKey), scalePitchClasses({ root: sound.root, mode: sound.mode }))) return 18;
  if (sameRoot) return 10;
  return 0;
}

/** Whole bars a loop spans at its own tempo, or null when it is not a clean bar count. */
export function soundBars(sound: Pick<Sound, "bpm" | "durationSec">, sig: TimeSignature): number | null {
  if (sound.bpm === null || sound.durationSec === null || sound.bpm <= 0) return null;
  const bars = (sound.durationSec * sound.bpm) / 60 / beatsPerBar(sig);
  const rounded = Math.round(bars);
  if (rounded < 1 || Math.abs(bars - rounded) > 0.2) return null;
  return rounded;
}

function bpmDistance(sound: Pick<Sound, "bpm">, target: number): number {
  return sound.bpm === null ? Number.POSITIVE_INFINITY : Math.abs(sound.bpm - target);
}

function bpmScore(sound: Pick<Sound, "bpm">, bpm: SampleSlot["bpm"]): number {
  if (sound.bpm === null) return 0;
  const half = Math.max(1, Math.max(bpm.target - bpm.min, bpm.max - bpm.target));
  const direct = Math.abs(sound.bpm - bpm.target);
  const stretched = Math.min(Math.abs(sound.bpm * 2 - bpm.target), Math.abs(sound.bpm / 2 - bpm.target));
  const score = (d: number) => (d <= 1 ? 30 : 30 * Math.max(0, 1 - d / (2 * half)));
  return stretched < direct ? score(stretched) * 0.6 : score(direct);
}

function barsScore(bars: number | null, loopBars: number): number {
  if (bars === null) return 6;
  if (bars === loopBars) return 20;
  if (loopBars % bars === 0) return 14;
  if (bars % loopBars === 0) return 8;
  return 0;
}

function roleScore(ctx: SlotContext, sound: Pick<Sound, "tags" | "fileName">): number {
  const hay = new Set([...sound.tags.flatMap(tokens), ...tokens(sound.fileName)]);
  const words = ROLE_WORDS[ctx.role] ?? [ctx.role];
  let score = words.some((w) => hay.has(w)) ? 10 : 0;
  if ((ctx.role === "drums" || ctx.role === "percussion") && (hay.has("fill") || hay.has("fills"))) score -= 5;
  return score;
}

function tagScore(ctx: SlotContext, sound: Pick<Sound, "tags">): number {
  const mine = new Set(ctx.slot.tags.map((t) => t.toLowerCase()));
  const overlap = sound.tags.filter((t) => mine.has(t.toLowerCase())).length;
  return 5 * Math.min(1, overlap / 2);
}

/** Score a sound for a slot; `hits` is how many of the slot's queries returned it. */
export function scoreSound(ctx: SlotContext, sound: Sound, hits = 1): number {
  let score = bpmScore(sound, ctx.slot.bpm);
  if (!UNPITCHED_ROLES.has(ctx.role)) score += keyScore(ctx.slot.key, sound.key);
  score += barsScore(soundBars(sound, ctx.timeSignature), ctx.slot.loopBars);
  score += roleScore(ctx, sound);
  score += tagScore(ctx, sound);
  score += 3 * Math.min(2, Math.max(0, hits - 1));
  return Math.round(score * 10) / 10;
}

/** Merge the hits of every query for a slot into the best few candidates, best first. */
export function rankCandidates(ctx: SlotContext, results: readonly (readonly Sound[])[]): SpliceCandidate[] {
  const hits = new Map<string, number>();
  const sounds = new Map<string, Sound>();
  for (const list of results) {
    const seenHere = new Set<string>();
    for (const sound of list) {
      if (sound.type !== "loop" || seenHere.has(sound.uuid)) continue;
      seenHere.add(sound.uuid);
      hits.set(sound.uuid, (hits.get(sound.uuid) ?? 0) + 1);
      if (!sounds.has(sound.uuid)) sounds.set(sound.uuid, sound);
    }
  }
  const target = ctx.slot.bpm.target;
  return [...sounds.values()]
    .map((sound) => ({ sound, hits: hits.get(sound.uuid) ?? 1, score: scoreSound(ctx, sound, hits.get(sound.uuid) ?? 1) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.hits - a.hits ||
        bpmDistance(a.sound, target) - bpmDistance(b.sound, target) ||
        a.sound.uuid.localeCompare(b.sound.uuid),
    )
    .slice(0, MAX_CANDIDATES)
    .map(({ sound, score }) => ({
      uuid: sound.uuid,
      fileName: sound.fileName,
      url: sound.url,
      bpm: sound.bpm,
      key: sound.key,
      durationSec: sound.durationSec,
      pack: sound.pack,
      tags: sound.tags,
      bars: soundBars(sound, ctx.timeSignature),
      score,
    }));
}

// ---- orchestration ---------------------------------------------------------

export interface ResolveDeps {
  splice: Pick<SplicePort, "searchSounds">;
  log: Logger;
  signal: AbortSignal;
  concurrency?: number;
}

export interface ResolveResult {
  song: Song;
  /** Slots whose every query failed; their previous candidates are kept. */
  failedSlotIds: string[];
}

/** Which uuid a slot should download after a fresh set of candidates. */
function choosePick(slot: SampleSlot, candidates: SpliceCandidate[]): string | null {
  const has = (uuid: string | null | undefined) => uuid != null && candidates.some((c) => c.uuid === uuid);
  if (has(slot.pickedUuid)) return slot.pickedUuid;
  if (has(slot.resolved?.soundUuid)) return slot.resolved!.soundUuid;
  return candidates[0]?.uuid ?? null;
}

/**
 * Search Splice for every slot and store ranked candidates on the song.
 * Free: nothing here spends a credit. `resolved` (what is on disk) is left
 * alone; a slot's pick survives when it is still among the new candidates.
 */
export async function resolveSong(song: Song, deps: ResolveDeps): Promise<ResolveResult> {
  const contexts = song.plan.slots.map((slot) => slotContext(song, slot));
  const jobs = contexts.flatMap((ctx, slotIndex) => composeQueries(ctx).map((query) => ({ slotIndex, query })));

  const outcomes = await mapLimit(jobs, deps.concurrency ?? SEARCH_CONCURRENCY, async ({ slotIndex, query }) => {
    if (deps.signal.aborted) throw new Error("aborted");
    const { bpm } = contexts[slotIndex]!.slot;
    try {
      return await deps.splice.searchSounds(query, { bpmMin: bpm.min, bpmMax: bpm.max, type: "loop" });
    } catch (err) {
      deps.log.warn(`splice search failed for ${JSON.stringify(query)}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });

  const failedSlotIds: string[] = [];
  const slots = contexts.map((ctx, slotIndex) => {
    const results = jobs.flatMap((job, i) => (job.slotIndex === slotIndex && outcomes[i] ? [outcomes[i]!] : []));
    if (results.length === 0) {
      failedSlotIds.push(ctx.slot.id);
      return ctx.slot;
    }
    const candidates = rankCandidates(ctx, results);
    return { ...ctx.slot, candidates, pickedUuid: choosePick(ctx.slot, candidates) };
  });

  return { song: SongSchema.parse({ ...song, plan: { ...song.plan, slots } }), failedSlotIds };
}

/** Set a slot's pick to one of its candidates. Pure; throws on an unknown slot or uuid. */
export function pickCandidate(song: Song, slotId: string, soundUuid: string): Song {
  const slot = song.plan.slots.find((s) => s.id === slotId);
  if (!slot) throw new SlotNotFoundError(slotId);
  if (!slot.candidates.some((c) => c.uuid === soundUuid)) throw new NotACandidateError(slotId, soundUuid);
  const slots = song.plan.slots.map((s) => (s.id === slotId ? { ...s, pickedUuid: soundUuid } : s));
  return SongSchema.parse({ ...song, plan: { ...song.plan, slots } });
}
