import { z } from "zod";

/**
 * One line of an append-only log, whatever aggregate it belongs to.
 *
 * `seq` is dense per log and only ever grows, so reopening a log means
 * continuing past the largest number already on disk — including one on a line
 * that no longer parses, which still occupies its place in the file.
 */
export interface LogEntry<E> {
  seq: number;
  at: number;
  event: E;
}

/** The on-disk schema for one line of a log carrying `event`. */
export function logEntrySchema<S extends z.ZodTypeAny>(event: S) {
  return z.object({
    seq: z.number().int().nonnegative(),
    at: z.number(),
    event,
  });
}

/** One arm of a `type`-discriminated union: an object whose tag is a literal. */
interface TaggedOption<T extends string> {
  shape: { type: { value: T } };
}

/**
 * Every `type` in a discriminated event union, read off the union itself so a
 * hand-written list of names cannot fall behind the schema that defines them.
 * The app subscribes one SSE listener per name.
 */
export function eventTypesOf<T extends string>(union: { options: readonly TaggedOption<T>[] }): readonly T[] {
  return union.options.map((option) => option.shape.type.value);
}

/** How a folded list of documents is keyed and ordered. */
export interface DocumentKeys<T> {
  idOf: (doc: T) => string;
  /** Numeric sort key; the list keeps the largest first. */
  sortKey: (doc: T) => number;
}

/**
 * Create or replace `next` in a list keyed by id, largest sort key first.
 *
 * Returns the **same array reference** when the list already holds an equal
 * document — the `applyMateEvent` discipline. It is what lets a page patch its
 * own write in locally and then fold the event mate streams back without the
 * write landing twice, and why the comparison is structural rather than by
 * identity: the two copies arrive by different routes and are never the same
 * object.
 *
 * Order is `sortKey` descending with the id as a tie-break. Two documents can
 * be created in the same millisecond, and a list that reshuffles itself under a
 * re-fold is a list the app cannot render stably.
 */
export function upsertById<T>(items: readonly T[], next: T, keys: DocumentKeys<T>): readonly T[] {
  const id = keys.idOf(next);
  const existing = items.find((item) => keys.idOf(item) === id);
  if (existing !== undefined && sameDocument(existing, next)) return items;
  return [...items.filter((item) => keys.idOf(item) !== id), next].sort(
    (a, b) => keys.sortKey(b) - keys.sortKey(a) || compareIds(keys.idOf(a), keys.idOf(b)),
  );
}

/** Drop a document by id, or return the same reference when it was never there. */
export function removeById<T>(items: readonly T[], id: string, idOf: (doc: T) => string): readonly T[] {
  const next = items.filter((item) => idOf(item) !== id);
  return next.length === items.length ? items : next;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Structural equality over the JSON these documents are. Key *order* must not
 * decide it: one side came back through `JSON.parse` of an HTTP response and
 * the other through a zod parse, and stringifying both would call two identical
 * bands different.
 */
function sameDocument(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameDocument(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameDocument(left[key], right[key]));
}
