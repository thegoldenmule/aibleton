import Anthropic from "@anthropic-ai/sdk";
import { isMateTrack } from "@aibleton/protocol";
import type { DawState, RequestContext, Song } from "@aibleton/protocol";
import type { Logger } from "../../log.ts";
import type { AbletonPort } from "../../ports/ableton/types.ts";
import type { SplicePort } from "../../ports/splice/types.ts";
import { isReadOnlyTool, toolDefinitions, toolToAction } from "../tools/index.ts";
import { isLibraryTool, runLibraryTool, type LibraryToolDeps } from "../tools/library.tools.ts";
import type { Action, Brain, BrainInput, Decision } from "./types.ts";

export interface AnthropicBrainOptions {
  client: Anthropic;
  model: string;
  log: Logger;
  ableton: AbletonPort;
  splice: SplicePort;
  /**
   * The active song, read fresh on every call. A getter rather than the service because the brain
   * is built before the song library is; absent means no song tools are offered at all.
   */
  getSong?: () => Song | null;
  /**
   * The saved libraries, for the library tools. One field rather than three, so "built without the
   * libraries" is one absent thing and there is no half-wired state: absent means none of the seven
   * are offered — the five reads that run inline here, and the two generates that queue as actions
   * and are applied against the same stores by `EffectRunner`. Not a getter — unlike `getSong`
   * these exist before the brain does, and the stores are read fresh on every call anyway.
   */
  library?: LibraryToolDeps;
  maxIterations?: number;
  maxTokens?: number;
}

const SYSTEM_PROMPT = `You are "mate", an AI bandmate sitting in on a drummer's practice session. You control an Ableton Live set on their machine and can browse Splice for sounds.

How you work:
- You are not realtime. Each time you are called you get a fresh snapshot of the Ableton session (transport, tracks, clip slots), the drummer's current goal if any, what they just said if anything, which view they said it from, and a short history of previous decisions.
- Read-only tools (get_session, splice_search, get_slot_candidates, and the library reads below) run immediately and return real data.
- Every other tool queues an action; actions are applied in order after you finish, and you will see the result next time. Do not assume an action has happened yet within the same turn.
- You may only change tracks you created: they are marked "mine": true in the snapshot and their names end in "[mate]". Every other track is the drummer's; never add clips or notes to it, fire its clips, or load devices on it. Create a track of your own instead.
- Drum rack pitches for add_notes: 36 kick, 38 snare, 42 closed hat, 46 open hat, 49 crash, 51 ride. Times are in beats; a bar of 4/4 is 4 beats.
- Keep tempo changes musical (usually 40-220 BPM) and prefer small, reversible edits: a click, a bass or keys loop to play along with, a groove reference clip.
- If you want to check back on the drummer later (for example after they practise a pattern for a few minutes), call schedule_follow_up.

Songs. Beyond single clips you can plan a whole song: a form, a brief per section, a band of parts, and a Splice loop for each part in each section. At most one song is on the go, and you are shown it on every call, or "Song: none".
- With no song, compose_song is how one gets made. Reach for it as soon as the drummer describes music they want instead of telling them to press something; it searches Splice itself, so never follow it with resolve_song.
- With a song, the other tools change it: set_placement rests a part or brings it in for one occurrence, remove_track drops a part for good, pick_slot chooses a sound (read the options with get_slot_candidates — the song you are shown carries only the count), clear_active_song puts the song away so a new one can be written.
- Searching Splice is free. Downloading the sounds costs the drummer credits and is their own confirmed decision, so you cannot do it. arrange_song only builds into Live what is already downloaded, and only ever adds.

The libraries. The drummer has saved bands (who plays) and templates (the form), and mate can staff a band from any genre it has a recipe for. find_bands, find_templates and get_genres tell you what is there; they answer with summaries and a total, so narrow with a find and then read the one you care about in full with get_band or get_template — that is where the briefs are. generate_band and generate_template add to them and save straight away; get_genres first, because mate ships no recipes and a genre that list does not have has one written by a model before the band is rolled, which takes a while. You can never delete anything from a library: mate adds, the drummer removes.

Bands and templates are what a future song is written from, not what is playing now. A song keeps its own full copy of the template and band it was composed with, so generating a band, or a change to one in the library, does not touch the song on the go. To change what is playing, use the song tools — set_placement, remove_track, pick_slot — and let compose_song pick from the libraries when the next song gets written.

Your final message is spoken to the drummer. Keep it short, concrete and friendly: what you set up and what to try. No markdown headers.`;

