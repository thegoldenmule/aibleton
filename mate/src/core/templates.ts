import { TemplateSchema } from "@aibleton/protocol";
import type { Template } from "@aibleton/protocol";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Ids become filenames, so they are restricted to characters that cannot escape the directory. */
const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** True when `id` is safe to use as a template filename. */
export function isValidTemplateId(id: string): boolean {
  return TEMPLATE_ID.test(id);
}

function assertValidTemplateId(id: string): void {
  if (!isValidTemplateId(id)) {
    throw new Error(
      `invalid template id ${JSON.stringify(id)}: expected 1-64 characters of A-Z, a-z, 0-9, "_" or "-"`,
    );
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

export interface TemplateStoreOptions {
  /** Directory holding one `<id>.json` per template. Created lazily. */
  dir: string;
}

/**
 * File-backed template storage: one JSON file per template.
 *
 * Everything is validated with `TemplateSchema` on the way in and on the way
 * out, so a hand-edited or corrupt file on disk is skipped rather than thrown.
 * `createdAt` always comes from the caller; the store never reads the clock.
 */
export class TemplateStore {
  private readonly dir: string;

  constructor(opts: TemplateStoreOptions) {
    this.dir = opts.dir;
  }

  /** All valid templates, newest first by `createdAt`. Unreadable files are ignored. */
  async list(): Promise<Template[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir);
    const templates: Template[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const template = await this.read(join(this.dir, entry));
      if (template) templates.push(template);
    }
    return templates.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The template, or `null` when it is missing or does not parse. @throws on a bad id. */
  async get(id: string): Promise<Template | null> {
    assertValidTemplateId(id);
    await this.ensureDir();
    return this.read(this.pathFor(id));
  }

  /** Create or overwrite a template. @throws on a bad id or an invalid template. */
  async save(template: Template): Promise<Template> {
    assertValidTemplateId(template.id);
    const parsed = TemplateSchema.parse(template);
    await this.ensureDir();
    await Bun.write(this.pathFor(parsed.id), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  /** Remove a template; `false` when it did not exist. @throws on a bad id. */
  async delete(id: string): Promise<boolean> {
    assertValidTemplateId(id);
    await this.ensureDir();
    try {
      await unlink(this.pathFor(id));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async read(path: string): Promise<Template | null> {
    let raw: unknown;
    try {
      raw = await Bun.file(path).json();
    } catch {
      return null;
    }
    const result = TemplateSchema.safeParse(raw);
    return result.success ? result.data : null;
  }
}
