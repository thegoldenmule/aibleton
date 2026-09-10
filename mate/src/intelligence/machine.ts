import { ownedTrackIndexes } from "@aibleton/protocol";
import type { MateEvent, Phase, DawState } from "@aibleton/protocol";
import type { Command, CommandBody, CommandType } from "../core/commands.ts";
import type { SongDigest } from "../songwriting/digest.ts";
import type { Action, ActionResult, ActionType, BrainInput, Decision, HistoryEntry } from "./brain/types.ts";

/** Everything the machine remembers across phases. */
export interface MachineContext {
  snapshot?: DawState;
  goal?: string;
  /** Text of the most recent userRequest; forwarded to the brain and to Ableton telemetry. */
  userText?: string;
  history: HistoryEntry[];
  /** Consecutive brain/snapshot failures for the current attempt. */
  retryCount: number;
  /** Requests that arrived mid-turn, oldest first. Held here, never back in the mailbox. */
  deferred: Command[];
  /** The active song plan as the brain sees it; undefined when no song is active. Type-only import: the reducer stays pure. */
  song?: SongDigest;
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
  | { type: "abortBrain"; requestId: string }
  | { type: "abortActions"; requestId: string };

export interface StepOptions {
  maxBrainRetries: number;
  retryBaseMs: number;
  historyLimit: number;
  /** How many mid-turn requests wait in the context before the oldest is dropped. */
  maxDeferred: number;
  newRequestId: () => string;
}

export const DEFAULT_STEP_OPTIONS: StepOptions = {
  maxBrainRetries: 3,
  retryBaseMs: 1000,
  historyLimit: 20,
  maxDeferred: 3,
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
  return { kind: "idle", ctx: { history: [], retryCount: 0, deferred: [] } };
}

/**
 * Park a request that arrived mid-turn. It must never go back through the mailbox: `drain()` is
 * synchronous, so an `enqueue` effect is pulled straight back out on the same stack and spins
 * forever, and the in-flight brain promise never gets a turn to resolve.
 */
function defer(ctx: MachineContext, cmd: Command, opts: StepOptions): { ctx: MachineContext; effects: Effect[] } {
  const deferred = [...ctx.deferred, cmd];
  if (deferred.length <= opts.maxDeferred) return { ctx: { ...ctx, deferred }, effects: [] };
  const dropped = deferred.shift();
  const text =
    dropped?.type === "userRequest"
      ? `I already have ${opts.maxDeferred} messages waiting, so I let the oldest one go: "${dropped.text}". Say it again when I catch up.`
      : `I already have ${opts.maxDeferred} messages waiting, so I let the oldest one go.`;
  return { ctx: { ...ctx, deferred }, effects: [{ type: "emitEvent", event: { type: "message", text } }] };
}

/**
 * Every edge back to idle releases exactly **one** waiting request. One, not all: `stepObserving`
 * upgrades `pending` in place, so releasing two would silently merge two requests into one brain call.
 */
function settleIdle(ctx: MachineContext, effects: Effect[] = []): StepResult {
  const [next, ...rest] = ctx.deferred;
  if (!next) return { state: { kind: "idle", ctx }, effects };
  // The original envelope, not a copy: AgentLoop.record() dedupes by id, so replaying it produces
  // no second command.received and no duplicate transcript line.
  return { state: { kind: "idle", ctx: { ...ctx, deferred: rest } }, effects: [...effects, { type: "enqueue", cmd: next }] };
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
export function snapshotFingerprint(s: DawState | undefined): string {
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
      } else if (state.kind === "acting") {
        // Otherwise the machine parks in paused while the actions go on mutating Live.
        effects.push({ type: "abortActions", requestId: state.requestId });
        abortedRequestId = state.requestId;
      }
      return { state: { kind: "paused", ctx: state.ctx, abortedRequestId }, effects };
    }
    case "resume": {
      if (state.kind === "paused" || state.kind === "error") {
        return settleIdle({ ...state.ctx, retryCount: 0 });
      }
      return same();
    }
    case "cancel": {
      // Cancel stops the thing in flight, which is what it says: the waiting requests stay waiting.
      if (state.kind === "deciding") {
        return settleIdle({ ...state.ctx, retryCount: 0 }, [
          { type: "abortBrain", requestId: state.requestId },
          { type: "emitEvent", event: { type: "cancelled", requestId: state.requestId } },
        ]);
      }
      if (state.kind === "acting") {
        return settleIdle({ ...state.ctx, retryCount: 0 }, [
          { type: "abortActions", requestId: state.requestId },
          { type: "emitEvent", event: { type: "cancelled", requestId: state.requestId } },
        ]);
      }
      if (state.kind === "observing") {
        return settleIdle(state.ctx, [{ type: "emitEvent", event: { type: "cancelled" } }]);
      }
      return same();
    }
    case "songChanged": {
      // Handled here rather than per phase: every step* ends in a silent default, so a per-phase
      // version would drop the digest in whichever phase someone forgot. It changes no phase and
      // emits nothing, and songChanged is not in TRIGGER_TYPES, so it can never cause a brain call.
      const ctx: MachineContext = { ...state.ctx, song: cmd.digest ?? undefined };
      return { state: { ...state, ctx } as MachineState, effects: [] };
    }
    case "contextRestored": {
      // A resumed session's working memory, seeded in one command. Handled here for the same
      // reason `songChanged` is, and `undefined` is derived from `null` rather than the other way
      // round: a session with no goal must *clear* the last one, not leave it standing.
      // Deliberately not carried: `snapshot`, which is Live's and volatile — seeding a stale one
      // would make `snapshotFingerprint` suppress the first real observation — and `deferred`,
      // because the mailbox is empty after a restart. Not in TRIGGER_TYPES either, which is what
      // guarantees a resume never costs a paid brain call.
      const ctx: MachineContext = {
        ...state.ctx,
        goal: cmd.goal ?? undefined,
        userText: cmd.userText ?? undefined,
        song: cmd.song ?? undefined,
      };
      return { state: { ...state, ctx } as MachineState, effects: [] };
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
      return stepActing(state, cmd, opts);
    case "paused": {
      // Everything except the lifecycle commands above is dropped while paused — except a typed
      // request, which waits for resume rather than vanishing.
      if (cmd.type !== "userRequest") return same();
      const parked = defer(state.ctx, cmd, opts);
      return { state: { ...state, ctx: parked.ctx }, effects: parked.effects };
    }
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
    case "actionsDone":
      // A cancelled or paused set finishes after the machine has moved on. Nothing changes phase;
      // the results are filed so the record of what reached Live stays honest.
      return { state: { ...state, ctx: { ...state.ctx, history: withResults(state.ctx.history, cmd.results) } }, effects: [] };
    default:
      return { state, effects: [] };
  }
}