/** Brain backed by the Anthropic API. Manual tool loop; mutating tools become queued Actions. */
export class AnthropicBrain implements Brain {
  readonly kind = "anthropic" as const;

  constructor(private readonly opts: AnthropicBrainOptions) {}

  async decide(input: BrainInput, signal: AbortSignal): Promise<Decision> {
    const { client, model, log } = this.opts;
    const maxIterations = this.opts.maxIterations ?? 8;
    // Per call, not once in the field: which song tools apply depends on this turn's trigger and
    // on whether a song is active right now.
    const song = this.opts.getSong?.() ?? null;
    const tools = toolDefinitions({
      songTools: this.opts.getSong !== undefined && input.trigger === "userRequest",
      hasSong: song !== null,
      // Same gate as the song plan, for the same product reason; no song precondition, because
      // reading a library clobbers nothing and generating into one only ever adds.
      libraryTools: this.opts.library !== undefined && input.trigger === "userRequest",
    });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: renderInput(input) }];
    const actions: Action[] = [];
    let followUp: Decision["followUp"];
    let lastText = "";

    for (let i = 0; i < maxIterations; i++) {
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: this.opts.maxTokens ?? 16000,
          system: SYSTEM_PROMPT,
          tools,
          messages,
          // Server-side refusal fallbacks: route by refusal category without maintaining a model list.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );

      if (response.stop_reason === "refusal") {
        log.warn("brain refused", response.stop_details);
        return { message: "I can't help with that one, but I'm happy to set up something else to play along with.", actions };
      }

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) lastText = text;

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const args = (use.input ?? {}) as Record<string, unknown>;
        try {
          if (isReadOnlyTool(use.name)) {
            results.push({ type: "tool_result", tool_use_id: use.id, content: await this.runReadOnly(use.name, args) });
          } else if (use.name === "schedule_follow_up") {
            followUp = { cmd: { type: "userRequest", text: String(args.reason ?? "check in") }, delayMs: Number(args.delay_ms) || 0 };
            results.push({ type: "tool_result", tool_use_id: use.id, content: "scheduled" });
          } else {
            const action = toolToAction(use.name, args);
            if (!action) {
              results.push({ type: "tool_result", tool_use_id: use.id, content: `unknown tool ${use.name}`, is_error: true });
              continue;
            }
            actions.push(action);
            results.push({ type: "tool_result", tool_use_id: use.id, content: `queued as action #${actions.length}` });
          }
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: err instanceof Error ? err.message : String(err), is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }

    const decision: Decision = {
      message: lastText || (actions.length ? "On it." : "Nothing to change right now."),
      actions,
    };
    if (followUp) decision.followUp = followUp;
    return decision;
  }

  private async runReadOnly(name: string, args: Record<string, unknown>): Promise<string> {
    // The library reads are only ever offered with `library` set, so reaching one without it is
    // a tool list gone wrong rather than something to paper over.
    if (isLibraryTool(name)) {
      const library = this.opts.library;
      if (!library) throw new Error(`${name} was offered without a library`);
      return runLibraryTool(name, args, library);
    }
    if (name === "get_session") return JSON.stringify(compactSession(await this.opts.ableton.getSnapshot()));
    if (name === "get_slot_candidates") {
      // The song in the prompt carries only a count per slot: the arrays are 30 KB of a 56 KB song.
      const song = this.opts.getSong?.() ?? null;
      if (!song) return "no song is active";
      const id = String(args.slot_id ?? "");
      const slot = song.plan.slots.find((s) => s.id === id);
      if (!slot) return `no slot ${JSON.stringify(id)}; this song's slots are ${song.plan.slots.map((s) => s.id).join(", ")}`;
      return JSON.stringify(
        slot.candidates.slice(0, 10).map((c) => ({
          uuid: c.uuid,
          fileName: c.fileName,
          pack: c.pack,
          bpm: c.bpm,
          key: c.key,
          bars: c.bars,
          durationSec: c.durationSec,
          score: c.score,
          picked: c.uuid === slot.pickedUuid,
        })),
      );
    }
    if (name === "splice_search") {
      const sounds = await this.opts.splice.searchSounds(String(args.query ?? ""), {
        bpmMin: numOrUndefined(args.bpm_min),
        bpmMax: numOrUndefined(args.bpm_max),
        type: args.type === "oneshot" ? "oneshot" : args.type === "loop" ? "loop" : undefined,
      });
      return JSON.stringify(sounds.slice(0, 10));
    }
    throw new Error(`not a read-only tool: ${name}`);
  }
}

function numOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== null && v !== "" ? n : undefined;
}

/** Trim the session to what the model needs: transport, tracks, filled slots. */
export function compactSession(s: DawState) {
  return {
    transport: s.transport,
    tracks: s.tracks.map((t) => ({
      index: t.index,
      name: t.name,
      kind: t.kind,
      mine: isMateTrack(t),
      mute: t.mute,
      solo: t.solo,
      arm: t.arm,
      slotCount: t.clipSlots.length,
      clips: t.clipSlots.filter((c) => c.clip).map((c) => ({ slot: c.index, name: c.clip!.name, length: c.clip!.length, playing: c.clip!.isPlaying ?? false })),
      arrangementClips: t.arrangementClips.length,
    })),
  };
}

/**
 * Whatever the context carries, one line each — named rather than listed, the
 * way `ContextChips` renders the same object in the app. A field added to
 * `RequestContextSchema` shows up in both places without either being touched,
 * and zod has already dropped anything not declared there.
 */
function renderContext(context: RequestContext): string {
  const lines = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return ["Where the drummer is looking:", ...lines].join("\n");
}

export function renderInput(input: BrainInput): string {
  const parts: string[] = [];
  parts.push(`Trigger: ${input.trigger}`);
  if (input.goal) parts.push(`Practice goal: ${input.goal}`);
  if (input.userText) parts.push(`Drummer says: ${input.userText}`);
  if (input.context) parts.push(renderContext(input.context));
  parts.push(`Session snapshot:\n${JSON.stringify(compactSession(input.snapshot))}`);
  // Either the plan or the line that says there isn't one — that line is what tells the brain to compose.
  parts.push(input.song ? `Active song (the plan the song tools edit):\n${JSON.stringify(input.song)}` : "Song: none — nothing is planned yet.");
  if (input.history.length) {
    const lines = input.history.slice(-8).map((h) => {
      const what = h.command.type === "userRequest" ? `user: ${h.command.text}` : h.command.type;
      const did = h.decision ? `-> ${h.decision.actions.map((a) => a.type).join(", ") || "no actions"}; said: ${h.decision.message.slice(0, 120)}` : "";
      const res = h.results ? ` [${h.results.filter((r) => r.ok).length}/${h.results.length} ok]` : "";
      return `- ${what} ${did}${res}`;
    });
    parts.push(`Recent history:\n${lines.join("\n")}`);
  }
  if (input.trigger === "tick") parts.push("This is a periodic check. If nothing needs doing, reply briefly with no tool calls.");
  return parts.join("\n\n");
}
