import type { Brain, BrainInput, Decision } from "./types.ts";

export type Script = Decision[] | ((input: BrainInput, callIndex: number) => Decision | Promise<Decision>);

const DEFAULT_DECISION: Decision = {
  message: "I'm listening. Tell me what you want to work on and I'll set something up.",
  actions: [],
};

/**
 * Deterministic brain for tests and for running mate with no Anthropic credentials.
 * Pops decisions off a script, records every input, and can be told to fail or hang.
 */
export class ScriptedBrain implements Brain {
  readonly kind = "scripted" as const;
  readonly calls: BrainInput[] = [];
  private queue: Decision[] = [];
  private fn: ((input: BrainInput, callIndex: number) => Decision | Promise<Decision>) | null = null;
  private failNext: Error | null = null;
  private hangs: { resolve: () => void }[] = [];
  private holding = false;

  constructor(script: Script = [], private readonly fallback: Decision = DEFAULT_DECISION) {
    if (typeof script === "function") this.fn = script;
    else this.queue = [...script];
  }

  /** Add decisions to the end of the script. */
  push(...decisions: Decision[]): void {
    this.queue.push(...decisions);
  }

  /** The next decide() call rejects with this error. */
  rejectNext(error: Error = new Error("scripted brain failure")): void {
    this.failNext = error;
  }

  /** While holding, decide() waits until release() is called (or the signal aborts). */
  hold(): void {
    this.holding = true;
  }
  release(): void {
    this.holding = false;
    const waiting = this.hangs;
    this.hangs = [];
    for (const w of waiting) w.resolve();
  }
  pendingCount(): number {
    return this.hangs.length;
  }

  async decide(input: BrainInput, signal: AbortSignal): Promise<Decision> {
    const index = this.calls.length;
    this.calls.push(input);
    if (this.holding) {
      await new Promise<void>((resolve, reject) => {
        const entry = { resolve };
        this.hangs.push(entry);
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (signal.aborted) throw new Error("aborted");
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    if (this.fn) return this.fn(input, index);
    return this.queue.shift() ?? this.fallback;
  }
}
