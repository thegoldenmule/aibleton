import { ownedTrackIndexes } from "@aibleton/protocol";
import type { MateEvent, Phase, SessionState } from "@aibleton/protocol";
import type { Command, CommandBody, CommandType } from "../core/commands.ts";
import type { Action, BrainInput, Decision, HistoryEntry } from "./brain/types.ts";

/** Everything the machine remembers across phases. */
export interface MachineContext {
  snapshot?: SessionState;
  goal?: string;
  /** Text of the most recent userRequest; forwarded to the brain and to Ableton telemetry. */
  userText?: string;
  history: HistoryEntry[];
  /** Consecutive brain/snapshot failures for the current attempt. */
  retryCount: number;
}

export type MachineState =
  | { kind: "idle"; ctx: MachineContext }
  | { kind: "observing"; ctx: MachineContext; pending: Command }
  | { kind: "deciding"; ctx: MachineContext; pending: Command; requestId: string }
  | { kind: "acting"; ctx: MachineContext; pending: Command; requestId: string; decision: Decision }
  | { kind: "paused"; ctx: MachineContext; abortedRequestId?: string }
  | { kind: "error"; ctx: MachineContext; error: string; pending?: Command };

export type Effect =
  | { type: "refreshSnapshot" }
  | { type: "callBrain"; requestId: string; input: BrainInput }
  | { type: "applyActions"; requestId: string; actions: Action[]; userPrompt?: string }
  | { type: "emitEvent"; event: MateEvent }
  | { type: "enqueue"; cmd: Command }
  | { type: "scheduleCommand"; cmd: CommandBody; delayMs: number }
  | { type: "abortBrain"; requestId: string };

export interface StepOptions {
  maxBrainRetries: number;
  retryBaseMs: number;
  historyLimit: number;
  newRequestId: () => string;
}

export const DEFAULT_STEP_OPTIONS: StepOptions = {
  maxBrainRetries: 3,
  retryBaseMs: 1000,
  historyLimit: 20,
  newRequestId: (() => {
    let n = 0;
    return () => `req_${Date.now().toString(36)}_${(++n).toString(36)}`;
  })(),
};

export interface StepResult {
  state: MachineState;
  effects: Effect[];
}

export function initialState(): MachineState {
  return { kind: "idle", ctx: { history: [], retryCount: 0 } };
}

export function phaseOf(state: MachineState): Phase {
  return state.kind;
}

export function errorOf(state: MachineState): string | undefined {
  return state.kind === "error" ? state.error : undefined;
}

/**
 * Fingerprint used to skip brain calls on unchanged snapshots.
 * Ignores capturedAt and the moving song position: while Ableton plays, the playhead advances
 * every tick, and that alone must never count as a musical change (it would trigger a paid brain call).
 */
export function snapshotFingerprint(s: SessionState | undefined): string {
  if (!s) return "";
  const { currentSongTime: _pos, ...transport } = s.transport;
  return JSON.stringify({ transport, tracks: s.tracks });
}

const TRIGGER_TYPES: ReadonlySet<CommandType> = new Set(["tick", "userRequest", "goalSet", "abletonChanged", "midiNote"]);

/**
 * Pure reducer. No I/O. Given the current machine state and one command, returns the next
 * state and the effects the runner must perform.
 */
export function step(state: MachineState, cmd: Command, opts: StepOptions = DEFAULT_STEP_OPTIONS): StepResult {
  const same = (effects: Effect[] = []): StepResult => ({ state, effects });

  // Lifecycle commands handled the same in every phase.
  switch (cmd.type) {
    case "shutdown":
      return same();
    case "pause": {
      if (state.kind === "paused") return same();
      const effects: Effect[] = [];
      let abortedRequestId: string | undefined;
      if (state.kind === "deciding") {
        effects.push({ type: "abortBrain", requestId: state.requestId });
        abortedRequestId = state.requestId;
      }
      return { state: { kind: "paused", ctx: state.ctx, abortedRequestId }, effects };
    }
    case "resume": {
      if (state.kind === "paused" || state.kind === "error") {
        return { state: { kind: "idle", ctx: { ...state.ctx, retryCount: 0 } }, effects: [] };
      }
      return same();
    }
    case "cancel": {
      if (state.kind === "deciding") {
        return {
          state: { kind: "idle", ctx: { ...state.ctx, retryCount: 0 } },
          effects: [
            { type: "abortBrain", requestId: state.requestId },
            { type: "emitEvent", event: { type: "cancelled", requestId: state.requestId } },
          ],
        };
      }
      if (state.kind === "acting") {
        return {
          state: { kind: "idle", ctx: { ...state.ctx, retryCount: 0 } },
          effects: [{ type: "emitEvent", event: { type: "cancelled", requestId: state.requestId } }],
        };
      }
      if (state.kind === "observing") {
        return { state: { kind: "idle", ctx: state.ctx }, effects: [{ type: "emitEvent", event: { type: "cancelled" } }] };
      }
      return same();
    }
    case "goalSet": {
      const goal = cmd.text.trim() ? cmd.text.trim() : undefined;
      const ctx = { ...state.ctx, goal };
      if (state.kind === "idle") {
        return { state: { kind: "observing", ctx, pending: cmd }, effects: [{ type: "refreshSnapshot" }] };
      }
      return { state: { ...state, ctx } as MachineState, effects: [] };
    }
  }

  switch (state.kind) {
    case "idle":
      return stepIdle(state, cmd);
    case "observing":
      return stepObserving(state, cmd, opts);
    case "deciding":
      return stepDeciding(state, cmd, opts);
    case "acting":
      return stepActing(state, cmd);
    case "paused":
      // Everything except the lifecycle commands above is dropped while paused.
      return same();
    case "error":
      return stepError(state, cmd);
  }
}

