import { z } from "zod";
import { eventTypesOf, logEntrySchema, removeById, upsertById, type DocumentKeys, type LogEntry } from "./log.ts";
import { TemplateSchema, type Template } from "./templates.ts";

/**
 * What can happen to the template library. Coarse on purpose: the domain only
 * ever replaces a template wholesale, so a `saved` event carrying the whole
 * document is the honest record of the write, and nothing downstream has to
 * reconstruct a template from a patch.
 *
 * Templates are their own aggregate, not part of a session, for the same reason
 * bands are: a song embeds a copy of the template it was composed from, which
 * is a snapshot of what it used, not a reference into this log.
 */
export const TemplateEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("template.saved"), template: TemplateSchema }),
  z.object({ type: z.literal("template.deleted"), id: z.string() }),
]);
export type TemplateEvent = z.infer<typeof TemplateEventSchema>;

/**
 * Every `TemplateEvent` type, derived from the union so it cannot fall behind
 * it. The app subscribes one SSE listener per name.
 */
export const TEMPLATE_EVENT_TYPES: readonly TemplateEvent["type"][] = eventTypesOf(TemplateEventSchema);

/**
 * Events that survive a restart. Both of them: the library *is* the log, so
 * losing one of these loses a template.
 */
export const DURABLE_TEMPLATE_EVENT_TYPES = ["template.saved", "template.deleted"] as const;

/**
 * Events that describe *now* and are never written down. Empty today, and the
 * list exists anyway so the guard below has two sides to choose between.
 */
export const VOLATILE_TEMPLATE_EVENT_TYPES = [] as const;

export type DurableTemplateEventType = (typeof DURABLE_TEMPLATE_EVENT_TYPES)[number];
export type VolatileTemplateEventType = (typeof VOLATILE_TEMPLATE_EVENT_TYPES)[number];

/**
 * Compile-time guard: a new `TemplateEvent` variant leaves `Unclassified`
 * non-empty, so this line stops typechecking until the variant is added to one
 * of the two lists above. Deciding whether an event survives a restart is not
 * something a new event may skip.
 */
type Unclassified = Exclude<TemplateEvent["type"], DurableTemplateEventType | VolatileTemplateEventType>;
const _exhaustive: Unclassified extends never ? true : never = true;
void _exhaustive;

/**
 * The on-disk form of a durable template event. It is identical to the live
 * form today — a `Template` is small and has no `Song`-sized member worth
 * paging out to another store, so there is nothing to strip.
 *
 * The schema and the two functions below exist anyway. They are the seam: the
 * day one arm needs a different shape on disk, that is an edit in this file and
 * nowhere else, the way `song.changed` is journaled by id in `journal.ts`.
 */
export const JournaledTemplateEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("template.saved"), template: TemplateSchema }),
  z.object({ type: z.literal("template.deleted"), id: z.string() }),
]);
export type JournaledTemplateEvent = z.infer<typeof JournaledTemplateEventSchema>;

/** One line of `templates.jsonl`. `seq` is dense per log and only ever grows. */
export const TemplateLogEntrySchema = logEntrySchema(JournaledTemplateEventSchema);
export type TemplateLogEntry = LogEntry<JournaledTemplateEvent>;

/** The durable projection of a template event. */
export function toJournaledTemplate(event: TemplateEvent): JournaledTemplateEvent {
  switch (event.type) {
    case "template.saved":
      return { type: "template.saved", template: event.template };
    case "template.deleted":
      return { type: "template.deleted", id: event.id };
    default: {
      const never: never = event;
      return never;
    }
  }
}

/** The event a template log line stands for. */
export function fromJournaledTemplate(event: JournaledTemplateEvent): TemplateEvent {
  switch (event.type) {
    case "template.saved":
      return { type: "template.saved", template: event.template };
    case "template.deleted":
      return { type: "template.deleted", id: event.id };
    default: {
      const never: never = event;
      return never;
    }
  }
}

/** Newest template first, with the id breaking a shared millisecond. */
const TEMPLATE_KEYS: DocumentKeys<Template> = {
  idOf: (template) => template.id,
  sortKey: (template) => template.createdAt,
};

/**
 * The one fold of `TemplateEvent` into the library. Mate's store folds it, a
 * replay of `templates.jsonl` folds it and the app folds the SSE stream through
 * it — all three run this function, so the three pictures cannot drift.
 *
 * It never mutates `templates`, and returns the **same reference** when an
 * event changes nothing: a delete of an id that was never there, or a save of a
 * template deep-equal to the one already held. The app patches its own write in
 * from the mutation response *and* folds the event mate streams back, and that
 * is what makes the two converge instead of the write landing twice.
 */
export function applyTemplateEvent(templates: readonly Template[], event: TemplateEvent): readonly Template[] {
  switch (event.type) {
    case "template.saved":
      return upsertById(templates, event.template, TEMPLATE_KEYS);
    case "template.deleted":
      return removeById(templates, event.id, TEMPLATE_KEYS.idOf);
    default: {
      const never: never = event;
      void never;
      return templates;
    }
  }
}

/**
 * The whole library in one frame: the payload of the SSE `templates.snapshot`
 * that opens a stream, and — via `TemplateListResponseSchema` — the body of
 * `GET /templates`. One schema, so the snapshot and the REST list cannot
 * disagree.
 */
export const TemplateLibrarySchema = z.object({ templates: z.array(TemplateSchema) });
export type TemplateLibrary = z.infer<typeof TemplateLibrarySchema>;
