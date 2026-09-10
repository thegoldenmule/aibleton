import { formLabels, parseForm } from "./form.ts";
import { beatsPerBar, slotDownloaded } from "./songs.ts";
import type { SampleSlot, Song, SongOccurrence } from "./songs.ts";
import type { ArrangementClip, Clip, DawState, Track } from "./state.ts";

/**
 * How a song maps onto the Live set. Live exposes no stable ids through the
 * MCP server, so the tracks mate creates are marked by a suffix in their name
 * and everything else (clips, placements) is found by file path and position.
 * `dawStatus` is the pure diff between a song and a session snapshot: what is
 * already in Live, and the steps still needed. mate runs the steps; the app
 * renders the status. Both use this one function, so they always agree.
 */

/** Marks a track as one mate created. Anything without it is the drummer's and is never touched. */
export const MATE_TRACK_SUFFIX = " [mate]";

export function mateTrackName(base: string): string {
  const b = base.trim();
  return b.endsWith(MATE_TRACK_SUFFIX) ? b : `${b}${MATE_TRACK_SUFFIX}`;
}

export function isMateTrack(track: Pick<Track, "name">): boolean {
  return track.name.endsWith(MATE_TRACK_SUFFIX);
}

/** Indexes of the tracks mate owns in a snapshot. */
export function ownedTrackIndexes(session: Pick<DawState, "tracks"> | null | undefined): Set<number> {
  const out = new Set<number>();
  for (const t of session?.tracks ?? []) if (isMateTrack(t)) out.add(t.index);
  return out;
}

/** `"Bass [mate]"`, or `"Bass 2 [mate]"` when that name is taken, and so on. */
export function uniqueTrackName(base: string, taken: ReadonlySet<string>): string {
  const b = base.trim().replace(/\s*\[mate\]$/, "");
  for (let n = 1; ; n++) {
    const candidate = mateTrackName(n === 1 ? b : `${b} ${n}`);
    if (!taken.has(candidate)) return candidate;
  }
}

/** Session scene (clip slot row) for a section label: labels in form order, one scene each. -1 when unknown. */
export function sceneIndexOf(song: Pick<Song, "template">, label: string): number {
  return formLabels(parseForm(song.template.form)).indexOf(label);
}

/** Name for the session clip holding a slot's sample; Live copies it onto every arrangement clip made from it. */
export function liveClipName(slot: Pick<SampleSlot, "label" | "resolved">): string {
  const file = slot.resolved?.fileName ?? "";
  return `${slot.label} · ${file.replace(/\.[A-Za-z0-9]{1,5}$/, "") || slot.resolved?.soundUuid || "sample"}`;
}

/** One thing mate must do in Live to bring the set closer to the song. */
export type ArrangeStep =
  | { type: "setTempo"; bpm: number }
  | { type: "createTrack"; partId: string; name: string }
  | { type: "importClip"; partId: string; slotId: string; track: number; scene: number; path: string; name: string }
  /** The slot's scene holds a different sample (a re-pick): delete it, then import. */
  | { type: "replaceClip"; partId: string; slotId: string; track: number; scene: number; path: string; name: string }
  | { type: "placeClip"; partId: string; slotId: string; track: number; scene: number; atBeat: number }
  | { type: "createLocator"; name: string; atBeat: number };

export interface DawTrackStatus {
  partId: string;
  /** The Live track name, chosen when the track is created. */
  name: string | null;
  /** Index in the snapshot, or null when the track is not in Live (yet, or any more). */
  index: number | null;
}

export type DawSlotState =
  /** The sample is not on disk, so there is nothing to import. */
  | "waiting"
  /** The part's track has fewer scenes than the form has sections; Live has no tool to add one. */
  | "no-scene"
  /** On disk but not in Live: the track or the clip is still to come. */
  | "pending"
  /** The scene holds a different sample; it will be replaced. */
  | "stale"
  | "in-live";

