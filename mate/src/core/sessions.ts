import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { JournalEntry } from "@aibleton/protocol";
import { z } from "zod";
import { silentLogger, type Logger } from "../log.ts";
import { newId } from "./commands.ts";
import { isValidDocumentId } from "./document-store.ts";
import { SessionJournal, readJournal } from "./journal.ts";

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
    const read = await readJournal(path);
    if (read.skipped > 0) this.log.warn(`session ${id}: skipped ${read.skipped} unreadable journal line(s)`);
    if (read.truncated) this.log.warn(`session ${id}: the journal ends mid-line; the last event was lost`);

    // `lastSeq` is the larger of what the file says and what the metadata
    // remembers: a torn tail loses its line but must not give its number away.
    const lastSeq = Math.max(read.lastSeq, meta.lastSeq);
    const journal = new SessionJournal({ path, startSeq: lastSeq + 1, startBytes: read.bytes, log: this.log });
    return { meta: { ...meta, lastSeq }, entries: read.entries, journal, skipped: read.skipped, truncated: read.truncated };
  }

  /**
   * The session mate left behind, or a new one when there is none. Always
   * leaves `current.json` naming what it returned.
   */
  async openCurrent(): Promise<OpenSession> {
    await this.ensureDir();
    const id = await this.currentId();
    if (id && (await this.readMeta(id))) return this.open(id);
    if (id) this.log.warn(`current session ${id} is gone; starting a new one`);
    const meta = await this.create();
    await this.setCurrent(meta.id);
    return this.open(meta.id);
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
