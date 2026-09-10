import { fromJournaled, type JournalEntry, type MateEvent, type Song } from "@aibleton/protocol";
import { silentLogger, type Logger } from "../log.ts";
import type { SongStore } from "./songs.ts";
import type { StateStore } from "./state.ts";

export interface RestoreStoreOptions {
  /** The store to fold the journal into. Must be untouched, or freshly `reset()`. */
  store: StateStore;
  /** Everything readable in the session's journal, oldest first. */
  entries: JournalEntry[];
  /** Where the referenced song is read back from; a `Song` never rides in the journal. */
  songs: Pick<SongStore, "get">;
  log?: Logger;
}

export interface RestoreResult {
  /** Durable events replayed into the store. */
  events: number;
  /** The song the session ended on, or `null` when it had none — or when it is gone. */
  song: Song | null;
  /** The song the journal named but `SongStore` no longer holds, if any. */
  missingSongId: string | null;
}

/**
 * Replay a session's journal into a `StateStore`.
 *
 * Only the **last** `song.changed` is resolved: the song pointer is
 * last-write-wins, so every earlier reference is superseded and reading them
 * all would cost N × 57 KB for a value that is immediately overwritten. The
 * superseded entries still replay — as `song: null`, which the fold then
 * overwrites — so the event count stays honest.
 *
 * A song the journal names but that is no longer on disk is a **warning, never
 * a throw**: the transcript still tells the story, and `dawStatus` simply has
 * nothing to diff, which is the honest answer. Mate must always boot.
 */
export async function restoreStore(opts: RestoreStoreOptions): Promise<RestoreResult> {
  const log = opts.log ?? silentLogger;
  const { entries } = opts;

  // Backwards, and stop at the first one: everything before it is superseded.
  let songId: string | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const event = entries[i]!.event;
    if (event.type !== "song.changed") continue;
    songId = event.songId;
    break;
  }

  let song: Song | null = null;
  let missingSongId: string | null = null;
  if (songId !== null) {
    song = await opts.songs.get(songId);
    if (!song) {
      missingSongId = songId;
      log.warn(`the session's song ${songId} is no longer on disk; resuming without it`);
    }
  }

  // Sync by construction: the one song that matters is already in hand, and
  // every other reference resolves to null because it was overwritten anyway.
  const resolveSong = (id: string): Song | null => (song && id === song.id ? song : null);
  const events: MateEvent[] = entries.map((entry) => fromJournaled(entry.event, resolveSong));

  opts.store.restore(events);
  return { events: events.length, song, missingSongId };
}
