import type { ComposeStage, Song, TranscriptField } from "@aibleton/protocol";
import type { BandStore } from "../core/bands.ts";
import type { RecipeBook } from "../core/recipes.ts";
import type { SongStore } from "../core/songs.ts";
import type { StateStore } from "../core/state.ts";
import type { TemplateStore } from "../core/templates.ts";
import type { Logger } from "../log.ts";
import type { AbletonPort } from "../ports/ableton/types.ts";
import type { SplicePort } from "../ports/splice/types.ts";
import type { Briefer } from "./briefer/index.ts";
import { arrangeSong, describeStep, type ArrangeOutcome } from "./arrange.ts";
import { composeSong } from "./compose.ts";
import { downloadPicks, reuseDownloaded, type DownloadOutcome } from "./download.ts";
import { removeTrack, setPlacement } from "./edit.ts";
import { songFields } from "./narrate.ts";
import { pickCandidate, resolveSong } from "./resolve.ts";

/**
 * Every song operation, once. The pure modules (compose, resolve, edit,
 * arrange, download) decide what changes; this is the only place a song is
 * persisted, published to the app and narrated. Two callers: the REST routes,
 * which the drummer's clicks reach directly, and the agent loop, which reaches
 * it through brain actions. Routes keep the Hono plumbing and every status
 * code; nothing in here knows about HTTP.
 *
 * Mutating methods take an explicit `Song` because the routes address
 * `/songs/:id` while the loop always means the active one
 * (`svc.setPlacement(svc.requireActive(), …)`), evaluated when the action is
 * applied rather than when the brain decided on it.
 */

/** Compose was asked for while a song was already active. The drummer clears it first, or says so. */
export class SongAlreadyActiveError extends Error {
  constructor(readonly song: Song) {
    super(`“${song.name}” is already the active song; clear it before composing another`);
  }
}

/** An operation that only makes sense on the active song was asked for with none. */
export class NoActiveSongError extends Error {
  constructor() {
    super("no song is active");
  }
}

export interface ComposeOptions {
  text: string;
  seed?: number;
  name?: string;
  signal: AbortSignal;
  /** Replace whatever is active instead of throwing `SongAlreadyActiveError`. The route always does. */
  replaceActive?: boolean;
}

export interface ComposeOutcome {
  song: Song;
  /** Why the free Splice search that follows a compose did not run. The song is saved and active either way. */
  resolveError?: string;
}

export interface ResolveOutcome {
  song: Song;
  failedSlotIds: string[];
}

export interface SongServiceDeps {
  songs: SongStore;
  templates: TemplateStore;
  bands: BandStore;
  briefer: Briefer;
  recipes: RecipeBook;
  /** Holds the active song, which is what the app's session view renders. */
  store: StateStore;
  /** Searches are free; `downloadAsset` spends credits and is only reached from `download`. */
  splice: SplicePort;
  /** Where the song gets built. Only tracks mate created (named with the [mate] suffix) are ever touched. */
  ableton: AbletonPort;
  /** Where downloaded files land. */
  downloadsDir: string;
  log: Logger;
  /** Injected so tests can drive createdAt and the default seed from a ManualClock. */
  now: () => number;
}

/** Coarse position of each compose stage, for a progress bar. */
const COMPOSE_FRACTION: Record<ComposeStage, number> = {
  picking: 0.1,
  briefing: 0.25,
  recipe: 0.4,
  bands: 0.55,
  rebriefing: 0.7,
  feedback: 0.85,
  layout: 0.9,
  done: 1,
  failed: 1,
};