function stepIdle(state: Extract<MachineState, { kind: "idle" }>, cmd: Command): StepResult {
  switch (cmd.type) {
    case "tick":
    case "abletonChanged":
      return { state: { kind: "observing", ctx: state.ctx, pending: cmd }, effects: [{ type: "refreshSnapshot" }] };
    case "userRequest":
      return {
        state: { kind: "observing", ctx: { ...state.ctx, userText: cmd.text, retryCount: 0 }, pending: cmd },
        effects: [{ type: "refreshSnapshot" }],
      };
    case "midiNote":
      // Placeholder: hardware input is not interpreted yet.
      return { state, effects: [] };
    case "snapshotReady":
      return { state: { ...state, ctx: { ...state.ctx, snapshot: cmd.snapshot } }, effects: [] };
    default:
      return { state, effects: [] };
  }
}

function stepObserving(state: Extract<MachineState, { kind: "observing" }>, cmd: Command, opts: StepOptions): StepResult {
  switch (cmd.type) {
    case "snapshotReady": {
      const unchanged = snapshotFingerprint(state.ctx.snapshot) === snapshotFingerprint(cmd.snapshot);
      const ctx = { ...state.ctx, snapshot: cmd.snapshot };
      // Ticks are cheap observation, not conversation: they only wake the brain when the drummer
      // has set a goal to work toward AND the session actually changed since the last look.
      if (state.pending.type === "tick" && (!ctx.goal || unchanged)) {
        return { state: { kind: "idle", ctx }, effects: [] };
      }
      // A refresh the loop requested after its own actions only updates the picture; it never re-triggers the brain.
      if (state.pending.type === "abletonChanged" && state.pending.source === "loop") {
        return { state: { kind: "idle", ctx }, effects: [] };
      }
      const requestId = opts.newRequestId();
      const input: BrainInput = {
        snapshot: cmd.snapshot,
        goal: ctx.goal,
        userText: state.pending.type === "userRequest" ? state.pending.text : undefined,
        history: ctx.history.slice(-opts.historyLimit),
        trigger: state.pending.type,
      };
      return {
        state: { kind: "deciding", ctx, pending: state.pending, requestId },
        effects: [{ type: "callBrain", requestId, input }],
      };
    }
    case "snapshotFailed":
      return fail(state.ctx, cmd.error, state.pending, opts);
    case "userRequest":
      // Upgrade the pending trigger so the brain sees the request once the snapshot lands.
      return {
        state: { ...state, ctx: { ...state.ctx, userText: cmd.text }, pending: cmd },
        effects: [],
      };
    default:
      return { state, effects: [] };
  }
}

/** The track an action changes, if it names one. Track-less actions (tempo, transport, new tracks) return undefined. */
export function actionTrack(action: Action): number | undefined {
  switch (action.type) {
    case "createClip":
    case "addNotes":
    case "fireClip":
    case "loadDrumKit":
      return action.track;
    default:
      return undefined;
  }
}

/**
 * Keep only the actions that touch tracks mate created (or no track at all).
 * The drummer's own tracks are never changed, whatever the brain asked for;
 * refused actions are named in the message so the drummer knows.
 */
