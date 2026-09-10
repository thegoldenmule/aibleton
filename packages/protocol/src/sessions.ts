import { z } from "zod";

/**
 * One row in the session library: enough to recognise a practice session
 * without opening it.
 *
 * `preview` is the first thing the drummer said in it, so a list of sessions
 * reads as something rather than as a column of timestamps, and `songId` is the
 * song it ended on — a pointer, never the song, which is ~57 KB and already on
 * disk under `SongStore`.
 */
export const SessionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Readable entries in the session's journal: how much happened in it. */
  events: z.number().int().nonnegative(),
  /** The song the session ended on, or null when it never had one. */
  songId: z.string().nullable(),
  /** The first thing the drummer typed, or null for a session nobody spoke in. */
  preview: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
