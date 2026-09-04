import type { Band, SongBrief, Template } from "@aibleton/protocol";

/** What the briefer is given: the request and the deterministic picks. */
export interface BriefInput {
  text: string;
  template: Template;
  band: Band;
}

/**
 * One structured call: "here is the request, template and band; what should
 * this song be?". Returns a validated `SongBrief`. The anthropic briefer is
 * the only network user; the scripted one runs offline and in tests.
 */
export interface Briefer {
  readonly kind: "anthropic" | "scripted";
  brief(input: BriefInput, signal: AbortSignal): Promise<SongBrief>;
}