export class SongService {
  /**
   * One slow operation per song at a time. The brain can now arrange while the
   * drummer presses "build in Live", and Live has no delete: two runs against
   * the same stale snapshot would lay every clip twice. A later caller waits,
   * then sees what the first one did.
   */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: SongServiceDeps) {}

  // ---- library and the active song ----------------------------------------

  current(): Song | null {
    return this.deps.store.getSong();
  }

  /** @throws NoActiveSongError */
  requireActive(): Song {
    const song = this.deps.store.getSong();
    if (!song) throw new NoActiveSongError();
    return song;
  }

  async get(id: string): Promise<Song | null> {
    return this.deps.songs.get(id);
  }

  async list(): Promise<Song[]> {
    return this.deps.songs.list();
  }

  /** Makes a saved song active, or answers null when there is no such song. */
  async activate(id: string): Promise<Song | null> {
    const song = await this.deps.songs.get(id);
    if (song) this.deps.store.setSong(song);
    return song;
  }

  /** Clears the active song and reports what it was. */
  clearActive(): Song | null {
    const song = this.deps.store.getSong();
    this.deps.store.setSong(null);
    return song;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.deps.songs.delete(id);
    if (deleted && this.deps.store.getSong()?.id === id) this.deps.store.setSong(null);
    return deleted;
  }

  // ---- compose ------------------------------------------------------------

  /**
   * Runs the whole flow, persists the song, makes it active, then searches
   * Splice for every slot. Slow: it waits on the model, so an aborted signal
   * abandons the brief.
   * @throws SongAlreadyActiveError, EmptyLibraryError, ModelRefusedError, or whatever the briefer throws.
   */
  async compose(opts: ComposeOptions): Promise<ComposeOutcome> {
    const active = this.deps.store.getSong();
    if (active && opts.replaceActive !== true) throw new SongAlreadyActiveError(active);
    const seed = opts.seed ?? this.deps.now();

    const [templates, bands] = await Promise.all([this.deps.templates.list(), this.deps.bands.list()]);
    // The request goes into the conversation before the slow part, so the app shows it while composing.
    this.deps.store.appendTranscript({ role: "user", kind: "compose", text: opts.text, at: this.deps.now() });
    // Two audiences: the session column's bar reads the stage and fraction, the
    // conversation keeps the words. "done" is left out of the trail because the
    // brief's summary lands there as the bandmate's reply a moment later.
    const narrate = (stage: ComposeStage, message: string, fields: TranscriptField[] = []) => {
      const at = this.deps.now();
      this.deps.store.events.emit({ type: "compose.progress", progress: { request: opts.text, stage, message, fields, fraction: COMPOSE_FRACTION[stage], at } });
      if (stage !== "done") this.deps.store.appendTranscript({ role: "mate", kind: "step", text: message, at, fields });
    };

    let song: Song;
    try {
      song = await composeSong({
        onProgress: narrate,
        text: opts.text,
        seed,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        templates,
        bands,
        briefer: this.deps.briefer,
        recipes: this.deps.recipes,
        saveBand: (band) => this.deps.bands.save(band),
        now: this.deps.now,
        signal: opts.signal,
      });
      await this.deps.songs.save(song);
      this.deps.store.setSong(song);
      // The closing reply carries the same facts the trail built up, so the song is legible at a glance later.
      this.deps.store.setLastMessage(song.brief.summary, this.deps.now(), undefined, songFields(song.template, song.band, song.brief, song.plan));
      narrate("done", `composed “${song.name}”`);
    } catch (err) {
      narrate("failed", err instanceof Error ? err.message : String(err));
      throw err;
    }

    // Search is free and always wanted, and a guarantee enforced by a prompt is
    // not a guarantee, so it is chained here rather than left to the caller.
    // The song is already saved and active: a failure costs candidates, not the song.
    try {
      return { song: (await this.resolve(song, opts.signal)).song };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.warn(`searching Splice after composing ${song.id} failed: ${message}`);
      const saved = await this.deps.songs.get(song.id);
      return { song: saved ?? song, resolveError: message };
    }
  }

  // ---- slots --------------------------------------------------------------

  /**
   * Search Splice for every slot and store ranked candidates. Free. Slow-ish:
   * a few queries per slot, fanned out, so each slot is saved and published as
   * its candidates land, and the run carries on even if the browser that asked
   * for it goes away (a reload mid-resolve loses nothing).
   */
  async resolve(song: Song, signal: AbortSignal): Promise<ResolveOutcome> {
    return this.queue(song, async (fresh) => {
      const result = await resolveSong(fresh, {
        splice: this.deps.splice,
        log: this.deps.log,
        signal,
        onSlot: async (s) => this.publish(await this.deps.songs.save(reuseDownloaded(s))),
      });
      // A pick that another slot already has on disk is reused for free.
      const saved = await this.deps.songs.save(reuseDownloaded(result.song));
      this.publish(saved);
      return { song: saved, failedSlotIds: result.failedSlotIds };
    });
  }

  /**
   * Choose which candidate a slot downloads.
   * @throws SlotNotFoundError, NotACandidateError
   */
  async pick(song: Song, slotId: string, soundUuid: string): Promise<Song> {
    const saved = await this.deps.songs.save(reuseDownloaded(pickCandidate(song, slotId, soundUuid)));
    this.publish(saved);
    return saved;
  }

  /**
   * Bring a part in for one occurrence, or rest it.
   * @throws TrackNotFoundError, OccurrenceNotFoundError
   */
  async setPlacement(song: Song, partId: string, occurrence: number, plays: boolean): Promise<Song> {
    const edited = setPlacement(song, partId, occurrence, plays);
    const saved = edited === song ? edited : await this.deps.songs.save(edited);
    this.publish(saved);
    return saved;
  }

  /**
   * Drop a part from the song: its track, its slots and placements. The last track cannot go.
   * @throws TrackNotFoundError, LastTrackError
   */
  async removeTrack(song: Song, partId: string): Promise<Song> {
    const saved = await this.deps.songs.save(removeTrack(song, partId));
    this.publish(saved);
    return saved;
  }

  // ---- Live ---------------------------------------------------------------

  /**
   * Puts whatever the song has on disk into the Live set: creates its tracks
   * on first run (and sets the tempo, once), imports each downloaded sample
   * into the scene for its section, and lays copies along the arrangement.
   * Adds only; a re-run picks up where the last one stopped.
   */
  async arrange(song: Song, signal: AbortSignal): Promise<ArrangeOutcome> {
    const outcome = await this.queue(song, (fresh) => this.runArrange(fresh, signal));
    if (outcome.applied.length > 0 || outcome.failed.length > 0) {
      const n = outcome.applied.length;
      this.deps.store.setLastMessage(
        `${n} step${n === 1 ? "" : "s"} in Live${outcome.failed.length ? `, ${outcome.failed.length} failed` : ""}${outcome.status.notes.length ? `; ${outcome.status.notes[0]}` : ""}`,
        this.deps.now(),
      );
    }
    return outcome;
  }

  /**
   * The paid step: download every pending pick, one credit per distinct new
   * asset. Each file that lands is saved and published before the next one
   * starts, so a dropped connection loses nothing already paid for, and is put
   * into Live right away, so the set fills in as the sounds arrive. Partial
   * failure is not an error: read `failed`.
   */
  async download(song: Song, signal: AbortSignal): Promise<DownloadOutcome> {
    const outcome = await this.queue(song, (fresh) => downloadPicks(fresh, {
      splice: this.deps.splice,
      dir: this.deps.downloadsDir,
      log: this.deps.log,
      signal,
      onProgress: async (s) => {
        this.publish(await this.deps.songs.save(s));
        try {
          // `runArrange`, not `arrange`: this song's turn is already held, and
          // the drummer wants one line about the download, not one per file.
          const arranged = await this.runArrange(s, signal);
          for (const f of arranged.failed) this.deps.log.warn(`arranging after download: ${describeStep(f.step)} failed: ${f.error}`);
          return arranged.song;
        } catch (err) {
          this.deps.log.warn(`arranging after download failed: ${err instanceof Error ? err.message : String(err)}`);
          return s;
        }
      },
      onStatus: (progress) => this.deps.store.events.emit({ type: "download.progress", progress }),
    }));
    if (outcome.downloaded.length > 0) {
      const n = outcome.downloaded.length;
      this.deps.store.setLastMessage(`got ${n} sound${n === 1 ? "" : "s"} from Splice${outcome.failed.length ? `, ${outcome.failed.length} failed` : ""}`, this.deps.now());
    }
    return outcome;
  }

  /** Runs the steps without saying anything; `arrange` speaks, `download` speaks once for the lot. */
  private runArrange(song: Song, signal: AbortSignal): Promise<ArrangeOutcome> {
    return arrangeSong(song, {
      ableton: this.deps.ableton,
      log: this.deps.log,
      signal,
      userPrompt: song.request.text,
      onProgress: async (s) => this.publish(await this.deps.songs.save(s)),
      onSnapshot: (session) => this.deps.store.setSession(session),
    });
  }

  // ---- internals ----------------------------------------------------------

  /** Push an updated song to the app, but only if it is the active one: never activate a library song by side effect. */
  private publish(song: Song): void {
    if (this.deps.store.getSong()?.id === song.id) this.deps.store.setSong(song);
  }

  /**
   * Runs `fn` on the latest saved version of the song, behind anything already
   * running for it. Both halves matter: serialising alone would still hand the
   * second caller the copy it was holding before the first one changed
   * anything, and it would build the whole song in Live a second time.
   */
  private queue<T>(song: Song, fn: (fresh: Song) => Promise<T>): Promise<T> {
    return this.single(song.id, async () => fn((await this.deps.songs.get(song.id)) ?? song));
  }

  /** Queues `fn` behind anything already running for this song, so the two never interleave. */
  private single<T>(songId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.inFlight.get(songId);
    const run = before ? before.then(fn) : fn();
    const settled = run.then(
      () => {},
      () => {},
    );
    this.inFlight.set(songId, settled);
    void settled.then(() => {
      if (this.inFlight.get(songId) === settled) this.inFlight.delete(songId);
    });
    return run;
  }
}
