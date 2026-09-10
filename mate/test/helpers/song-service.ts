import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BandStore } from "../../src/core/bands.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { EventBus } from "../../src/core/events.ts";
import { RecipeBook, RecipeStore } from "../../src/core/recipes.ts";
import { SongStore } from "../../src/core/songs.ts";
import { StateStore } from "../../src/core/state.ts";
import { TemplateStore } from "../../src/core/templates.ts";
import { silentLogger } from "../../src/log.ts";
import type { AbletonPort } from "../../src/ports/ableton/types.ts";
import { InMemoryAbletonAdapter } from "../../src/ports/ableton/stub.ts";
import type { SplicePort } from "../../src/ports/splice/types.ts";
import { FixtureSpliceAdapter } from "../../src/ports/splice/stub.ts";
import { ScriptedBriefer } from "../../src/songwriting/briefer/index.ts";
import { ScriptedRecipeWriter } from "../../src/songwriting/recipe-writer/index.ts";
import { SongService } from "../../src/songwriting/service.ts";
import { fixtureBand, fixtureTemplate } from "./song.ts";

/** A `SongService` on temp directories with every dependency stubbed, plus the parts, for assertions. */
export interface SongServiceHarness {
  service: SongService;
  songs: SongStore;
  templates: TemplateStore;
  bands: BandStore;
  recipes: RecipeBook;
  store: StateStore;
  events: EventBus;
  clock: ManualClock;
  briefer: ScriptedBriefer;
  writer: ScriptedRecipeWriter;
  splice: SplicePort;
  ableton: AbletonPort;
  downloadsDir: string;
}

export interface SongServiceOptions {
  /** Root for the stores; a fresh temp directory by default. */
  dir?: string;
  now?: number;
  briefer?: ScriptedBriefer;
  writer?: ScriptedRecipeWriter;
  splice?: SplicePort;
  ableton?: AbletonPort;
}

/** Synchronous so a test can build one inline; call `seedLibrary` before composing. */
export function songServiceHarness(opts: SongServiceOptions = {}): SongServiceHarness {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "mate-song-service-"));
  const clock = new ManualClock(opts.now ?? 1_000);
  const events = new EventBus();
  const store = new StateStore(events);
  const songs = new SongStore({ dir: join(dir, "songs") });
  const templates = new TemplateStore({ dir: join(dir, "templates") });
  const bands = new BandStore({ dir: join(dir, "bands") });
  const writer = opts.writer ?? new ScriptedRecipeWriter();
  const recipes = new RecipeBook({ store: new RecipeStore({ dir: join(dir, "recipes") }), writer, now: () => clock.now() });
  const briefer = opts.briefer ?? new ScriptedBriefer();
  const splice = opts.splice ?? new FixtureSpliceAdapter();
  const ableton = opts.ableton ?? new InMemoryAbletonAdapter({ now: () => clock.now() });
  const downloadsDir = join(dir, "downloads");
  const service = new SongService({ songs, templates, bands, briefer, recipes, store, splice, ableton, downloadsDir, log: silentLogger, now: () => clock.now() });
  return { service, songs, templates, bands, recipes, store, events, clock, briefer, writer, splice, ableton, downloadsDir };
}

/** The small funk library the pickers need, so `compose` has something to choose. */
export async function seedLibrary(h: SongServiceHarness): Promise<void> {
  await h.templates.save(fixtureTemplate());
  await h.bands.save(fixtureBand());
}

/**
 * The two slow ports, holdable. `hold()` parks every call at a gate until
 * `release()`, so a test can start one service operation, freeze it mid-flight
 * and watch what a second one does. Modelled on `ScriptedBrain.hold()`.
 */
export class FakeSongwriting {
  readonly splice: SplicePort;
  readonly ableton: AbletonPort;
  /** Every gated call, in the order it started: `"splice.searchSounds"`, `"ableton.createAudioTrack"`, … */
  readonly started: string[] = [];
  private holding = false;
  private parked: { resolve: () => void }[] = [];

  constructor(now: () => number = () => 1_000) {
    this.splice = gate(new FixtureSpliceAdapter(), (m) => this.enter(`splice.${m}`));
    this.ableton = gate(new InMemoryAbletonAdapter({ now }), (m) => this.enter(`ableton.${m}`));
  }

  hold(): void {
    this.holding = true;
  }
  release(): void {
    this.holding = false;
    const waiting = this.parked;
    this.parked = [];
    for (const w of waiting) w.resolve();
  }
  /** How many calls are sitting at the gate right now. */
  pendingCount(): number {
    return this.parked.length;
  }
  /** Resolves once at least `n` calls are parked; a test should never spin on its own. */
  async waitForHold(n = 1): Promise<void> {
    while (this.parked.length < n) await new Promise((r) => setTimeout(r, 0));
  }
  /** Calls that started after `mark`, for asserting two operations did not interleave. */
  startedSince(mark: number): string[] {
    return this.started.slice(mark);
  }

  private async enter(name: string): Promise<void> {
    this.started.push(name);
    if (!this.holding) return;
    await new Promise<void>((resolve) => this.parked.push({ resolve }));
  }
}

/** Wraps every method of a port so `before` runs first. The ports are all-async, so this is safe. */
function gate<T extends object>(port: T, before: (method: string) => Promise<void>): T {
  return new Proxy(port, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || prop === "close") return value;
      return async (...args: unknown[]) => {
        await before(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
