import { link, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { JournaledEventSchema, toJournaled, type JournalEntry, type JournaledEvent, type MateEvent, type SessionSummary, type StateResponse } from "@aibleton/protocol";
import { z } from "zod";
import { silentLogger, type Logger } from "../log.ts";
import { contextFromState } from "../intelligence/loop.ts";
import type { Intelligence } from "../intelligence/types.ts";
import { newId } from "./commands.ts";
import { isValidDocumentId } from "./document-store.ts";
import type { EventBus } from "./events.ts";
import { EventJournal, attachJournal, readJournal, type SessionJournal } from "./journal.ts";
import { restoreStore } from "./restore.ts";
import type { SongStore } from "./songs.ts";
import type { StateStore } from "./state.ts";

/** True when `id` is safe to use as a session directory name. */
export function isValidSessionId(id: string): boolean {
  return isValidDocumentId(id);
}

/** `<dir>/<id>/session.json`: everything about a session except what happened in it. */
export const SessionMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The highest sequence number in the journal, so a reopen continues past it. */
  lastSeq: z.number().int().nonnegative().default(0),
  /** The model that wrote the brain conversation, stamped so a resume knows what it is replaying. */
  model: z.string().nullable().default(null),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

/** `<dir>/current.json`: which session mate resumes on the next boot. */
const CurrentSchema = z.object({ id: z.string(), at: z.number() });

const SESSION_FILE = "session.json";
const JOURNAL_FILE = "journal.jsonl";
const CURRENT_FILE = "current.json";

/** A session, its history, and the journal appending to it. */
export interface OpenSession {
  meta: SessionMeta;
  /** Everything readable in the journal, oldest first: what a restore replays. */
  entries: JournalEntry[];
  /** Open at `lastSeq + 1`, so nothing it writes can collide with what is already there. */
  journal: SessionJournal;
  /** Lines the reader dropped as corrupt. */
  skipped: number;
  /** The journal ended mid-line, which is what a crash during a write leaves behind. */
  truncated: boolean;
}

export interface SessionStoreOptions {
  /** Directory holding `current.json` and one subdirectory per session. Created lazily. */
  dir: string;
  /** The only clock the store has; it never reads the system one. */
  now: () => number;
  log?: Logger;
}

/**
 * The session library on disk: one **directory** per session, holding its
 * metadata and its journal.
 *
 * `DocumentStore` is deliberately not subclassed — it writes a flat
 * `<dir>/<id>.json`, and a session is a directory, so deleting one is a single
 * subtree removal rather than two removes across two trees. Its contract is
 * kept all the same: zod in and out, a corrupt file skipped rather than thrown,
 * and timestamps always from the injected `now`. `isValidDocumentId` **is**
 * reused, because ids become path segments and that is the part that matters.
 *
 * Journal compaction is deliberately deferred, not forgotten. The fold already
 * caps at 200 transcript entries and 50 commands, so anything past that is
 * written and then discarded on replay: the cost is disk and a linear pass, not
 * correctness. `SessionJournal.bytesWritten()` and `config.journalCompactBytes`
 * are here so the decision can be made from a measurement; when compaction
 * lands it belongs at open time only — fold, write a minimal prefix to
 * `journal.jsonl.tmp`, `rename` over the original — so there is no
 * reader/writer race at all.
 */
export class SessionStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(opts: SessionStoreOptions) {
    this.dir = opts.dir;
    this.now = opts.now;
    this.log = opts.log ?? silentLogger;
  }

  /** Every readable session, most recently updated first. */
  async list(): Promise<SessionMeta[]> {
    await this.ensureDir();
    // Only subdirectories are sessions, which is also what keeps `current.json`
    // out of the list.
    const entries = await readdir(this.dir, { withFileTypes: true });
    const sessions: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
      const meta = await this.readMeta(entry.name);
      if (meta) sessions.push(meta);
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The session, or `null` when it is missing or does not parse. @throws on a bad id. */
  async get(id: string): Promise<SessionMeta | null> {
    this.assertValidId(id);
    return this.readMeta(id);
  }

  /** Create or overwrite a session's metadata. @throws on a bad id or invalid metadata. */
  async save(meta: SessionMeta): Promise<SessionMeta> {
    this.assertValidId(meta.id);
    const parsed = SessionMetaSchema.parse(meta);
    await mkdir(this.dirFor(parsed.id), { recursive: true });
    await Bun.write(join(this.dirFor(parsed.id), SESSION_FILE), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  /** A new, empty session. Does not make it current — `setCurrent` does that. */
  async create(opts: { name?: string; id?: string } = {}): Promise<SessionMeta> {
    const at = this.now();
    const id = opts.id ?? newId("ses");
    return this.save({
      id,
      name: opts.name?.trim() || defaultName(at),
      createdAt: at,
      updatedAt: at,
      lastSeq: 0,
      model: null,
    });
  }

  /** Remove a session and its journal; `false` when there was nothing there. @throws on a bad id. */
  async delete(id: string): Promise<boolean> {
    this.assertValidId(id);
    const dir = this.dirFor(id);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) return false;
    } catch {
      return false;
    }
    await rm(dir, { recursive: true, force: true });
    // Leaving a pointer to a deleted session would mint a fresh one on the next
    // boot with no explanation; forgetting it says the same thing honestly.
    if ((await this.currentId()) === id) await rm(join(this.dir, CURRENT_FILE), { force: true });
    return true;
  }

  /** The session mate would resume, or `null` when there is none on disk. */
  async currentId(): Promise<string | null> {
    let raw: unknown;
    try {
      raw = await Bun.file(join(this.dir, CURRENT_FILE)).json();
    } catch {
      return null;
    }
    const parsed = CurrentSchema.safeParse(raw);
    if (!parsed.success || !isValidSessionId(parsed.data.id)) return null;
    return parsed.data.id;
  }

  /** Point `current.json` at a session. @throws on a bad id. */
  async setCurrent(id: string): Promise<void> {
    this.assertValidId(id);
    await this.ensureDir();
    await Bun.write(join(this.dir, CURRENT_FILE), `${JSON.stringify({ id, at: this.now() }, null, 2)}\n`);
  }

  /**
   * Read a session's journal and open it for appending. @throws on a bad id or
   * an unknown session, so a route can answer 400 and 404 separately.
   */
  async open(id: string): Promise<OpenSession> {
    this.assertValidId(id);
    const meta = await this.readMeta(id);
    if (!meta) throw new Error(`unknown session ${JSON.stringify(id)}`);
    await mkdir(this.dirFor(id), { recursive: true });

    const path = this.journalPath(id);
    const read = await readJournal(path, JournaledEventSchema);
    if (read.skipped > 0) this.log.warn(`session ${id}: skipped ${read.skipped} unreadable journal line(s)`);
    if (read.truncated) this.log.warn(`session ${id}: the journal ends mid-line; the last event was lost`);

    // `lastSeq` is the larger of what the file says and what the metadata
    // remembers: a torn tail loses its line but must not give its number away.
    const lastSeq = Math.max(read.lastSeq, meta.lastSeq);
    const journal = new EventJournal<JournaledEvent>({ path, startSeq: lastSeq + 1, startBytes: read.bytes, log: this.log });
    return { meta: { ...meta, lastSeq }, entries: read.entries, journal, skipped: read.skipped, truncated: read.truncated };
  }

  /**
   * The session mate left behind, or a new one when there is none. Always
   * leaves `current.json` naming what it returned.
   *
   * **Only one instance may mint.** `bun run --cwd mate dev` runs `--watch`, so
   * a reload routinely overlaps the outgoing process and two boots read a
   * missing `current.json` in the same millisecond. Read-then-write let both
   * mint, and the loser's session was orphaned with its own journal. The claim
   * below is therefore atomic in the filesystem, not a re-read: a loser opens
   * the winner's session and takes its own directory back with it.
   */
  async openCurrent(): Promise<OpenSession> {
    await this.ensureDir();
    const id = await this.currentId();
    if (id && (await this.readMeta(id))) return this.open(id);
    if (id) {
      this.log.warn(`current session ${id} is gone; starting a new one`);
      // The pointer names nothing, so it is not a claim anybody can lose to:
      // drop it, or the exclusive create below would refuse forever.
      await rm(join(this.dir, CURRENT_FILE), { force: true });
    }

    // Written in full *before* the claim, so whoever reads the pointer we are
    // about to publish finds a session that already exists on disk.
    const meta = await this.create();
    const winner = await this.claimCurrent(meta.id);
    if (winner === meta.id) return this.open(meta.id);

    this.log.warn(`another instance claimed session ${winner} first; discarding ${meta.id}`);
    // `newId` is a millisecond plus a *per-process* counter, so two boots in
    // the same millisecond can mint the same id. Guarded, because otherwise
    // the loser's cleanup would delete the winner's directory.
    if (meta.id !== winner) await rm(this.dirFor(meta.id), { recursive: true, force: true });
    return this.open(winner);
  }

  /**
   * Point `current.json` at `id` **only if nothing else already has**, and
   * return whoever holds it afterwards.
   *
   * `link` is the atomic part: it either creates the destination or fails with
   * `EEXIST`, never both, and it links a file that already holds the whole JSON
   * — so a loser cannot read a pointer that was created but not yet written.
   * `Bun.write` + `rename` would not do: rename overwrites, which is precisely
   * the "last writer wins" this exists to stop.
   */
  private async claimCurrent(id: string): Promise<string> {
    const target = join(this.dir, CURRENT_FILE);
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    await Bun.write(tmp, `${JSON.stringify({ id, at: this.now() }, null, 2)}\n`);
    try {
      await link(tmp, target);
      return id;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const winner = await this.currentId();
      if (winner && (await this.readMeta(winner))) return winner;
      // Something wrote a pointer to nothing between our check and our claim.
      // Nobody is resuming that, so take it rather than loop.
      await this.setCurrent(id);
      return id;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** The directory holding one session's files. */
  dirFor(id: string): string {
    return join(this.dir, id);
  }

  /** The session's append-only log. */
  journalPath(id: string): string {
    return join(this.dirFor(id), JOURNAL_FILE);
  }

  private assertValidId(id: string): void {
    if (!isValidSessionId(id)) {
      throw new Error(
        `invalid session id ${JSON.stringify(id)}: expected 1-64 characters of A-Z, a-z, 0-9, "_" or "-"`,
      );
    }
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async readMeta(id: string): Promise<SessionMeta | null> {
    let raw: unknown;
    try {
      raw = await Bun.file(join(this.dirFor(id), SESSION_FILE)).json();
    } catch {
      return null;
    }
    const parsed = SessionMetaSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
}

/** "2026-09-10 14:03" — enough for the drummer to recognise a session in a list. */
function defaultName(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 16);
}

/** What a switch leaves the caller holding: the session mate is now in, and its state. */
export interface SessionSwitch {
  session: SessionSummary;
  state: StateResponse;
  /** False when the caller asked to resume the session mate was already in. */
  switched: boolean;
}

export interface SessionManagerOptions {
  sessions: SessionStore;
  store: StateStore;
  /** The bus the journal subscribes to, and where `state.replaced` is announced. */
  events: EventBus<MateEvent>;
  /** Where a journaled song id is read back from; a `Song` never rides in the journal. */
  songs: Pick<SongStore, "get">;
  /** Reseeded with the new session's goal, request and song after every switch. */
  intelligence: Intelligence;
  /** The session boot opened, already restored into `store` and journaling. */
  session: OpenSession;
  /** The detach boot's `attachJournal` returned; the manager owns it from here. */
  detach: () => void;
  now: () => number;
  log?: Logger;
}

/**
 * Which session mate is in, and the only place that changes.
 *
 * The switch is eight ordered steps and every one of them is load-bearing, so
 * it lives here rather than in the route: the routes stay status codes, the way
 * `SongService` owns every song operation. Nothing in it touches `AbletonPort`
 * or `SplicePort` — resuming restores mate's picture of a session and never
 * says a word to Live. That is a hard invariant of the feature and this class
 * has no reference to either port with which to break it.
 */
export class SessionManager {
  private readonly sessions: SessionStore;
  private readonly store: StateStore;
  private readonly events: EventBus<MateEvent>;
  private readonly songs: Pick<SongStore, "get">;
  private readonly intelligence: Intelligence;
  private readonly now: () => number;
  private readonly log: Logger;
  private session: OpenSession;
  private detach: () => void;

  constructor(opts: SessionManagerOptions) {
    this.sessions = opts.sessions;
    this.store = opts.store;
    this.events = opts.events;
    this.songs = opts.songs;
    this.intelligence = opts.intelligence;
    this.session = opts.session;
    this.detach = opts.detach;
    this.now = opts.now;
    this.log = opts.log ?? silentLogger;
  }

  /** The session mate is in. There is always one: boot mints it when there is none. */
  currentId(): string {
    return this.session.meta.id;
  }

  /** Every session, most recently updated first. */
  async list(): Promise<SessionSummary[]> {
    // The current session's tail is buffered, so it would otherwise report one
    // event count in the list and another the moment anything else flushed it.
    await this.session.journal.flush();
    const metas = await this.sessions.list();
    const summaries: SessionSummary[] = [];
    for (const meta of metas) summaries.push(await this.summarize(meta));
    return summaries;
  }

  /** One session, or `null` when there is nothing readable under that id. @throws on a bad id. */
  async get(id: string): Promise<SessionSummary | null> {
    if (id === this.session.meta.id) await this.session.journal.flush();
    const meta = await this.sessions.get(id);
    return meta ? this.summarize(meta) : null;
  }

  /** A new, empty session, switched into. */
  async create(name?: string): Promise<SessionSwitch> {
    const meta = await this.sessions.create(name === undefined ? {} : { name });
    return { ...(await this.switchTo(meta)), switched: true };
  }

  /**
   * Leave the current session for this one. Resuming the session mate is
   * already in is a **no-op**, not an error: the app may double-fire it, and
   * flushing and replaying to arrive where we already are would only risk
   * something.
   *
   * @throws when the session does not exist; a route answers 404 before this.
   */
  async resume(id: string): Promise<SessionSwitch> {
    if (id === this.session.meta.id) {
      return { session: await this.summarize(this.session.meta), state: this.store.snapshot(), switched: false };
    }
    const meta = await this.sessions.get(id);
    if (!meta) throw new Error(`no session ${id}`);
    return { ...(await this.switchTo(meta)), switched: true };
  }

  /**
   * Remove a session and its journal. Never the current one: the journal has
   * that file open, so deleting it would leave every later append going to an
   * unlinked inode. A route answers 409 before this.
   */
  async delete(id: string): Promise<boolean> {
    if (id === this.session.meta.id) throw new Error(`session ${id} is the current one`);
    return this.sessions.delete(id);
  }

  /**
   * The tail, written with one blocking append. For `process.on("exit")` only,
   * where nothing asynchronous can still run. The metadata is deliberately not
   * saved: `open` takes `Math.max(read.lastSeq, meta.lastSeq)`, so a `lastSeq`
   * left behind by an abrupt exit is recovered from the file itself.
   */
  flushSync(): void {
    this.detach();
    this.session.journal.flushSync();
  }

  /** Shutdown: nothing more reaches the journal, the tail reaches disk, the metadata records where it got to. */
  async close(): Promise<void> {
    this.detach();
    await this.session.journal.flush();
    await this.persist(this.session);
  }

  /**
   * The switch. The order is the whole guard and none of it is decoration:
   *
   * 1. flush, so the outgoing session's tail is on disk;
   * 2. detach, so nothing from here lands in the old file;
   * 3. reset the store to boot;
   * 4. replay the new session's journal — the same `restoreStore` boot runs;
   * 5. attach the new journal **after** the replay, which is what stops the
   *    replay writing the whole session down a second time;
   * 6. record where the outgoing session got to, and point `current.json` here;
   * 7. announce `state.replaced`, which is volatile, so step 5's fresh
   *    subscription drops it rather than journaling it;
   * 8. reseed the machine's context, *including clearing* a goal, request or
   *    song the new session does not have.
   */
  private async switchTo(meta: SessionMeta): Promise<{ session: SessionSummary; state: StateResponse }> {
    // Opened first because it only reads: if the incoming journal cannot be
    // opened, nothing about the session mate is in has changed yet.
    const next = await this.sessions.open(meta.id);
    const outgoing = this.session;

    // Mate must not be mid-thought while the store is swapped underneath it. `pause` aborts an
    // in-flight brain call or action set and parks the machine, so a tick arriving during the
    // awaits below cannot start another; an aborted result is dropped rather than landing in the
    // session that just arrived. The mailbox drains synchronously, so the machine is quiet by the
    // time `submit` returns. Unconditional on purpose: an idle machine is one tick from busy, and
    // `phase` is volatile, so the pause never reaches the journal.
    this.intelligence.submit({ type: "pause" }, "api");
    try {
      return await this.swap(next, outgoing);
    } finally {
      this.intelligence.submit({ type: "resume" }, "api");
    }
  }

  /** The switch proper, between the pause and the resume. */
  private async swap(next: OpenSession, outgoing: OpenSession): Promise<{ session: SessionSummary; state: StateResponse }> {
    await outgoing.journal.flush();
    this.detach();
    this.store.reset();
    const restored = await restoreStore({ store: this.store, entries: next.entries, songs: this.songs, log: this.log });
    this.detach = attachJournal(this.events, next.journal, toJournaled, this.now);
    this.session = next;

    await this.persist(outgoing);
    await this.sessions.setCurrent(next.meta.id);
    // Touched last so the session just resumed sorts to the top of the library.
    this.session = { ...next, meta: await this.persist(next) };

    const state = this.store.snapshot();
    this.events.emit({ type: "state.replaced", state });
    this.intelligence.submit(contextFromState(state), "loop");

    this.log.info(`switched to session ${next.meta.id} (${next.meta.name}): ${restored.events} event(s)`);
    return { session: await this.summarize(this.session.meta), state };
  }

  /** Write down where a session's journal got to. A failure here must not fail the switch. */
  private async persist(session: OpenSession): Promise<SessionMeta> {
    const meta: SessionMeta = { ...session.meta, lastSeq: session.journal.seq() - 1, updatedAt: this.now() };
    try {
      return await this.sessions.save(meta);
    } catch (err) {
      this.log.warn(`could not save session ${meta.id}`, err);
      return meta;
    }
  }

  /** Read a session's journal for the two things that make its row readable. */
  private async summarize(meta: SessionMeta): Promise<SessionSummary> {
    const read = await readJournal(this.sessions.journalPath(meta.id), JournaledEventSchema);
    return summarizeSession(meta, read.entries);
  }
}

/**
 * A session's row, folded from its journal. `preview` is the **first** thing
 * the drummer said and `songId` the **last** song it held: the one says what
 * the session was for, the other where it got to.
 */
export function summarizeSession(meta: SessionMeta, entries: readonly JournalEntry[]): SessionSummary {
  let preview: string | null = null;
  let songId: string | null = null;
  for (const { event } of entries) {
    if (preview === null && event.type === "transcript.appended" && event.entry.role === "user" && event.entry.kind === "request") {
      preview = event.entry.text;
    }
    if (event.type === "song.changed") songId = event.songId;
  }
  return {
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    events: entries.length,
    songId,
    preview,
  };
}
