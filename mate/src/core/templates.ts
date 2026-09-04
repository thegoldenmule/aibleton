import { TemplateSchema } from "@aibleton/protocol";
import type { Template } from "@aibleton/protocol";
import { DocumentStore, isValidDocumentId } from "./document-store.ts";

/** True when `id` is safe to use as a template filename. */
export function isValidTemplateId(id: string): boolean {
  return isValidDocumentId(id);
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
export class TemplateStore extends DocumentStore<Template> {
  constructor(opts: TemplateStoreOptions) {
    super({
      dir: opts.dir,
      schema: TemplateSchema,
      idOf: (template) => template.id,
      kind: "template",
      sortKey: (template) => template.createdAt,
    });
  }
}
