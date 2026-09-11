import {
  BandSchema,
  JournaledBandEventSchema,
  applyBandEvent,
  fromJournaledBand,
  toJournaledBand,
} from "@aibleton/protocol";
import type { Band, BandEvent, JournaledBandEvent } from "@aibleton/protocol";
import type { Logger } from "../log.ts";
import { DocumentStore } from "./document-store.ts";
import type { EventBus } from "./events.ts";
import { isValidDocumentId } from "./ids.ts";
import { LibraryStore, openLibrary, type LibraryOptions, type OpenLibrary } from "./library.ts";

/** True when `id` is safe to use as a band filename. */
export function isValidBandId(id: string): boolean {
  return isValidDocumentId(id);
}

export interface BandStoreOptions {
  /** Directory holding one `<id>.json` per band. Created lazily. */
  dir: string;
}

/**
 * File-backed band storage: one JSON file per band — **the projection**, not
 * the truth. `bands.jsonl` is the truth; every one of these files is
 * rebuildable from it, and `openLibrary` rebuilds the missing ones at each open.
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

/** The band library: the fold of `bands.jsonl`, with the record files behind it. */
export type BandLibrary = LibraryStore<Band, BandEvent, JournaledBandEvent>;

export interface BandLibraryOptions {
  /** Directory holding one `<id>.json` per band: the projection. */
  dir: string;
  /** The band log, `<config.libraryDir>/bands.jsonl`. Deliberately outside `dir`. */
  path: string;
  events: EventBus<BandEvent>;
  /** The only clock the library has; it never reads the system one. */
  now: () => number;
  log?: Logger;
}

/**
 * Everything `LibraryStore` needs to be a band library, in one place.
 *
 * It is exported so a synchronous caller can `new LibraryStore(...)` and let
 * the open settle in the background; `createBandLibrary` is the same thing
 * awaited. A third aggregate is one protocol file plus a copy of this function.
 */
export function bandLibraryOptions(opts: BandLibraryOptions): LibraryOptions<Band, BandEvent, JournaledBandEvent> {
  return {
    events: opts.events,
    docs: new BandStore({ dir: opts.dir }),
    path: opts.path,
    fold: applyBandEvent,
    saved: (band) => ({ type: "band.saved", band }),
    deleted: (id) => ({ type: "band.deleted", id }),
    toJournaled: toJournaledBand,
    fromJournaled: fromJournaledBand,
    eventSchema: JournaledBandEventSchema,
    mentions: (event) => (event.type === "band.saved" ? event.band.id : event.id),
    idOf: (band) => band.id,
    createdAt: (band) => band.createdAt,
    schema: BandSchema,
    kind: "band",
    now: opts.now,
    ...(opts.log ? { log: opts.log } : {}),
  };
}

/** Open the band library: replay `bands.jsonl`, then reconcile `dir` against it. */
export function createBandLibrary(opts: BandLibraryOptions): Promise<OpenLibrary<Band, BandEvent, JournaledBandEvent>> {
  return openLibrary(bandLibraryOptions(opts));
}
