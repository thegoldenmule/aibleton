import type { Phase } from "@aibleton/protocol";
import type { Command, CommandBody, CommandSource } from "../core/commands.ts";
import type { Clock } from "../core/clock.ts";
import type { Mailbox } from "../core/mailbox.ts";
import type { StateStore } from "../core/state.ts";
import type { Logger } from "../log.ts";
import type { AbletonPort } from "../ports/ableton/types.ts";
import type { SplicePort } from "../ports/splice/types.ts";
import type { SongService } from "../songwriting/service.ts";
import type { Brain } from "./brain/types.ts";
import type { LibraryWriterDeps } from "./effects.ts";

export interface IntelligenceDeps {
  clock: Clock;
  mailbox: Mailbox;
  store: StateStore;
  brain: Brain;
  ableton: AbletonPort;
  splice: SplicePort;
  /**
   * The single implementation of every song operation, shared with the REST routes. Optional:
   * without it the loop runs exactly as before, minus the song actions.
   */
  songs?: SongService;
  /**
   * The band and template libraries the generate actions write to. Optional: without them the loop
   * runs exactly as before, minus those two actions.
   */
  library?: LibraryWriterDeps;
  log: Logger;
  options?: {
    /** How often the loop enqueues a tick. */
    tickMs?: number;
    maxBrainRetries?: number;
    /** Base delay for brain retry backoff. */
    retryBaseMs?: number;
    /** How many history entries to hand the brain. */
    historyLimit?: number;
    /** How many mid-turn requests wait before the oldest is dropped. */
    maxDeferred?: number;
  };
}

export interface Intelligence {
  start(): void;
  stop(): Promise<void>;
  /** Enqueue a command with an envelope stamped from the clock. Returns the envelope id. */
  submit(body: CommandBody, source: CommandSource): string;
  /** Feed an already-enveloped command (used by inputs and tests). */
  post(cmd: Command): void;
  phase(): Phase;
  /** Resolves once the mailbox is empty and no effects are in flight. */
  settle(): Promise<void>;
}