export interface DawSlotStatus {
  slotId: string;
  partId: string;
  scene: number;
  state: DawSlotState;
  /** Clip length Live reports after import; null until then. Live's auto-warp decides it, mate cannot. */
  lengthBeats: number | null;
  /** What the plan wanted: loopBars in beats. */
  expectedBeats: number;
}

export interface DawPlacementStatus {
  slotId: string;
  partId: string;
  occurrence: number;
  repeat: number;
  atBeat: number;
  placed: boolean;
}

export interface DawStatus {
  tracks: DawTrackStatus[];
  slots: DawSlotStatus[];
  placements: DawPlacementStatus[];
  /** Everything still to do, in an order that is safe to run top to bottom against this snapshot. */
  steps: ArrangeStep[];
  /** Things mate cannot fix through Live's MCP server, for the drummer. */
  notes: string[];
}

const EPS = 1e-3;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Live may report a resolved or relocated path; the file name is the fallback identity. */
function samePath(a: string | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b || baseName(a) === baseName(b);
}

function findTrack(session: DawState, name: string | null): Track | null {
  if (!name) return null;
  return session.tracks.find((t) => t.name === name && isMateTrack(t)) ?? null;
}

function placedAt(track: Track, atBeat: number, clip: Clip, path: string): boolean {
  return track.arrangementClips.some((c: ArrangementClip) => near(c.startTime, atBeat) && (c.filePath ? samePath(c.filePath, path) : c.name === clip.name));
}

/** Locator label for an occurrence: `a1`, `b1`, `a2`... counting occurrences of each label. */
export function locatorName(timeline: readonly SongOccurrence[], occurrence: SongOccurrence): string {
  const n = timeline.filter((o) => o.label === occurrence.label && o.index <= occurrence.index).length;
  return `${occurrence.label}${n}`;
}

/**
 * Diff a song against a Live snapshot. Pure. With no snapshot every slot is
 * pending and there are no steps: nothing can be planned blind.
 */
