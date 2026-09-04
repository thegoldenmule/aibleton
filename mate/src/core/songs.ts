import { SongSchema, type Song } from "@aibleton/protocol";
import { DocumentStore, isValidDocumentId } from "./document-store.ts";

/** True when `id` is safe to use as a song filename. */
export function isValidSongId(id: string): boolean {
  return isValidDocumentId(id);
}

export interface SongStoreOptions {
  /** Directory holding one `<id>.json` per song. Created lazily. */
  dir: string;
}

/** File-backed song storage: one JSON file per song, newest first on list. */
export class SongStore extends DocumentStore<Song> {
  constructor(opts: SongStoreOptions) {
    super({
      dir: opts.dir,
      schema: SongSchema,
      idOf: (song) => song.id,
      kind: "song",
      sortKey: (song) => song.createdAt,
    });
  }
}