/**
 * File an action set's results onto the history entry its decision created. In `acting` the
 * decision identifies the entry; a set that lands late attaches to the last entry still missing
 * results, which is the one it belonged to.
 */
function withResults(history: HistoryEntry[], results: ActionResult[], decision?: Decision): HistoryEntry[] {
  const next = history.slice();
  const last = next[next.length - 1];
  if (!last) return next;
  if (decision ? last.decision !== decision : last.results !== undefined) return next;
  next[next.length - 1] = { ...last, results };
  return next;
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
        // Absent means no song is active, which is what tells the brain to offer to compose one.
        song: ctx.song,
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

/**
 * The track an action changes, if it names one. Track-less actions (tempo, transport, new tracks)
 * return undefined. Every variant is spelled out and the default is `never`: a new Action that
 * names a track must be classified here or `guardDecision` would wave it through onto the
 * drummer's own tracks.
 */
export function actionTrack(action: Action): number | undefined {
  switch (action.type) {
    case "createClip":
    case "addNotes":
    case "fireClip":
    case "loadDrumKit":
      return action.track;
    case "createMidiTrack":
    case "setTempo":
    case "startPlayback":
    case "stopPlayback":
    case "splicePromptToStack":
      return undefined;
    case "composeSong":
    case "clearActiveSong":
    case "resolveSong":
    case "pickSlot":
    case "setPlacement":
    case "removeTrack":
    case "arrangeSong":
      // Song actions name no Live track on purpose: they change mate's plan, and the one that does
      // reach Live (arrange) only ever touches tracks mate made itself, by construction in
      // `dawStatus`. Their guard is the service, not the ownership filter below.
      return undefined;
    default: {
      const never: never = action;
      throw new Error(`actionTrack: unhandled action ${JSON.stringify(never)}`);
    }
  }
}

/** The song actions that only make sense with a song on the go. `composeSong` is the mirror image. */
const SONG_EDIT_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "clearActiveSong",
  "resolveSong",
  "pickSlot",
  "setPlacement",
  "removeTrack",
  "arrangeSong",
]);

/**
 * Keep only the actions that touch tracks mate created (or no track at all), and only the song
 * actions that match whether a song is on the go. The drummer's own tracks are never changed,
 * whatever the brain asked for; refused actions are named in the message so the drummer knows.
 *
 * The tool list already withholds the wrong tools (`toolDefinitions`), so this is a backstop, and
 * it is deliberately not fatal: throwing would become an `actionFailed`, which drives the machine
 * to `error` and abandons the rest of the turn. A misdirected compose should cost a sentence.
 */
