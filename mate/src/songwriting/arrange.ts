import { SongSchema, dawStatus } from "@aibleton/protocol";
import type { ArrangeStep, DawStatus, SessionState, Song } from "@aibleton/protocol";
import type { Logger } from "../log.ts";
import type { AbletonPort } from "../ports/ableton/types.ts";

/**
 * Builds the song in the Live set: one audio track per part, the downloaded
 * sample of every slot in the scene for its section, and copies of it along
 * the arrangement. `dawStatus` (protocol) decides what is missing against a
 * fresh snapshot; this module only runs the steps, then looks again, until
 * nothing is left. Safe to call any time: it adds what is missing and touches
 * only tracks mate created. Live's MCP server cannot delete tracks or
 * arrangement clips, so nothing is ever removed.
 */

export interface ArrangeDeps {
  ableton: AbletonPort;
  log: Logger;
  /** Checked before each step; an aborted request stops starting new ones. */
  signal: AbortSignal;
  /** Called with the song after a track is created for it (its `liveName` is set); save and publish it here. */
  onProgress: (song: Song) => Promise<void>;
  /** Called with every snapshot taken, so the app sees Live change round by round. */
  onSnapshot?: (session: SessionState) => void;
  /** Forwarded to the Ableton server's telemetry field on every call. */
  userPrompt?: string;
  /** Snapshot-and-step rounds before giving up; tracks, clips and placements each need one. */
  maxRounds?: number;
}

export interface ArrangeFailure {
  step: ArrangeStep;
  error: string;
}

export interface ArrangeOutcome {
  song: Song;
  /** Against the last snapshot taken: what is in Live now, and anything still missing. */
  status: DawStatus;
  applied: ArrangeStep[];
  failed: ArrangeFailure[];
}

const DEFAULT_ROUNDS = 4;

/** One line per step, for logs and the API. */
export function describeStep(step: ArrangeStep): string {
  switch (step.type) {
    case "setTempo":
      return `set tempo to ${step.bpm}`;
    case "createTrack":
      return `create track ${JSON.stringify(step.name)}`;
    case "importClip":
      return `import ${step.slotId} into track ${step.track} scene ${step.scene}`;
    case "replaceClip":
      return `replace ${step.slotId} in track ${step.track} scene ${step.scene}`;
    case "placeClip":
      return `place ${step.slotId} at beat ${step.atBeat}`;
    case "createLocator":
      return `locator ${step.name} at beat ${step.atBeat}`;
  }
}

export async function arrangeSong(song: Song, deps: ArrangeDeps): Promise<ArrangeOutcome> {
  const ctx = deps.userPrompt ? { userPrompt: deps.userPrompt } : undefined;
  let current = song;
  const applied: ArrangeStep[] = [];
  const failed: ArrangeFailure[] = [];
  const maxRounds = deps.maxRounds ?? DEFAULT_ROUNDS;

  const look = async (): Promise<DawStatus> => {
    const snapshot = await deps.ableton.getSnapshot(ctx);
    deps.onSnapshot?.(snapshot);
    return dawStatus(current, snapshot);
  };

  const run = async (step: ArrangeStep): Promise<void> => {
    const { ableton } = deps;
    switch (step.type) {
      case "setTempo":
        await ableton.setTempo(step.bpm, ctx);
        return;
      case "createTrack": {
        await ableton.createAudioTrack(step.name, ctx);
        current = SongSchema.parse({
          ...current,
          plan: { ...current.plan, tracks: current.plan.tracks.map((t) => (t.partId === step.partId ? { ...t, liveName: step.name } : t)) },
        });
        await deps.onProgress(current);
        return;
      }
      case "replaceClip":
        await ableton.deleteClip(step.track, step.scene, ctx);
      // falls through: the scene is empty now
      case "importClip": {
        await ableton.createAudioClip(step.track, step.scene, step.path, ctx);
        try {
          await ableton.setClipName(step.track, step.scene, step.name, ctx);
        } catch (err) {
          deps.log.warn(`could not name clip ${step.slotId}: ${message(err)}`);
        }
        return;
      }
      case "placeClip":
        await ableton.duplicateToArrangement(step.track, step.scene, step.atBeat, ctx);
        return;
      case "createLocator":
        await ableton.createLocator(step.name, step.atBeat, ctx);
        return;
    }
  };

  let status = await look();
  for (let round = 0; round < maxRounds && status.steps.length > 0 && failed.length === 0; round++) {
    for (const step of status.steps) {
      if (deps.signal.aborted) {
        deps.log.warn(`client gone; not starting more Live steps (${describeStep(step)} and later skipped)`);
        return { song: current, status: await look(), applied, failed };
      }
      try {
        await run(step);
        applied.push(step);
      } catch (err) {
        const error = message(err);
        deps.log.warn(`${describeStep(step)} failed: ${error}`);
        failed.push({ step, error });
      }
    }
    status = await look();
  }
  return { song: current, status, applied, failed };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
