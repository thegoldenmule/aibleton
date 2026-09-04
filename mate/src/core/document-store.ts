import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType, ZodTypeDef } from "zod";

/** Ids become filenames, so they are restricted to characters that cannot escape the directory. */
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** True when `id` is safe to use as a document filename. */
export function isValidDocumentId(id: string): boolean {
  return DOCUMENT_ID.test(id);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/** Default ordering key: `createdAt` when it is a number, otherwise 0. */
function createdAtOf(doc: unknown): number {
  const at = (doc as { createdAt?: unknown }).createdAt;
  return typeof at === "number" ? at : 0;
}

export interface DocumentStoreOptions<T> {
  /** Directory holding one `<id>.json` per document. Created lazily. */
  dir: string;
  /**
   * Validates on the way in and on the way out. Typed as a plain `ZodType` so
   * schemas refined with `.superRefine` (i.e. `ZodEffects`) are accepted.
   */
  schema: ZodType<T, ZodTypeDef, unknown>;
  /** Pulls the id — and therefore the filename — out of a document. */
  idOf: (doc: T) => string;
  /** Noun used in id error messages, e.g. `"template"`. Defaults to `"document"`. */
  kind?: string;
  /** Numeric sort key; `list` returns the largest first. Defaults to `createdAt`. */
  sortKey?: (doc: T) => number;
}

/**
 * File-backed document storage: one JSON file per document.
 *
 * Everything is validated with the supplied schema on the way in and on the way
 * out, so a hand-edited or corrupt file on disk is skipped rather than thrown.
 * Timestamps always come from the caller; the store never reads the clock.
 */
export class DocumentStore<T> {
  private readonly dir: string;
  private readonly schema: ZodType<T, ZodTypeDef, unknown>;
  private readonly idOf: (doc: T) => string;
  private readonly kind: string;
  private readonly sortKey: (doc: T) => number;

  constructor(opts: DocumentStoreOptions<T>) {
    this.dir = opts.dir;
    this.schema = opts.schema;
    this.idOf = opts.idOf;
    this.kind = opts.kind ?? "document";
    this.sortKey = opts.sortKey ?? ((doc) => createdAtOf(doc));
  }

  /** All valid documents, largest sort key first. Unreadable files are ignored. */
  async list(): Promise<T[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir);
    const docs: T[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const doc = await this.read(join(this.dir, entry));
      if (doc) docs.push(doc);
    }
    return docs.sort((a, b) => this.sortKey(b) - this.sortKey(a));
  }

  /** The document, or `null` when it is missing or does not parse. @throws on a bad id. */
  async get(id: string): Promise<T | null> {
    this.assertValidId(id);
    await this.ensureDir();
    return this.read(this.pathFor(id));
  }

  /** Create or overwrite a document. @throws on a bad id or an invalid document. */
  async save(doc: T): Promise<T> {
    this.assertValidId(this.idOf(doc));
    const parsed = this.schema.parse(doc);
    await this.ensureDir();
    await Bun.write(this.pathFor(this.idOf(parsed)), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  /** Remove a document; `false` when it did not exist. @throws on a bad id. */
  async delete(id: string): Promise<boolean> {
    this.assertValidId(id);
    await this.ensureDir();
    try {
      await unlink(this.pathFor(id));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  private assertValidId(id: string): void {
    if (!isValidDocumentId(id)) {
      throw new Error(
        `invalid ${this.kind} id ${JSON.stringify(id)}: expected 1-64 characters of A-Z, a-z, 0-9, "_" or "-"`,
      );
    }
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async read(path: string): Promise<T | null> {
    let raw: unknown;
    try {
      raw = await Bun.file(path).json();
    } catch {
      return null;
    }
    const result = this.schema.safeParse(raw);
    return result.success ? result.data : null;
  }
}
