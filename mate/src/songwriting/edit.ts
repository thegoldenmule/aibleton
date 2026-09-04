import { SongSchema } from "@aibleton/protocol";
import type { Song } from "@aibleton/protocol";

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