export function dawStatus(song: Song, session: DawState | null | undefined): DawStatus {
  const { plan } = song;
  const bpb = beatsPerBar(plan.timeSignature);
  const notes: string[] = [];
  const steps: ArrangeStep[] = [];

  const tracks: DawTrackStatus[] = plan.tracks.map((t) => ({ partId: t.partId, name: t.liveName, index: null }));
  const slots: DawSlotStatus[] = plan.slots.map((s) => ({
    slotId: s.id,
    partId: s.partId,
    scene: sceneIndexOf(song, s.label),
    state: slotDownloaded(s) ? "pending" : "waiting",
    lengthBeats: null,
    expectedBeats: s.loopBars * bpb,
  }));
  const placements: DawPlacementStatus[] = plan.placements.flatMap((p) =>
    Array.from({ length: p.repeats }, (_, repeat) => ({
      slotId: p.slotId,
      partId: p.partId,
      occurrence: p.occurrence,
      repeat,
      atBeat: p.startBeat + repeat * p.loopBars * bpb,
      placed: false,
    })),
  );
  if (!session) return { tracks, slots, placements, steps, notes: ["no Ableton snapshot yet"] };

  // Tracks: found by the name mate gave them; missing ones are created at the end of the set.
  const firstRun = plan.tracks.every((t) => t.liveName === null);
  if (firstRun && !near(session.transport.tempo, plan.bpm)) steps.push({ type: "setTempo", bpm: plan.bpm });
  const taken = new Set(session.tracks.map((t) => t.name));
  const liveTracks = new Map<string, Track>();
  for (const [i, t] of plan.tracks.entries()) {
    const live = findTrack(session, t.liveName);
    if (live) {
      tracks[i]!.index = live.index;
      liveTracks.set(t.partId, live);
      continue;
    }
    const name = t.liveName ?? uniqueTrackName(t.name, taken);
    taken.add(name);
    tracks[i]!.name = name;
    if (t.liveName) notes.push(`track ${JSON.stringify(t.liveName)} is no longer in the set; it will be created again`);
    steps.push({ type: "createTrack", partId: t.partId, name });
  }

  // Session clips: one scene per section label, holding the slot's downloaded sample.
  const slotById = new Map(plan.slots.map((s) => [s.id, s]));
  const liveClips = new Map<string, Clip>();
  const replaced: ArrangeStep[] = [];
  const imported: ArrangeStep[] = [];
  for (const status of slots) {
    if (status.state === "waiting") continue;
    const slot = slotById.get(status.slotId)!;
    const track = liveTracks.get(slot.partId);
    if (!track) continue; // pending: the track comes first
    if (status.scene < 0 || status.scene >= track.clipSlots.length) {
      status.state = "no-scene";
      notes.push(`${track.name} has ${track.clipSlots.length} scenes but section ${slot.label} needs scene ${status.scene + 1}; add a scene in Live`);
      continue;
    }
    const path = slot.resolved!.localPath!;
    const clip = track.clipSlots[status.scene]!.clip;
    const base = { partId: slot.partId, slotId: slot.id, track: track.index, scene: status.scene, path, name: liveClipName(slot) };
    if (!clip) {
      imported.push({ type: "importClip", ...base });
    } else if (samePath(clip.filePath, path)) {
      status.state = "in-live";
      status.lengthBeats = clip.length;
      liveClips.set(slot.id, clip);
      if (clip.length > 0 && !near(clip.length % status.expectedBeats, 0) && !near(status.expectedBeats % clip.length, 0)) {
        notes.push(`${clip.name || slot.id}: Live made it ${clip.length} beats, the plan wanted ${status.expectedBeats}; check its warp markers`);
      }
    } else {
      status.state = "stale";
      replaced.push({ type: "replaceClip", ...base });
    }
  }
  steps.push(...replaced, ...imported);

  // Arrangement: copies of the session clip, back to back, as many as fill the occurrence at the clip's real length.
  const placementSteps: ArrangeStep[] = [];
  const byPlacement = new Map<string, DawPlacementStatus[]>();
  for (const p of placements) {
    const key = `${p.slotId}:${p.occurrence}`;
    byPlacement.set(key, [...(byPlacement.get(key) ?? []), p]);
  }
  const placementsOut: DawPlacementStatus[] = [];
  for (const p of plan.placements) {
    const key = `${p.slotId}:${p.occurrence}`;
    const planned = byPlacement.get(key) ?? [];
    const clip = liveClips.get(p.slotId);
    const track = liveTracks.get(p.partId);
    const slot = slotById.get(p.slotId)!;
    if (!clip || !track) {
      placementsOut.push(...planned);
      continue;
    }
    const length = clip.length > 0 ? clip.length : p.loopBars * bpb;
    const copies = Math.max(1, Math.floor(p.lengthBeats / length + EPS));
    for (let repeat = 0; repeat < copies; repeat++) {
      const atBeat = p.startBeat + repeat * length;
      const placed = placedAt(track, atBeat, clip, slot.resolved!.localPath!);
      placementsOut.push({ slotId: p.slotId, partId: p.partId, occurrence: p.occurrence, repeat, atBeat, placed });
      if (!placed) placementSteps.push({ type: "placeClip", partId: p.partId, slotId: p.slotId, track: track.index, scene: sceneIndexOf(song, slot.label), atBeat });
    }
  }
  steps.push(...placementSteps);

  // Locators along the form, when the source reports them (the stub and the real server both do).
  if (session.locators) {
    for (const occ of plan.timeline) {
      const name = locatorName(plan.timeline, occ);
      if (!session.locators.some((l) => near(l.time, occ.startBeat))) steps.push({ type: "createLocator", name, atBeat: occ.startBeat });
    }
  }

  return { tracks, slots, placements: placementsOut, steps, notes };
}

/** True when every downloaded slot is in Live with all its placements. */
export function fullyArranged(status: DawStatus): boolean {
  return status.steps.length === 0 && status.slots.some((s) => s.state === "in-live");
}
