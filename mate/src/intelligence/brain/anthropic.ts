import Anthropic from "@anthropic-ai/sdk";
import { isMateTrack } from "@aibleton/protocol";
import type { SessionState } from "@aibleton/protocol";
import type { Logger } from "../../log.ts";
import type { AbletonPort } from "../../ports/ableton/types.ts";
import type { SplicePort } from "../../ports/splice/types.ts";
import { isReadOnlyTool, toolDefinitions, toolToAction } from "../tools/index.ts";
import type { Action, Brain, BrainInput, Decision } from "./types.ts";

export interface AnthropicBrainOptions {
  client: Anthropic;
  model: string;
  log: Logger;
  ableton: AbletonPort;
  splice: SplicePort;
  maxIterations?: number;
  maxTokens?: number;
}

const SYSTEM_PROMPT = `You are "mate", an AI bandmate sitting in on a drummer's practice session. You control an Ableton Live set on their machine and can browse Splice for sounds.

How you work:
- You are not realtime. Each time you are called you get a fresh snapshot of the Ableton session (transport, tracks, clip slots), the drummer's current goal if any, what they just said if anything, and a short history of previous decisions.
- Read-only tools (get_session, splice_search) run immediately and return real data.
- Every other tool queues an action; actions are applied in order after you finish, and you will see the result next time. Do not assume an action has happened yet within the same turn.
- You may only change tracks you created: they are marked "mine": true in the snapshot and their names end in "[mate]". Every other track is the drummer's; never add clips or notes to it, fire its clips, or load devices on it. Create a track of your own instead.
- Drum rack pitches for add_notes: 36 kick, 38 snare, 42 closed hat, 46 open hat, 49 crash, 51 ride. Times are in beats; a bar of 4/4 is 4 beats.
- Keep tempo changes musical (usually 40-220 BPM) and prefer small, reversible edits: a click, a bass or keys loop to play along with, a groove reference clip.
- If you want to check back on the drummer later (for example after they practise a pattern for a few minutes), call schedule_follow_up.

Your final message is spoken to the drummer. Keep it short, concrete and friendly: what you set up and what to try. No markdown headers.`;

/** Brain backed by the Anthropic API. Manual tool loop; mutating tools become queued Actions. */
export class AnthropicBrain implements Brain {
  readonly kind = "anthropic" as const;
  private readonly tools = toolDefinitions();

  constructor(private readonly opts: AnthropicBrainOptions) {}

  async decide(input: BrainInput, signal: AbortSignal): Promise<Decision> {
    const { client, model, log } = this.opts;
    const maxIterations = this.opts.maxIterations ?? 8;
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
          tools: this.tools,
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
    if (name === "get_session") return JSON.stringify(compactSession(await this.opts.ableton.getSnapshot()));
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
export function compactSession(s: SessionState) {
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

export function renderInput(input: BrainInput): string {
  const parts: string[] = [];
  parts.push(`Trigger: ${input.trigger}`);
  if (input.goal) parts.push(`Practice goal: ${input.goal}`);
  if (input.userText) parts.push(`Drummer says: ${input.userText}`);
  parts.push(`Session snapshot:\n${JSON.stringify(compactSession(input.snapshot))}`);
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
