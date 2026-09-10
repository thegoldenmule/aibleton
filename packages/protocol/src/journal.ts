import { z } from "zod";
import { CommandSummarySchema } from "./commands.ts";
import type { MateEvent } from "./events.ts";
import type { Song } from "./songs.ts";
import { TranscriptEntrySchema } from "./state.ts";

/**
 * Events that survive a restart: the conversation, the song pointer, the goal,
 * and the trace of what mate did. Replaying these through `applyMateEvent`
 * rebuilds the session the drummer left behind.
 */
export const DURABLE_EVENT_TYPES = [
  "command.received",
  "message",
  "action.applied",
  "goal.changed",
  "song.changed",
  "transcript.appended",
] as const;

/**
 * Events that describe *now* and are never written down. After a restore the
 * phase is `idle`, the activity `null`, the queue empty and the DAW picture
 * absent purely because these were never journaled: the list is enforced by
 * omission, not by a second filter.
 */
export const VOLATILE_EVENT_TYPES = [
  "state.changed",
  "phase.changed",
  "activity.changed",
  "queue.changed",
  "adapters",
  "download.progress",
  "cancelled",
  "state.replaced",
] as const;

export type DurableEventType = (typeof DURABLE_EVENT_TYPES)[number];
export type VolatileEventType = (typeof VOLATILE_EVENT_TYPES)[number];

/**
 * Compile-time guard: a new `MateEvent` variant leaves `Unclassified`
 * non-empty, so this line stops typechecking until the variant is added to one
 * of the two lists above. Deciding whether an event survives a restart is not
 * something a new event may skip.
 */
type Unclassified = Exclude<MateEvent["type"], DurableEventType | VolatileEventType>;
const _exhaustive: Unclassified extends never ? true : never = true;
void _exhaustive;

/**
 * The on-disk form of a durable event. It mirrors `MateEvent` arm for arm with
 * one exception: `song.changed` carries only the song's id. A `Song` is ~57 KB,
 * half of it Splice candidates, and `SongStore` already keeps one JSON per song
 * — writing it again on every change would make the journal enormous and stale
 * at the same time.
 */
export const JournaledEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command.received"), command: CommandSummarySchema }),
  z.object({ type: z.literal("message"), text: z.string(), requestId: z.string().optional() }),
  /**
   * Journaled, but folded to a no-op on replay. Deliberate: this is the
   * *trace*, kept so the file is an honest record of what reached Live. What it
   * changed in the DAW is Live's business, and mate never replays it.
   */
  z.object({
    type: z.literal("action.applied"),
    action: z.string(),
    ok: z.boolean(),
    detail: z.string().optional(),
    requestId: z.string().optional(),
  }),
  z.object({ type: z.literal("goal.changed"), goal: z.string().nullable() }),
  z.object({ type: z.literal("song.changed"), songId: z.string().nullable() }),
  z.object({ type: z.literal("transcript.appended"), entry: TranscriptEntrySchema }),
]);
export type JournaledEvent = z.infer<typeof JournaledEventSchema>;

/** One line of `journal.jsonl`. `seq` is dense per session and only ever grows. */
export const JournalEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number(),
  event: JournaledEventSchema,
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/**
 * The durable projection of an event, or `null` when it is volatile. Both
 * directions of the mapping live in this file so neither can drift from the
 * other or from the two lists above.
 */
export function toJournaled(event: MateEvent): JournaledEvent | null {
  switch (event.type) {
    case "command.received":
      return { type: "command.received", command: event.command };
    case "message":
      return event.requestId === undefined
        ? { type: "message", text: event.text }
        : { type: "message", text: event.text, requestId: event.requestId };
    case "action.applied":
      return {
        type: "action.applied",
        action: event.action,
        ok: event.ok,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      };
    case "goal.changed":
      return { type: "goal.changed", goal: event.goal };
    case "song.changed":
      return { type: "song.changed", songId: event.song?.id ?? null };
    case "transcript.appended":
      return { type: "transcript.appended", entry: event.entry };
    case "state.changed":
    case "phase.changed":
    case "activity.changed":
    case "queue.changed":
    case "adapters":
    case "download.progress":
    case "cancelled":
    case "state.replaced":
      return null;
    default: {
      const never: never = event;
      void never;
      return null;
    }
  }
}

/**
 * The event a journal line stands for. `resolveSong` turns a journaled song id
 * back into the song `SongStore` holds; returning `null` for a song that is no
 * longer on disk is the honest answer and must not throw — the transcript still
 * tells the story.
 */
export function fromJournaled(event: JournaledEvent, resolveSong: (songId: string) => Song | null): MateEvent {
  switch (event.type) {
    case "song.changed":
      return { type: "song.changed", song: event.songId === null ? null : resolveSong(event.songId) };
    case "command.received":
    case "message":
    case "action.applied":
    case "goal.changed":
    case "transcript.appended":
      return event;
    default: {
      const never: never = event;
      return never;
    }
  }
}
