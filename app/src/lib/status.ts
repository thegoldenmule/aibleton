import type { ActivityKind, Phase } from "@aibleton/protocol";

/**
 * What each kind of work is called, in the drummer's words. Short enough to sit
 * in the bandmate's status line and to read as "bandmate is <label>…" in the
 * conversation, so both say the same thing about the same moment.
 */
export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  think: "thinking",
  compose: "writing a song",
  resolve: "searching Splice",
  arrange: "building in Live",
  download: "getting the sounds",
  edit: "changing the plan",
};

/** Full class strings only — Tailwind cannot see interpolated names. */
export const PHASE_CLASS: Record<Phase, string> = {
  idle: "bg-panel-2 text-muted",
  observing: "bg-accent-2/20 text-accent-2",
  deciding: "bg-accent/20 text-accent",
  acting: "bg-midi/20 text-midi",
  paused: "bg-panel-2 text-muted",
  error: "bg-audio/20 text-audio",
};
