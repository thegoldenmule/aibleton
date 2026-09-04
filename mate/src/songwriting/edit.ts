import { SongSchema, sampleSlotId } from "@aibleton/protocol";
import type { Song } from "@aibleton/protocol";
import { buildPlacement, buildSlot } from "./layout.ts";

/** Structural edits to a composed song. Pure; every edit re-validates through the schema. */

export class TrackNotFoundError extends Error {
  constructor(readonly partId: string) {
    super(`no track for part ${JSON.stringify(partId)}`);
  }
}

export class LastTrackError extends Error {
  constructor() {
    super("a song needs at least one track");
  }
}

export class OccurrenceNotFoundError extends Error {
  constructor(readonly occurrence: number) {
    super(`no occurrence ${occurrence} in the form`);
  }
}

/**
 * Drop a part from the song: its track, every slot and placement it owned,
 * and its entry in the song's copy of the band. Remaining tracks keep their
 * order and are re-indexed. The brief is left as the model wrote it.
 */
export function removeTrack(song: Song, partId: string): Song {
  if (!song.plan.tracks.some((t) => t.partId === partId)) throw new TrackNotFoundError(partId);
  if (song.plan.tracks.length === 1) throw new LastTrackError();
  const keep = <T extends { partId: string }>(items: readonly T[]) => items.filter((item) => item.partId !== partId);
  return SongSchema.parse({
    ...song,
    band: { ...song.band, parts: song.band.parts.filter((p) => p.id !== partId) },
    plan: {
      ...song.plan,
      tracks: keep(song.plan.tracks).map((track, index) => ({ ...track, index })),
      slots: keep(song.plan.slots),
      placements: keep(song.plan.placements),
    },
  });
}

/**
 * Bring a part in for one occurrence of the form, or rest it. Coming in
 * reuses the part's slot for that section when it has one (same sound as
 * the other occurrences) and otherwise makes a fresh, unresolved one.
 * Resting drops the placement, and the slot with it when no occurrence
 * plays it any more: its candidates and pick go, the file on disk stays.
 * A no-op when the cell is already as asked.
 */
export function setPlacement(song: Song, partId: string, occurrence: number, plays: boolean): Song {
  const part = song.band.parts.find((p) => p.id === partId);
  if (!part || !song.plan.tracks.some((t) => t.partId === partId)) throw new TrackNotFoundError(partId);
  const occ = song.plan.timeline.find((o) => o.index === occurrence);
  if (!occ) throw new OccurrenceNotFoundError(occurrence);
  const { plan } = song;
  const has = plan.placements.some((p) => p.partId === partId && p.occurrence === occurrence);
  if (has === plays) return song;

  const slotId = sampleSlotId(partId, occ.label);
  if (plays) {
    const existing = plan.slots.find((s) => s.id === slotId);
    const slot = existing ?? buildSlot(song.template, song.brief, part, occ.label);
    const placements = [...plan.placements, buildPlacement(slot, occ)].sort((a, b) => a.partId.localeCompare(b.partId) || a.occurrence - b.occurrence);
    return SongSchema.parse({ ...song, plan: { ...plan, slots: existing ? plan.slots : [...plan.slots, slot], placements } });
  }
  const placements = plan.placements.filter((p) => !(p.partId === partId && p.occurrence === occurrence));
  const stillPlayed = placements.some((p) => p.slotId === slotId);
  return SongSchema.parse({ ...song, plan: { ...plan, slots: stillPlayed ? plan.slots : plan.slots.filter((s) => s.id !== slotId), placements } });
}