export function guardDecision(decision: Decision, snapshot: SessionState | undefined): Decision {
  const owned = ownedTrackIndexes(snapshot);
  const refused: Action[] = [];
  const actions = decision.actions.filter((a) => {
    const track = actionTrack(a);
    if (track === undefined || owned.has(track)) return true;
    refused.push(a);
    return false;
  });
  if (refused.length === 0) return decision;
  const named = refused.map((a) => `${a.type} on track ${actionTrack(a)}`).join(", ");
  const note = `I left ${refused.length === 1 ? "one thing" : `${refused.length} things`} alone (${named}): I only change the tracks I made, the ones ending in "[mate]".`;
  return { ...decision, actions, message: decision.message ? `${decision.message} ${note}` : note };
}

function stepDeciding(state: Extract<MachineState, { kind: "deciding" }>, cmd: Command, opts: StepOptions): StepResult {
  switch (cmd.type) {
    case "brainDecided": {
      if (cmd.requestId !== state.requestId) return { state, effects: [] };
      const decision = guardDecision(cmd.decision, state.ctx.snapshot);
      const entry: HistoryEntry = { at: cmd.at, command: state.pending, decision };
      const ctx: MachineContext = {
        ...state.ctx,
        retryCount: 0,
        history: [...state.ctx.history, entry].slice(-opts.historyLimit * 2),
      };
      const message: Effect = {
        type: "emitEvent",
        event: { type: "message", text: decision.message, requestId: state.requestId },
      };
      if (decision.actions.length > 0) {
        return {
          state: { kind: "acting", ctx, pending: state.pending, requestId: state.requestId, decision },
          effects: [
            message,
            { type: "applyActions", requestId: state.requestId, actions: decision.actions, userPrompt: ctx.userText },
          ],
        };
      }
      return { state: { kind: "idle", ctx }, effects: [message, ...followUpEffects(decision)] };
    }
    case "brainFailed":
      if (cmd.requestId !== state.requestId) return { state, effects: [] };
      return fail(state.ctx, cmd.error, state.pending, opts);
    case "userRequest":
      return { state, effects: [{ type: "enqueue", cmd }] };
    default:
      return { state, effects: [] };
  }
}

function stepActing(state: Extract<MachineState, { kind: "acting" }>, cmd: Command): StepResult {
  switch (cmd.type) {
    case "actionsDone": {
      const history = state.ctx.history.slice();
      const last = history[history.length - 1];
      if (last && last.decision === state.decision) history[history.length - 1] = { ...last, results: cmd.results };
      const ctx = { ...state.ctx, history, retryCount: 0 };
      return {
        state: { kind: "idle", ctx },
        effects: [
          { type: "enqueue", cmd: { id: `${state.requestId}_refresh`, at: cmd.at, source: "loop", type: "abletonChanged", hint: "clips" } },
          ...followUpEffects(state.decision),
        ],
      };
    }
    case "actionFailed":
      // No auto-retry: actions may have been partially applied.
      return {
        state: { kind: "error", ctx: state.ctx, error: `action ${cmd.index} failed: ${cmd.error}`, pending: state.pending },
        effects: [],
      };
    case "userRequest":
      return { state, effects: [{ type: "enqueue", cmd }] };
    default:
      return { state, effects: [] };
  }
}

function stepError(state: Extract<MachineState, { kind: "error" }>, cmd: Command): StepResult {
  switch (cmd.type) {
    case "retry": {
      const pending: Command = state.pending ?? { id: cmd.id, at: cmd.at, source: "loop", type: "tick" };
      return { state: { kind: "observing", ctx: state.ctx, pending }, effects: [{ type: "refreshSnapshot" }] };
    }
    case "userRequest":
      return {
        state: { kind: "observing", ctx: { ...state.ctx, userText: cmd.text, retryCount: 0 }, pending: cmd },
        effects: [{ type: "refreshSnapshot" }],
      };
    default:
      return { state, effects: [] };
  }
}

function fail(ctx: MachineContext, error: string, pending: Command, opts: StepOptions): StepResult {
  const retryCount = ctx.retryCount + 1;
  const next: MachineState = { kind: "error", ctx: { ...ctx, retryCount }, error, pending };
  if (retryCount <= opts.maxBrainRetries) {
    const delayMs = opts.retryBaseMs * 2 ** (retryCount - 1);
    return { state: next, effects: [{ type: "scheduleCommand", cmd: { type: "retry" }, delayMs }] };
  }
  return { state: next, effects: [] };
}

function followUpEffects(decision: Decision): Effect[] {
  if (!decision.followUp) return [];
  const { cmd, delayMs } = decision.followUp;
  if (delayMs && delayMs > 0) return [{ type: "scheduleCommand", cmd, delayMs }];
  return [{ type: "scheduleCommand", cmd, delayMs: 0 }];
}

export function isTrigger(type: CommandType): boolean {
  return TRIGGER_TYPES.has(type);
}