export function guardDecision(decision: Decision, snapshot: DawState | undefined, song?: SongDigest): Decision {
  const owned = ownedTrackIndexes(snapshot);
  const refused: Action[] = [];
  const composeOverSong: Action[] = [];
  const editWithoutSong: Action[] = [];
  // Walked in the order the actions will be applied, not judged one at a time: a compose earlier in
  // the same set leaves a song to edit, and a clear leaves none. That is the whole point of the
  // service reading the active song when an action runs — "write me one and take the bass out of
  // the second verse" is one turn, and so is "scrap it and start over".
  let onTheGo = song !== undefined;
  const actions = decision.actions.filter((a) => {
    if (a.type === "composeSong") {
      if (onTheGo) {
        composeOverSong.push(a);
        return false;
      }
      onTheGo = true;
      return true;
    }
    if (SONG_EDIT_ACTIONS.has(a.type)) {
      if (!onTheGo) {
        editWithoutSong.push(a);
        return false;
      }
      if (a.type === "clearActiveSong") onTheGo = false;
      return true;
    }
    const track = actionTrack(a);
    if (track === undefined || owned.has(track)) return true;
    refused.push(a);
    return false;
  });
  const notes: string[] = [];
  if (refused.length > 0) {
    const named = refused.map((a) => `${a.type} on track ${actionTrack(a)}`).join(", ");
    notes.push(`I left ${refused.length === 1 ? "one thing" : `${refused.length} things`} alone (${named}): I only change the tracks I made, the ones ending in "[mate]".`);
  }
  if (composeOverSong.length > 0) {
    notes.push(`We already have “${song!.name}” on the go, so I didn't start another one. Say the word and I'll put it away first.`);
  }
  if (editWithoutSong.length > 0) {
    const named = [...new Set(editWithoutSong.map((a) => a.type))].join(", ");
    notes.push(`There's no song on the go yet, so there was nothing to change (${named}). Tell me what you want and I'll write one.`);
  }
  if (notes.length === 0) return decision;
  const note = notes.join(" ");
  return { ...decision, actions, message: decision.message ? `${decision.message} ${note}` : note };
}

function stepDeciding(state: Extract<MachineState, { kind: "deciding" }>, cmd: Command, opts: StepOptions): StepResult {
  switch (cmd.type) {
    case "brainDecided": {
      if (cmd.requestId !== state.requestId) return { state, effects: [] };
      const decision = guardDecision(cmd.decision, state.ctx.snapshot, state.ctx.song);
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
      return settleIdle(ctx, [message, ...followUpEffects(decision)]);
    }
    case "brainFailed":
      if (cmd.requestId !== state.requestId) return { state, effects: [] };
      return fail(state.ctx, cmd.error, state.pending, opts);
    case "userRequest": {
      const parked = defer(state.ctx, cmd, opts);
      return { state: { ...state, ctx: parked.ctx }, effects: parked.effects };
    }
    default:
      return { state, effects: [] };
  }
}

function stepActing(state: Extract<MachineState, { kind: "acting" }>, cmd: Command, opts: StepOptions): StepResult {
  switch (cmd.type) {
    case "actionsDone": {
      if (cmd.requestId !== state.requestId) return { state, effects: [] };
      const ctx = { ...state.ctx, history: withResults(state.ctx.history, cmd.results, state.decision), retryCount: 0 };
      // An aborted set still refreshes: some of it landed, and Live has no delete.
      return settleIdle(ctx, [
        { type: "enqueue", cmd: { id: `${state.requestId}_refresh`, at: cmd.at, source: "loop", type: "abletonChanged", hint: "clips" } },
        ...(cmd.aborted ? [] : followUpEffects(state.decision)),
      ]);
    }
    case "actionFailed": {
      if (cmd.requestId !== state.requestId) return { state, effects: [] };
      // No auto-retry: actions may have been partially applied. What landed is recorded so the
      // brain can see it, and the waiting requests ride along in ctx until the resume.
      const ctx = { ...state.ctx, history: withResults(state.ctx.history, cmd.results, state.decision) };
      return {
        state: { kind: "error", ctx, error: `action ${cmd.index} failed: ${cmd.error}`, pending: state.pending },
        effects: [],
      };
    }
    case "userRequest": {
      const parked = defer(state.ctx, cmd, opts);
      return { state: { ...state, ctx: parked.ctx }, effects: parked.effects };
    }
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
