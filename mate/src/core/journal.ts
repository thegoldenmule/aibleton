import { appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { logEntrySchema, type JournaledEvent, type LogEntry } from "@aibleton/protocol";
import type { ZodType, ZodTypeDef } from "zod";
import type { Logger } from "../log.ts";
import type { EventBus } from "./events.ts";

export interface EventJournalOptions {
  /** The `journal.jsonl` this instance appends to. Its directory must already exist. */
  path: string;
  /** The sequence number the next append takes; `readJournal`'s `lastSeq + 1`. */
  startSeq: number;
  log: Logger;
  /** Bytes already in the file, so `bytesWritten` measures the file and not just this process. */
  startBytes?: number;
}

/**
 * An append-only log of one aggregate's events, one JSON object per line.
 *
 * `EventBus.emit` is synchronous and runs on the agent loop's drain stack, so
 * `append` must never await: it stringifies, buffers, and kicks a drain if one
 * is not already running. A single promise chain is the only writer, and each
 * drain writes everything buffered as **one** string — a compose narrating a
 * dozen transcript lines in one tick costs one syscall, not a dozen.
 *
 * There is no fsync per event, and there does not need to be: whole-line
 * `appendFile` writes never interleave, so the only way to get a partial line
 * is a crash mid-write, which `readJournal` reports as `truncated`.
 *
 * A write error is logged once and then the journal degrades to a no-op. A full
 * disk must not stop the drummer's session.
 */
export class EventJournal<J> {
  private readonly path: string;
  private readonly log: Logger;
  private readonly buffer: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  private draining = false;
  private nextSeq: number;
  private bytes: number;
  private broken = false;

  constructor(opts: EventJournalOptions) {
    this.path = opts.path;
    this.log = opts.log;
    this.nextSeq = opts.startSeq;
    this.bytes = opts.startBytes ?? 0;
  }

  /** Buffer one event for writing. Never awaits, never throws. */
  append(event: J, at: number): void {
    if (this.broken) return;
    const entry: LogEntry<J> = { seq: this.nextSeq, at, event };
    this.nextSeq += 1;
    this.buffer.push(`${JSON.stringify(entry)}\n`);
    this.kick();
  }

  /**
   * Append one event and resolve **only once the line is on disk**, rejecting
   * when the write fails.
   *
   * `append` is right for narration: it buffers, coalesces, and degrades to a
   * no-op so a full disk cannot stop the drummer's session. A library log *is*
   * the data, and the worst thing that aggregate can do is answer `POST /bands`
   * with 200 and nothing written, so this path reports rather than degrades —
   * the one deliberate deviation from the session journal.
   *
   * It still queues behind whatever `append` has in flight, so a journal that
   * is used both ways cannot interleave half a line. A failure does not poison
   * the chain: the caller is already being told about it, and a later append
   * must not fail silently because an earlier one did.
   */
  async appendAwaited(event: J, at: number): Promise<void> {
    await this.appendAllAwaited([event], at);
  }

  /**
   * Append several events as **one** commit, resolving only once the lines are
   * on disk and rejecting when the write fails.
   *
   * They take a consecutive run of `seq` and share one `tail` link, so no other
   * appender — buffered or awaited — can put a line between them: a burst that
   * only makes sense whole, like the three bands a new genre is rolled from,
   * arrives whole or not at all. One `appendFile` is the largest indivisible
   * write this process has; a crash inside it leaves the torn tail `readJournal`
   * already reports.
   */
  async appendAllAwaited(events: readonly J[], at: number): Promise<void> {
    if (events.length === 0) return;
    let chunk = "";
    for (const event of events) {
      const entry: LogEntry<J> = { seq: this.nextSeq, at, event };
      this.nextSeq += 1;
      chunk += `${JSON.stringify(entry)}\n`;
    }
    const write = this.tail.then(async () => {
      await appendFile(this.path, chunk, "utf8");
      this.bytes += Buffer.byteLength(chunk, "utf8");
    });
    this.tail = write.catch(() => undefined);
    await write;
  }

  /** Resolves once everything appended so far has reached the file. */
  async flush(): Promise<void> {
    while (!this.broken && (this.buffer.length > 0 || this.draining)) {
      this.kick();
      await this.tail;
    }
  }

  /**
   * The buffered tail, written with one blocking append. **Last resort**, for
   * `process.on("exit")`, where the process is already leaving and a promise
   * will never be resolved again — everywhere else, `flush`.
   *
   * A drain already in flight is not waited for and cannot be: its chunk left
   * the buffer, and whether it reached the file is now up to the write that is
   * already running. It is not a lost line either way — this appends only what
   * is still buffered, so nothing is written twice, and `seq` keeps the order
   * a gap would otherwise hide.
   */
  flushSync(): void {
    if (this.broken || this.buffer.length === 0) return;
    const chunk = this.buffer.join("");
    this.buffer.length = 0;
    try {
      appendFileSync(this.path, chunk, "utf8");
      this.bytes += Buffer.byteLength(chunk, "utf8");
    } catch (err) {
      this.broken = true;
      this.log.error(`journal ${this.path} is no longer being written`, err);
    }
  }

  /** The sequence number the next `append` will use. */
  seq(): number {
    return this.nextSeq;
  }

  /** Size of the journal file, counting what was in it when this instance opened it. */
  bytesWritten(): number {
    return this.bytes;
  }

  private kick(): void {
    if (this.draining || this.buffer.length === 0) return;
    this.draining = true;
    this.tail = this.tail.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    try {
      // Re-checked after every await: appends that land mid-write join this
      // same drain rather than queueing another one.
      while (this.buffer.length > 0) {
        const chunk = this.buffer.join("");
        this.buffer.length = 0;
        await appendFile(this.path, chunk, "utf8");
        this.bytes += Buffer.byteLength(chunk, "utf8");
      }
    } catch (err) {
      this.broken = true;
      this.buffer.length = 0;
      this.log.error(`journal ${this.path} is no longer being written`, err);
    } finally {
      this.draining = false;
    }
  }
}

/**
 * The session's journal. The alias keeps the name every type position in
 * `sessions.ts` already uses; the aggregate is all that distinguishes it.
 */
export type SessionJournal = EventJournal<JournaledEvent>;

export interface ReadJournalResult<J> {
  entries: LogEntry<J>[];
  /** Lines that did not parse and were dropped. Corruption, not a torn tail. */
  skipped: number;
  /**
   * The largest `seq` *seen*, including on a skipped line, so reopening the
   * journal cannot hand out a number that is already on disk. `0` for a journal
   * with nothing readable in it; the first append is then `1`.
   */
  lastSeq: number;
  /** The file ends mid-line, which is what a crash during a write leaves behind. */
  truncated: boolean;
  /** Size of the file on disk, for `EventJournal`'s byte counter. */
  bytes: number;
}

function empty<J>(): ReadJournalResult<J> {
  return { entries: [], skipped: 0, lastSeq: 0, truncated: false, bytes: 0 };
}

/**
 * Every readable entry in a journal, oldest first. A missing file is an empty
 * result, not an error — a log that has never been written to is a valid log.
 *
 * `schema` is the aggregate's event schema and is required, not defaulted: this
 * module never names a concrete one.
 */
export async function readJournal<J>(path: string, schema: ZodType<J, ZodTypeDef, unknown>): Promise<ReadJournalResult<J>> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return empty();
  }
  if (raw.length === 0) return empty();

  // Built once, not per line: the entry schema is the same for every line in
  // the file and composing it 10,000 times is pure waste.
  const entrySchema = logEntrySchema(schema);

  const lines = raw.split("\n");
  // A complete file ends with a newline, which leaves one empty tail element.
  // Anything else means the last line was cut off part-written.
  const unterminated = lines.at(-1) !== "";
  if (!unterminated) lines.pop();

  const entries: LogEntry<J>[] = [];
  let skipped = 0;
  let lastSeq = 0;
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const { entry, seq } = parseLine(line, entrySchema);
    // `lastSeq` is the largest number *seen*, not `entries.length`: a line that
    // was skipped still occupies its sequence number on disk, and reusing it
    // would put two entries with the same `seq` in one file.
    if (seq !== null && seq > lastSeq) lastSeq = seq;
    if (!entry) {
      // The last line is special: an unterminated final line is a torn write,
      // not corruption, and there is nothing to repair — the entry never
      // finished being an event.
      if (unterminated && i === lines.length - 1) truncated = true;
      else skipped += 1;
      continue;
    }
    entries.push(entry);
  }

  return { entries, skipped, lastSeq, truncated, bytes: Buffer.byteLength(raw, "utf8") };
}

