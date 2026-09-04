import type { Clock, TimerHandle } from "../core/clock.ts";
import type { Intelligence } from "../intelligence/types.ts";

/**
 * Kicks the agent loop with an initial `tick` shortly after startup.
 *
 * Tick cadence lives in the AgentLoop itself (it re-arms a timeout after each tick using
 * the shared Clock), so this source deliberately fires once. It exists so the first tick
 * is an explicit, stoppable input rather than a side effect of constructing the loop.
 */
export class TickSource {
  private handle: TimerHandle | null = null;

  constructor(
    private readonly intelligence: Intelligence,
    private readonly clock: Clock,
    private readonly initialDelayMs = 0,
  ) {}

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.clock.setTimeout(() => {
      this.handle = null;
      this.intelligence.submit({ type: "tick" }, "timer");
    }, this.initialDelayMs);
  }

  stop(): void {
    if (this.handle !== null) {
      this.clock.clearTimeout(this.handle);
      this.handle = null;
    }
  }
}
