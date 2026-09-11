import { appendFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { silentLogger, type Logger } from "../log.ts";
import type { DocumentStore } from "./document-store.ts";
import type { EventBus } from "./events.ts";
import { assertValidDocumentId } from "./ids.ts";
import { EventJournal, readJournal } from "./journal.ts";

export interface LibraryOptions<T, E extends { type: string }, J> {
  /** The aggregate's bus. Every applied event is emitted on it, and nothing else is. */
  events: EventBus<E>;
  /** One `<id>.json` per document: the **projection**, rebuilt from the log at every open. */
  docs: DocumentStore<T>;
  /** The log itself, e.g. `.mate/library/bands.jsonl`. Its directory is created lazily. */
  path: string;
  /** The one fold, shared with the replay and the app. */
  fold: (docs: readonly T[], event: E) => readonly T[];
  /** The event a wholesale write is. */
  saved: (doc: T) => E;
  /** The event a removal is. */
  deleted: (id: string) => E;
  /** The durable projection of an event; `null` for one that is never written down. */
  toJournaled: (event: E) => J | null;
  /** The event a log line stands for. */
  fromJournaled: (event: J) => E;
  /** The schema `readJournal` parses each line's `event` with. */
  eventSchema: ZodType<J, ZodTypeDef, unknown>;
  /**
   * The id an event names, or `null` when it names none. Reconcile folds this
   * over the **raw** entries, so an id the log deleted stays *known* — that is
   * what tells a leftover record file apart from one the log has never heard of.
   */
  mentions: (event: E) => string | null;
  /** Pulls the id — and therefore the filename — out of a document. */
  idOf: (doc: T) => string;
  /** When the document was made. Adoption replays in this order and stamps it as the entry's `at`. */
  createdAt: (doc: T) => number;
  /** Validates on the way in. The one `.parse` every copy of the document is normalised by. */
  schema: ZodType<T, ZodTypeDef, unknown>;
  /** Noun used in messages and id errors, e.g. `"band"`. */
  kind: string;
  /** The only clock the library has; it never reads the system one. */
  now: () => number;
  log?: Logger;
}

/** What an open found and did. Read it to log `adopted n of m` at boot. */
export interface LibraryBoot<J> {
  /** Open at `lastSeq + 1`, so nothing it writes can collide with what is already there. */
  journal: EventJournal<J>;
  /** Log entries folded into the state. */
  replayed: number;
  /** Record files turned into log entries: the backfill, plus every hand edit that won. */
  adopted: number;
  /** Projection files rewritten from the fold, plus stale ones an explicit delete removed. */
  repaired: number;
  /** Log lines the reader dropped as corrupt. */
  skipped: number;
  /** The log ended mid-line, which is what a crash during a write leaves behind. */
  truncated: boolean;
}

/** An open library: the store, what the open found, and the two ways to shut it down. */
export interface OpenLibrary<T, E extends { type: string }, J> extends LibraryBoot<J> {
  store: LibraryStore<T, E, J>;
  /** Wait for everything appended so far to reach the file. */
  close(): Promise<void>;
  /** The blocking last resort, for `process.on("exit")`. A no-op here; see `LibraryStore.flushSync`. */
  flushSync(): void;
}

/**
 * A global, event-sourced library of one kind of document.
 *
 * **The log is the truth.** The `<id>.json` files are a rebuildable projection:
 * every open replays the log, then reconciles the record directory against it.
 * Reads never touch the disk — they come off the in-memory fold, the same fold
 * a replay runs and the same one the app runs over the SSE stream, so the three
 * pictures cannot drift.
 *
 * `list()` and `get()` return promises although nothing under them awaits the
 * disk. That is deliberate: every caller already spells them `await`, and the
 * promise is also where a read parks until the open finishes, which is what
 * lets a library be constructed synchronously.
 *
 * **No lock.** `claimCurrent`'s `link()` exists to solve *minting* — two boots
 * inventing different session ids. A global log has nothing to mint: the path
 * is a constant. Two mates appending interleave whole lines, duplicate some
 * `seq` values, and converge on the next single boot, because every event is a
 * wholesale save keyed by id. There is no sensible loser branch either:
 * refusing to boot is worse under `--watch`, and running without a log loses
 * durability silently. If one were ever wanted it would be the session shape —
 * `link()` a `bands.jsonl.lock` beside the log at open, `unlink` it in `close`,
 * and treat a stale lock older than a boot as abandoned — and it would buy
 * ordering, not correctness.
 */
export class LibraryStore<T, E extends { type: string }, J = E> {
  private readonly opts: LibraryOptions<T, E, J>;
  private readonly log: Logger;
  private state: readonly T[] = [];
  private journal: EventJournal<J> | null = null;

  /** What the open found. Resolves once the library is readable; rejects when the open failed. */
  readonly opened: Promise<LibraryBoot<J>>;
  private readonly ready: Promise<void>;

  constructor(opts: LibraryOptions<T, E, J>) {
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
    // The open starts here rather than in a factory so a library can be built
    // by a synchronous caller — `songServiceHarness` is synchronous and its
    // docblock promises that. Every read parks behind `ready`.
    this.opened = this.boot();
    this.ready = this.opened.then(() => undefined);
    // Nothing is awaiting either promise yet, and a rejection nobody has
    // reached for is not an unhandled one. Every real `await` still sees it.
    void this.opened.catch(() => {});
    void this.ready.catch(() => {});
  }

  /**
   * The aggregate's bus, the one `LibraryOptions` was given. Public for the
   * same reason `StateStore.events` is: the SSE route subscribes to it, and a
   * library is the only thing that knows which bus it emits on.
   */
  get events(): EventBus<E> {
    return this.opts.events;
  }

  /** Every document, newest first. */
  async list(): Promise<T[]> {
    await this.ready;
    return [...this.state];
  }

  /** The document, or `null` when there is none. @throws on a bad id. */
  async get(id: string): Promise<T | null> {
    await this.ready;
    assertValidDocumentId(id, this.opts.kind);
    return this.find(id);
  }

  /**
   * Whether the fold holds `id` **right now**. Synchronous, so before the open
   * settles it answers about an empty library; `get` is the one that waits.
   */
  has(id: string): boolean {
    return this.find(id) !== null;
  }

  /** The fold as it stands, for a snapshot frame. Never copied, never mutated. */
  all(): readonly T[] {
    return this.state;
  }

  /**
   * Create or replace a document. The order below **is** the design:
   *
   * 1. `schema.parse` — normalise *before* appending, never after. That single
   *    parse is what keeps `metadata` defaulting to `{}` identical in the log,
   *    the projection, the HTTP response and the app's folded copy.
   * 2. assert the id, because it is about to become a filename.
   * 3. fold, then emit — a subscriber reading the store from inside `emit()`
   *    sees the state the event describes — then **await the append and let it
   *    reject**, so a write that did not reach the log is a 500 and not a 200
   *    with nothing written. The fold is already ahead of the log when that
   *    happens; the next open puts them back together.
   * 4. write the projection. A failure here is logged and swallowed: the log
   *    already has the truth and the next open rewrites the file.
   *
   * `at` is the timestamp the log entry carries and defaults to now. Adoption
   * passes the record's own `createdAt`, so the log tells the truth about what
   * it inherited.
   *
   * @throws on an invalid document, a bad id, or a failed append.
   */
  async save(doc: T, at?: number): Promise<T> {
    await this.ready;
    return this.write(doc, at ?? this.opts.now());
  }

  /**
   * Remove a document; `false` when there was none.
   *
   * A no-op delete appends **nothing**. An event that folds to nothing is a
   * line a replay pays for and learns nothing from, and — worse — it would put
   * the id in `mentioned`, which is how reconcile tells a leftover file from
   * one the log has never heard of.
   *
   * @throws on a bad id or a failed append.
   */
  async delete(id: string): Promise<boolean> {
    await this.ready;
    assertValidDocumentId(id, this.opts.kind);
    if (!this.has(id)) return false;
    await this.apply(this.opts.deleted(id), this.opts.now());
    try {
      await this.opts.docs.delete(id);
    } catch (err) {
      this.log.error(`${this.opts.kind} ${id}: removed from the log but its record file is still there`, err);
    }
    return true;
  }

  /** Resolves once everything appended so far has reached the file. */
  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    await this.journal?.flush();
  }

  /**
   * The blocking last resort, for `process.on("exit")`.
   *
   * It is a no-op for a library and that is the point: every library append is
   * awaited to disk before its caller returns, so there is never a buffered
   * tail to rescue. It exists so an exit handler can treat every journal the
   * same way.
   */
  flushSync(): void {
    this.journal?.flushSync();
  }

  private find(id: string): T | null {
    return this.state.find((doc) => this.opts.idOf(doc) === id) ?? null;
  }

  /** `save` without the park, so the open's own adoptions cannot wait on the open. */
  private async write(doc: T, at: number): Promise<T> {
    const parsed = this.opts.schema.parse(doc);
    const id = this.opts.idOf(parsed);
    assertValidDocumentId(id, this.opts.kind);
    await this.apply(this.opts.saved(parsed), at);
    try {
      await this.opts.docs.save(parsed);
    } catch (err) {
      this.log.error(`${this.opts.kind} ${id}: written to the log but its record file could not be saved`, err);
    }
    return parsed;
  }

  /** Fold, emit, append — in that order, and the append is awaited. */
  private async apply(event: E, at: number): Promise<void> {
    this.state = this.opts.fold(this.state, event);
    this.opts.events.emit(event);
    const journaled = this.opts.toJournaled(event);
    if (journaled === null) return;
    if (!this.journal) throw new Error(`no ${this.opts.kind} log is open`);
    await this.journal.appendAwaited(journaled, at);
  }

  /**
   * Replay the log, open it for appending, then reconcile the projection.
   *
   * The journal is bound **after** the replay, the same rule the session
   * journal follows and for the same reason: a restore that journaled itself
   * would double every line. There is no `restoring` flag to drift, and the
   * library does not use `attachJournal` at all — a bus subscriber's return
   * value goes nowhere, and this aggregate's whole point is that a failed
   * append reaches the caller.
   */
  private async boot(): Promise<LibraryBoot<J>> {
    const { path, kind, eventSchema, fromJournaled, mentions } = this.opts;
    await mkdir(dirname(path), { recursive: true });

    const read = await readJournal(path, eventSchema);
    if (read.skipped > 0) this.log.warn(`${kind} log: skipped ${read.skipped} unreadable line(s)`);
    let bytes = read.bytes;
    if (read.truncated) {
      this.log.warn(`${kind} log: the log ends mid-line; the last event was lost`);
      // Terminate the torn line before anything appends past it. It has no
      // newline, so the next append would glue itself onto the wreckage and be
      // lost with it — survivable for narration, not for a log that *is* the
      // data. One byte turns it into a single skipped line on the next read.
      await appendFile(path, "\n", "utf8");
      bytes += 1;
    }

    // `mentioned` is every id any entry names, including one whose delete
    // folded to nothing. A *deleted* id has to stay known, or reconcile would
    // read its leftover file as a stranger and adopt it back.
    const mentioned = new Set<string>();
    for (const entry of read.entries) {
      const event = fromJournaled(entry.event);
      this.state = this.opts.fold(this.state, event);
      const id = mentions(event);
      if (id !== null) mentioned.add(id);
    }

    this.journal = new EventJournal<J>({ path, startSeq: read.lastSeq + 1, startBytes: bytes, log: this.log });
    const { adopted, repaired } = await this.reconcile(mentioned);
    return { journal: this.journal, replayed: read.entries.length, adopted, repaired, skipped: read.skipped, truncated: read.truncated };
  }

  /**
   * The one three-way comparison between the record files, the fold, and every
   * id the log has ever named. It runs on **every** open: there is no marker
   * file and no separate migration, because "already adopted" is exactly what
   * this comparison answers. First boot over 11 untracked bands writes 11 log
   * lines; the second writes none.
   *
   * | in files | mentioned | folded | |
   * |---|---|---|---|
   * | yes | no | — | `save()` it — this **is** the backfill |
   * | yes | yes | no | the log recorded a delete; remove the stale file |
   * | no | — | yes | rewrite the missing projection file |
   * | yes | — | yes, differing | `save()` the file's version — a hand edit wins |
   * | yes | — | yes, equal | nothing |
   *
   * **Never delete a file the log has never heard of.** Only an explicitly
   * recorded delete removes a projection file; pruning orphans belongs behind a
   * separate `library:rebuild --prune`, never in a boot path. This is the rule
   * that stops a missing or unreadable log from wiping the drummer's library.
   */
  private async reconcile(mentioned: ReadonlySet<string>): Promise<{ adopted: number; repaired: number }> {
    const { kind, idOf, createdAt, saved, fold } = this.opts;
    const { files, unreadable, total } = await this.readRecords();
    for (const name of unreadable) {
      this.log.error(`${kind} record ${name} could not be read and was not adopted; the log is unchanged`);
    }

    let repaired = 0;
    const adopt: T[] = [];
    for (const [id, doc] of files) {
      if (!this.has(id)) {
        if (!mentioned.has(id)) {
          adopt.push(doc);
          continue;
        }
        // The log says this id was deleted, so the file is a leftover from a
        // restore or a hand copy. No event: the delete is already recorded.
        await this.opts.docs.delete(id);
        repaired += 1;
        this.log.info(`${kind} ${id}: removed a record file the log had already deleted`);
        continue;
      }
      // Equality is the fold's own: it returns the **same reference** when a
      // save changes nothing. That compares zod-parsed documents structurally,
      // so key order and whitespace can never cause a spurious adoption.
      if (fold(this.state, saved(doc)) !== this.state) adopt.push(doc);
    }

    for (const doc of this.state) {
      const id = idOf(doc);
      if (files.has(id)) continue;
      await this.opts.docs.save(doc);
      repaired += 1;
      this.log.info(`${kind} ${id}: rewrote a record file the log still holds`);
    }

    // Oldest first, with the id breaking a shared millisecond, so the log reads
    // in the order the library was actually built.
    adopt.sort((a, b) => createdAt(a) - createdAt(b) || compareIds(idOf(a), idOf(b)));
    let adopted = 0;
    for (const doc of adopt) {
      try {
        await this.write(doc, createdAt(doc));
        adopted += 1;
      } catch (err) {
        this.log.error(`${kind} ${idOf(doc)} could not be adopted`, err);
      }
    }

    // `n of m`, always, because `DocumentStore.list()` drops what it cannot
    // parse in silence and a count that does not match is the moment to notice.
    if (total > 0) this.log.info(`${kind}: adopted ${adopted} of ${total} record file(s)`);
    return { adopted, repaired };
  }

  /**
   * Every readable record file, by the id its **document** claims.
   *
   * The directory is read here rather than through `DocumentStore.list()`,
   * which drops a corrupt or schema-invalid file without saying so. Adoption is
   * the one place that has to name what it could not take.
   */
  private async readRecords(): Promise<{ files: Map<string, T>; unreadable: string[]; total: number }> {
    const dir = this.opts.docs.directory;
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir);
    const files = new Map<string, T>();
    const unreadable: string[] = [];
    let total = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      total += 1;
      let raw: unknown;
      try {
        raw = await Bun.file(join(dir, entry)).json();
      } catch {
        unreadable.push(entry);
        continue;
      }
      const parsed = this.opts.schema.safeParse(raw);
      if (!parsed.success) {
        unreadable.push(entry);
        continue;
      }
      const id = this.opts.idOf(parsed.data);
      // The filename is a convenience; the document's own id is the key. A file
      // that disagrees with itself is adopted under the id inside it, which is
      // the one every other copy of the document is keyed by.
      if (id !== entry.slice(0, -".json".length)) {
        this.log.warn(`${this.opts.kind} record ${entry} holds id ${JSON.stringify(id)}; adopting it under that`);
      }
      files.set(id, parsed.data);
    }
    return { files, unreadable, total };
  }
}

/**
 * Open a library: replay its log, then reconcile its record directory against
 * it. The result carries the counts worth logging at boot.
 *
 * Constructing a `LibraryStore` directly does the same thing lazily — reads
 * park until the open finishes — which is what a synchronous caller wants.
 * This is for a caller that wants to know what the open found.
 */
export async function openLibrary<T, E extends { type: string }, J>(
  opts: LibraryOptions<T, E, J>,
): Promise<OpenLibrary<T, E, J>> {
  const store = new LibraryStore(opts);
  const boot = await store.opened;
  return { store, ...boot, close: () => store.close(), flushSync: () => store.flushSync() };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