/** The entry a line holds, plus whatever sequence number it claims either way. */
function parseLine<J>(line: string, schema: ZodType<LogEntry<J>, ZodTypeDef, unknown>): { entry: LogEntry<J> | null; seq: number | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { entry: null, seq: null };
  }
  const claimed = (raw as { seq?: unknown } | null)?.seq;
  const seq = typeof claimed === "number" && Number.isFinite(claimed) ? claimed : null;
  const parsed = schema.safeParse(raw);
  return { entry: parsed.success ? parsed.data : null, seq };
}

/**
 * Write every durable event the bus carries to `journal`. Returns the detach.
 *
 * It subscribes to the **bus**, not the store: `action.applied` and `cancelled`
 * are emitted straight onto the bus by `EffectRunner` and never pass through a
 * setter. Attaching it *after* a replay is also what stops a restore from
 * re-journaling itself — there is no `restoring` flag to drift.
 *
 * `toJournaled` is the aggregate's own durable projection, passed in rather
 * than imported so one bus cannot end up classifying another's events.
 */
export function attachJournal<E extends { type: string }, J>(
  events: EventBus<E>,
  journal: EventJournal<J>,
  toJournaled: (event: E) => J | null,
  now: () => number,
): () => void {
  return events.subscribe((event) => {
    const journaled = toJournaled(event);
    if (journaled) journal.append(journaled, now());
  });
}
