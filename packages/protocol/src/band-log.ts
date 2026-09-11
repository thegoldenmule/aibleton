import { z } from "zod";
import { BandSchema, type Band } from "./bands.ts";
import { eventTypesOf, logEntrySchema, removeById, upsertById, type DocumentKeys, type LogEntry } from "./log.ts";

/**
 * What can happen to the band library. Coarse on purpose: the domain only ever
 * replaces a band wholesale, so a `saved` event carrying the whole document is
 * the honest record of the write, and nothing downstream has to reconstruct a
 * band from a patch.
 *
 * Bands are their own aggregate, not part of a session. That a song read a band
 * while being composed is incidental; folding these into a session journal
 * would rebuild a stale roster every time an old session was resumed.
 */
export const BandEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("band.saved"), band: BandSchema }),
  z.object({ type: z.literal("band.deleted"), id: z.string() }),
]);
export type BandEvent = z.infer<typeof BandEventSchema>;

/**
 * Every `BandEvent` type, derived from the union so it cannot fall behind it.
 * The app subscribes one SSE listener per name.
 */
export const BAND_EVENT_TYPES: readonly BandEvent["type"][] = eventTypesOf(BandEventSchema);

/**
 * Events that survive a restart. Both of them: the library *is* the log, so
 * losing one of these loses a band.
 */
export const DURABLE_BAND_EVENT_TYPES = ["band.saved", "band.deleted"] as const;

/**
 * Events that describe *now* and are never written down. Empty today, and the
 * list exists anyway so the guard below has two sides to choose between.
 */
export const VOLATILE_BAND_EVENT_TYPES = [] as const;

export type DurableBandEventType = (typeof DURABLE_BAND_EVENT_TYPES)[number];
export type VolatileBandEventType = (typeof VOLATILE_BAND_EVENT_TYPES)[number];

/**
 * Compile-time guard: a new `BandEvent` variant leaves `Unclassified`
 * non-empty, so this line stops typechecking until the variant is added to one
 * of the two lists above. Deciding whether an event survives a restart is not
 * something a new event may skip.
 */
type Unclassified = Exclude<BandEvent["type"], DurableBandEventType | VolatileBandEventType>;
const _exhaustive: Unclassified extends never ? true : never = true;
void _exhaustive;

/**
 * The on-disk form of a durable band event. It is identical to the live form
 * today — a `Band` is ~1 KB and has no `Song`-sized member worth paging out to
 * another store, so there is nothing to strip.
 *
 * The schema and the two functions below exist anyway. They are the seam: the
 * day one arm needs a different shape on disk, that is an edit in this file and
 * nowhere else, the way `song.changed` is journaled by id in `journal.ts`.
 */
export const JournaledBandEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("band.saved"), band: BandSchema }),
  z.object({ type: z.literal("band.deleted"), id: z.string() }),
]);
export type JournaledBandEvent = z.infer<typeof JournaledBandEventSchema>;

/** One line of `bands.jsonl`. `seq` is dense per log and only ever grows. */
export const BandLogEntrySchema = logEntrySchema(JournaledBandEventSchema);
export type BandLogEntry = LogEntry<JournaledBandEvent>;

/** The durable projection of a band event. */
export function toJournaledBand(event: BandEvent): JournaledBandEvent {
  switch (event.type) {
    case "band.saved":
      return { type: "band.saved", band: event.band };
    case "band.deleted":
      return { type: "band.deleted", id: event.id };
    default: {
      const never: never = event;
      return never;
    }
  }
}

/** The event a band log line stands for. */
export function fromJournaledBand(event: JournaledBandEvent): BandEvent {
  switch (event.type) {
    case "band.saved":
      return { type: "band.saved", band: event.band };
    case "band.deleted":
      return { type: "band.deleted", id: event.id };
    default: {
      const never: never = event;
      return never;
    }
  }
}

/** Newest band first, with the id breaking a shared millisecond. */
const BAND_KEYS: DocumentKeys<Band> = { idOf: (band) => band.id, sortKey: (band) => band.createdAt };

/**
 * The one fold of `BandEvent` into the library. Mate's store folds it, a replay
 * of `bands.jsonl` folds it and the app folds the SSE stream through it — all
 * three run this function, so the three pictures cannot drift.
 *
 * It never mutates `bands`, and returns the **same reference** when an event
 * changes nothing: a delete of an id that was never there, or a save of a band
 * deep-equal to the one already held. The app patches its own write in from the
 * mutation response *and* folds the event mate streams back, and that is what
 * makes the two converge instead of the write landing twice.
 */
export function applyBandEvent(bands: readonly Band[], event: BandEvent): readonly Band[] {
  switch (event.type) {
    case "band.saved":
      return upsertById(bands, event.band, BAND_KEYS);
    case "band.deleted":
      return removeById(bands, event.id, BAND_KEYS.idOf);
    default: {
      const never: never = event;
      void never;
      return bands;
    }
  }
}

/**
 * The whole library in one frame: the payload of the SSE `bands.snapshot` that
 * opens a stream, and — via `BandListResponseSchema` — the body of
 * `GET /bands`. One schema, so the snapshot and the REST list cannot disagree.
 */
export const BandLibrarySchema = z.object({ bands: z.array(BandSchema) });
export type BandLibrary = z.infer<typeof BandLibrarySchema>;
