import { BandSchema } from "@aibleton/protocol";
import type { Band } from "@aibleton/protocol";
import { DocumentStore } from "./document-store.ts";
import { isValidDocumentId } from "./ids.ts";

/** True when `id` is safe to use as a band filename. */
export function isValidBandId(id: string): boolean {
  return isValidDocumentId(id);
}

export interface BandStoreOptions {
  /** Directory holding one `<id>.json` per band. Created lazily. */
  dir: string;
}

/**
 * File-backed band storage: one JSON file per band.
 *
 * Everything is validated with `BandSchema` on the way in and on the way out,
 * so a hand-edited or corrupt file on disk is skipped rather than thrown.
 * `createdAt` always comes from the caller; the store never reads the clock.
 */
export class BandStore extends DocumentStore<Band> {
  constructor(opts: BandStoreOptions) {
    super({
      dir: opts.dir,
      schema: BandSchema,
      idOf: (band) => band.id,
      kind: "band",
      sortKey: (band) => band.createdAt,
    });
  }
}
