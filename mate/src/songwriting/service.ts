import type { Activity, ActivityKind, ComposeStage, Song, TranscriptField } from "@aibleton/protocol";
import type { BandStore } from "../core/bands.ts";
import { newId } from "../core/commands.ts";
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
  /** The machine request this belongs to, when the loop asked for it. Makes the activity cancellable. */
  requestId?: string;
  /**
   * Put the request into the conversation first. The compose route does, since
   * nothing else speaks for a call straight to the endpoint; the loop does not,
   * because `recordCommand` already wrote the drummer's line when the command
   * arrived, and writing it again says the same thing twice.
   */
  announce?: boolean;
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

/**
 * How much of the compose activity's bar each stage has filled. It stops short
 * of 1 because the free Splice search runs on the end of every compose, and a
 * bar that reaches the end and keeps going is a lie.
 */
const COMPOSE_FRACTION: Record<ComposeStage, number> = {
  picking: 0.1,
  briefing: 0.25,
  recipe: 0.4,
  bands: 0.55,
  rebriefing: 0.7,
  feedback: 0.85,
  layout: 0.9,
  done: 0.95,
  failed: 0.95,
};

/** Move an activity on: a new headline, the facts behind it, and where the bar has got to. */
type ActivityUpdate = (message: string, extra?: { fields?: TranscriptField[]; fraction?: number | null }) => void;

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

    return this.withActivity(
      { kind: "compose", request: opts.text, message: "starting a song", fraction: 0.05, ...(opts.requestId ? { requestId: opts.requestId } : {}) },
      async (update) => {
        const [templates, bands] = await Promise.all([this.deps.templates.list(), this.deps.bands.list()]);
        // The request goes into the conversation before the slow part, so the app shows it while composing.
        if (opts.announce) this.deps.store.appendTranscript({ role: "user", kind: "compose", text: opts.text, at: this.deps.now() });
        // Two audiences: the activity carries the step the session column's bar is on, the
        // conversation keeps every step. That trail is the record of how the song was made,
        // so it stays in the transcript long after the activity is gone.
        const narrate = (stage: ComposeStage, message: string, fields: TranscriptField[] = []) => {
          update(message, { fields, fraction: COMPOSE_FRACTION[stage] });
          this.deps.store.appendTranscript({ role: "mate", kind: "step", text: message, at: this.deps.now(), fields });
        };

        const song = await composeSong({
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

        // Search is free and always wanted, and a guarantee enforced by a prompt is
        // not a guarantee, so it is chained here rather than left to the caller.
        // The song is already saved and active: a failure costs candidates, not the song.
        // It runs under the compose activity, hence `runResolve` rather than `resolve`.
        // The search shares the compose's bar, mapped into the tail of it, so it never runs backwards.
        update("searching Splice for every slot", { fraction: COMPOSE_FRACTION.done });
        const searching: ActivityUpdate = (message, extra) =>
          update(message, { ...extra, fraction: COMPOSE_FRACTION.done + (1 - COMPOSE_FRACTION.done) * (extra?.fraction ?? 0) });
        try {
          return { song: (await this.runResolve(song, opts.signal, searching)).song };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.log.warn(`searching Splice after composing ${song.id} failed: ${message}`);
          const saved = await this.deps.songs.get(song.id);
          return { song: saved ?? song, resolveError: message };
        }
      },
    );
  }

  // ---- slots --------------------------------------------------------------

  /**
   * Search Splice for every slot and store ranked candidates. Free. Slow-ish:
   * a few queries per slot, fanned out, so each slot is saved and published as
   * its candidates land, and the run carries on even if the browser that asked
   * for it goes away (a reload mid-resolve loses nothing).
   */
  async resolve(song: Song, signal: AbortSignal, requestId?: string): Promise<ResolveOutcome> {
    return this.withActivity(
      { kind: "resolve", request: song.request.text, message: "searching Splice for every slot", fraction: 0, ...(requestId ? { requestId } : {}) },
      (update) => this.runResolve(song, signal, update),
    );
  }

  /** Resolves without an activity of its own; `resolve` opens one, `compose` runs it under its own. */
  private runResolve(song: Song, signal: AbortSignal, update: ActivityUpdate): Promise<ResolveOutcome> {
    return this.queue(song, async (fresh) => {
      const total = fresh.plan.slots.length;
      let done = 0;
      const result = await resolveSong(fresh, {
        splice: this.deps.splice,
        log: this.deps.log,
        signal,
        onSlot: async (s) => {
          done += 1;
          update(`searched Splice for ${done} of ${total} slots`, { fraction: total > 0 ? done / total : 1 });
          this.publish(await this.deps.songs.save(reuseDownloaded(s)));
        },
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
  async pick(song: Song, slotId: string, soundUuid: string, requestId?: string): Promise<Song> {
    return this.edit(song, `choosing a sound for ${slotId}`, requestId, async () => {
      const saved = await this.deps.songs.save(reuseDownloaded(pickCandidate(song, slotId, soundUuid)));
      this.publish(saved);
      return saved;
    });
  }

  /**
   * Bring a part in for one occurrence, or rest it.
   * @throws TrackNotFoundError, OccurrenceNotFoundError
   */
  async setPlacement(song: Song, partId: string, occurrence: number, plays: boolean, requestId?: string): Promise<Song> {
    return this.edit(song, `${plays ? "bringing" : "resting"} ${partId} in ${occurrence + 1}`, requestId, async () => {
      const edited = setPlacement(song, partId, occurrence, plays);
      const saved = edited === song ? edited : await this.deps.songs.save(edited);
      this.publish(saved);
      return saved;
    });
  }

  /**
   * Drop a part from the song: its track, its slots and placements. The last track cannot go.
   * @throws TrackNotFoundError, LastTrackError
   */
  async removeTrack(song: Song, partId: string, requestId?: string): Promise<Song> {
    return this.edit(song, `dropping ${partId}`, requestId, async () => {
      const saved = await this.deps.songs.save(removeTrack(song, partId));
      this.publish(saved);
      return saved;
    });
  }

  // ---- Live ---------------------------------------------------------------

  /**
   * Puts whatever the song has on disk into the Live set: creates its tracks
   * on first run (and sets the tempo, once), imports each downloaded sample
   * into the scene for its section, and lays copies along the arrangement.
   * Adds only; a re-run picks up where the last one stopped.
   */
  async arrange(song: Song, signal: AbortSignal, requestId?: string): Promise<ArrangeOutcome> {
    const outcome = await this.withActivity(
      { kind: "arrange", request: song.request.text, message: "looking at your set", fraction: 0, ...(requestId ? { requestId } : {}) },
      (update) => this.queue(song, (fresh) => this.runArrange(fresh, signal, update)),
    );
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
  async download(song: Song, signal: AbortSignal, requestId?: string): Promise<DownloadOutcome> {
    const outcome = await this.withActivity(
      { kind: "download", request: song.request.text, message: "getting the sounds you picked", fraction: 0, ...(requestId ? { requestId } : {}) },
      (update) =>
        this.queue(song, (fresh) =>
          downloadPicks(fresh, {
            splice: this.deps.splice,
            dir: this.deps.downloadsDir,
            log: this.deps.log,
            signal,
            onProgress: async (s) => {
              this.publish(await this.deps.songs.save(s));
              try {
                // `runArrange`, not `arrange`: this song's turn is already held, and the drummer
                // wants one line about the download, not one per file. No activity update either:
                // the credits being spent are what the bar is counting, not the Live steps.
                const arranged = await this.runArrange(s, signal);
                for (const f of arranged.failed) this.deps.log.warn(`arranging after download: ${describeStep(f.step)} failed: ${f.error}`);
                return arranged.song;
              } catch (err) {
                this.deps.log.warn(`arranging after download failed: ${err instanceof Error ? err.message : String(err)}`);
                return s;
              }
            },
            onStatus: (progress) => {
              this.deps.store.events.emit({ type: "download.progress", progress });
              update(
                progress.current ? `getting ${progress.done + 1} of ${progress.total}: ${progress.current.fileName}` : `got ${progress.done} of ${progress.total} sounds`,
                { fraction: progress.total > 0 ? progress.done / progress.total : 1 },
              );
            },
          }),
        ),
    );
    if (outcome.downloaded.length > 0) {
      const n = outcome.downloaded.length;
      this.deps.store.setLastMessage(`got ${n} sound${n === 1 ? "" : "s"} from Splice${outcome.failed.length ? `, ${outcome.failed.length} failed` : ""}`, this.deps.now());
    }
    return outcome;
  }

  /** Runs the steps without saying anything; `arrange` speaks, `download` speaks once for the lot. */
  private runArrange(song: Song, signal: AbortSignal, update?: ActivityUpdate): Promise<ArrangeOutcome> {
    return arrangeSong(song, {
      ableton: this.deps.ableton,
      log: this.deps.log,
      signal,
      userPrompt: song.request.text,
      onProgress: async (s) => this.publish(await this.deps.songs.save(s)),
      onSnapshot: (daw) => this.deps.store.setDaw(daw),
      // Every step is one call into Live, so this is the only honest progress there is: how far
      // through the steps this round found. Later rounds are short, so the bar can go back.
      onStep: (step, index, total) => update?.(`${describeStep(step)} (${index + 1} of ${total})`, { fraction: (index + 1) / total }),
    });
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Everything slow runs inside one of these. The activity is the app's only
   * busy signal, and it belongs to the server: a browser that reloads
   * mid-compose, or a second tab, sees the same work in flight, which a flag
   * in the page never could.
   */
  private async withActivity<T>(
    spec: { kind: ActivityKind; request: string; message: string; fraction?: number | null; requestId?: string },
    fn: (update: ActivityUpdate) => Promise<T>,
  ): Promise<T> {
    const startedAt = this.deps.now();
    let current: Activity = {
      // A run the loop asked for carries the machine's request id, and only that one can be
      // stopped with `cancel`; a click on a button gets an id of its own and cannot.
      requestId: spec.requestId ?? newId("act"),
      kind: spec.kind,
      request: spec.request,
      message: spec.message,
      fields: [],
      fraction: spec.fraction ?? null,
      startedAt,
      at: startedAt,
      cancellable: spec.requestId !== undefined,
    };
    this.deps.store.setActivity(current);
    const update: ActivityUpdate = (message, extra) => {
      current = {
        ...current,
        message,
        fields: extra?.fields ?? [],
        fraction: extra?.fraction === undefined ? current.fraction : extra.fraction,
        at: this.deps.now(),
      };
      this.deps.store.setActivity(current);
    };
    try {
      return await fn(update);
    } finally {
      // By identity, not by id: a compose hands over to the search it chains, and the loop's brain
      // call shares its request id with the action set that follows it. Clearing anything but our
      // own would blank the spinner of whatever started next.
      if (this.deps.store.getActivity() === current) this.deps.store.setActivity(null);
    }
  }

  /** The quick plan edits. Fast, but they still say what is happening: the loop can drive them too. */
  private edit<T>(song: Song, message: string, requestId: string | undefined, fn: () => Promise<T>): Promise<T> {
    return this.withActivity({ kind: "edit", request: song.request.text, message, fraction: null, ...(requestId ? { requestId } : {}) }, () => fn());
  }

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
