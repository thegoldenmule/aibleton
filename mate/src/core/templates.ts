import {
  JournaledTemplateEventSchema,
  TemplateSchema,
  applyTemplateEvent,
  fromJournaledTemplate,
  toJournaledTemplate,
} from "@aibleton/protocol";
import type { JournaledTemplateEvent, Template, TemplateEvent } from "@aibleton/protocol";
import type { Logger } from "../log.ts";
import { DocumentStore } from "./document-store.ts";
import type { EventBus } from "./events.ts";
import { isValidDocumentId } from "./ids.ts";
import { LibraryStore, openLibrary, type LibraryOptions, type OpenLibrary } from "./library.ts";

/** True when `id` is safe to use as a template filename. */
export function isValidTemplateId(id: string): boolean {
  return isValidDocumentId(id);
}

export interface TemplateStoreOptions {
  /** Directory holding one `<id>.json` per template. Created lazily. */
  dir: string;
}

/**
 * File-backed template storage: one JSON file per template — **the
 * projection**, not the truth. `templates.jsonl` is the truth; every one of
 * these files is rebuildable from it, and `openLibrary` rebuilds the missing
 * ones at each open.
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

/** The template library: the fold of `templates.jsonl`, with the record files behind it. */
export type TemplateLibrary = LibraryStore<Template, TemplateEvent, JournaledTemplateEvent>;

export interface TemplateLibraryOptions {
  /** Directory holding one `<id>.json` per template: the projection. */
  dir: string;
  /** The template log, `<config.libraryDir>/templates.jsonl`. Deliberately outside `dir`. */
  path: string;
  events: EventBus<TemplateEvent>;
  /** The only clock the library has; it never reads the system one. */
  now: () => number;
  log?: Logger;
}

/**
 * Everything `LibraryStore` needs to be a template library, in one place. The
 * band mirror, and deliberately a copy rather than a shared factory: the
 * aggregates will diverge, and ~30 lines of declaration is not machinery.
 */
export function templateLibraryOptions(
  opts: TemplateLibraryOptions,
): LibraryOptions<Template, TemplateEvent, JournaledTemplateEvent> {
  return {
    events: opts.events,
    docs: new TemplateStore({ dir: opts.dir }),
    path: opts.path,
    fold: applyTemplateEvent,
    saved: (template) => ({ type: "template.saved", template }),
    deleted: (id) => ({ type: "template.deleted", id }),
    toJournaled: toJournaledTemplate,
    fromJournaled: fromJournaledTemplate,
    eventSchema: JournaledTemplateEventSchema,
    mentions: (event) => (event.type === "template.saved" ? event.template.id : event.id),
    idOf: (template) => template.id,
    createdAt: (template) => template.createdAt,
    schema: TemplateSchema,
    kind: "template",
    now: opts.now,
    ...(opts.log ? { log: opts.log } : {}),
  };
}

/** Open the template library: replay `templates.jsonl`, then reconcile `dir` against it. */
export function createTemplateLibrary(
  opts: TemplateLibraryOptions,
): Promise<OpenLibrary<Template, TemplateEvent, JournaledTemplateEvent>> {
  return openLibrary(templateLibraryOptions(opts));
}
