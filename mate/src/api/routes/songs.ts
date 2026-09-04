import { Hono } from "hono";
import {
  ComposeSongRequestSchema,
  PickSlotRequestSchema,
  type ActiveSongResponse,
  type ArrangeSongResponse,
  type ComposeStage,
  type DeleteSongResponse,
  type DownloadSongResponse,
  type ResolveSongResponse,
  type Song,
  type SongListResponse,
  type SongResponse,
} from "@aibleton/protocol";
import type { BandStore } from "../../core/bands.ts";
import type { RecipeBook } from "../../core/recipes.ts";
import { isValidSongId, type SongStore } from "../../core/songs.ts";
import type { StateStore } from "../../core/state.ts";
import type { TemplateStore } from "../../core/templates.ts";
import type { Logger } from "../../log.ts";
import { ModelRefusedError } from "../../core/anthropic.ts";
import type { AbletonPort } from "../../ports/ableton/types.ts";
import type { SplicePort } from "../../ports/splice/types.ts";
import type { Briefer } from "../../songwriting/briefer/index.ts";
import { arrangeSong, describeStep } from "../../songwriting/arrange.ts";
import { composeSong } from "../../songwriting/compose.ts";
import { downloadPicks, downloadPlan, reuseDownloaded } from "../../songwriting/download.ts";
import { LastTrackError, TrackNotFoundError, removeTrack } from "../../songwriting/edit.ts";
import { EmptyLibraryError } from "../../songwriting/pick.ts";
import { NotACandidateError, SlotNotFoundError, pickCandidate, resolveSong } from "../../songwriting/resolve.ts";

export interface SongRouteDeps {
  songs: SongStore;
  templates: TemplateStore;
  bands: BandStore;
  briefer: Briefer;
  recipes: RecipeBook;
  /** Holds the active song, which is what the app's session view renders. */
  store: StateStore;
  /** Searches are free; `downloadAsset` spends credits and is only reached from POST /songs/:id/download. */
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
  layout: 0.9,
  done: 1,
  failed: 1,
};

export function songRoutes(deps: SongRouteDeps): Hono {
  const r = new Hono();

  /** Push an updated song to the app, but only if it is the active one: never activate a library song by side effect. */
  const publish = (song: Song) => {
    if (deps.store.getSong()?.id === song.id) deps.store.setSong(song);
  };

  /** Loads the song for an `/songs/:id/...` route, or answers 400/404. */
  const load = async (c: { req: { param(name: "id"): string }; json: (body: unknown, status: 400 | 404) => Response }) => {
    const id = c.req.param("id");
    if (!isValidSongId(id)) return { error: c.json({ error: `invalid song id ${JSON.stringify(id)}` }, 400) };
    const song = await deps.songs.get(id);
    if (!song) return { error: c.json({ error: `no song ${id}` }, 404) };
    return { song };
  };

  r.get("/songs", async (c) => {
    const body: SongListResponse = { songs: await deps.songs.list() };
    return c.json(body);
  });

  /**
   * Runs the whole flow, persists the song and makes it active. Slow: it
   * waits on the model, so a client disconnect aborts the brief.
   */
  r.post("/songs/compose", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = ComposeSongRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const opts = parsed.data;
    const seed = opts.seed ?? deps.now();

    const [templates, bands] = await Promise.all([deps.templates.list(), deps.bands.list()]);
    // The request goes into the conversation before the slow part, so the app shows it while composing.
    deps.store.appendTranscript({ role: "user", kind: "compose", text: opts.text, at: deps.now() });
    const narrate = (stage: ComposeStage, message: string) =>
      deps.store.events.emit({ type: "compose.progress", progress: { request: opts.text, stage, message, fraction: COMPOSE_FRACTION[stage], at: deps.now() } });
    try {
      const song = await composeSong({
        onProgress: narrate,
        text: opts.text,
        seed,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        templates,
        bands,
        briefer: deps.briefer,
        recipes: deps.recipes,
        saveBand: (band) => deps.bands.save(band),
        now: deps.now,
        signal: c.req.raw.signal,
      });
      await deps.songs.save(song);
      deps.store.setSong(song);
      deps.store.setLastMessage(song.brief.summary, deps.now());
      narrate("done", `composed “${song.name}”`);
      const body: SongResponse = { song };
      return c.json(body);
    } catch (err) {
      narrate("failed", err instanceof Error ? err.message : String(err));
      if (err instanceof EmptyLibraryError) {
        return c.json({ error: `${err.message} (see /templates and /bands)`, library: err.library }, 409);
      }
      if (err instanceof ModelRefusedError) {
        return c.json({ error: err.message, category: err.category }, 422);
      }
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn(`compose failed: ${message}`);
      return c.json({ error: `could not compose a song: ${message}` }, 502);
    }
  });

  /** Clears the active song; the command bar goes back to composing. Registered before /songs/:id. */
  r.delete("/songs/active", (c) => {
    const body: ActiveSongResponse = { song: deps.store.getSong() };
    deps.store.setSong(null);
    return c.json(body);
  });

  r.get("/songs/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidSongId(id)) return c.json({ error: `invalid song id ${JSON.stringify(id)}` }, 400);
    const song = await deps.songs.get(id);
    if (!song) return c.json({ error: `no song ${id}` }, 404);
    const body: SongResponse = { song };
    return c.json(body);
  });

  r.post("/songs/:id/activate", async (c) => {
    const id = c.req.param("id");
    if (!isValidSongId(id)) return c.json({ error: `invalid song id ${JSON.stringify(id)}` }, 400);
    const song = await deps.songs.get(id);
    if (!song) return c.json({ error: `no song ${id}` }, 404);
    deps.store.setSong(song);
    const body: SongResponse = { song };
    return c.json(body);
  });

  /**
   * Search Splice for every slot and store ranked candidates. Free. Reads no
   * body. Slow-ish: a few queries per slot, fanned out, so each slot is saved
   * and published as its candidates land, and the run carries on even if the
   * browser that asked for it goes away (a reload mid-resolve loses nothing).
   */
  r.post("/songs/:id/resolve", async (c) => {
    const loaded = await load(c);
    if ("error" in loaded) return loaded.error;
    try {
      const result = await resolveSong(loaded.song, {
        splice: deps.splice,
        log: deps.log,
        signal: new AbortController().signal,
        onSlot: async (song) => publish(await deps.songs.save(reuseDownloaded(song))),
      });
      // A pick that another slot already has on disk is reused for free.
      const saved = await deps.songs.save(reuseDownloaded(result.song));
      publish(saved);
      const body: ResolveSongResponse = { song: saved, failedSlotIds: result.failedSlotIds };
      return c.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn(`resolve failed for ${loaded.song.id}: ${message}`);
      return c.json({ error: `could not search Splice: ${message}` }, 502);
    }
  });

  /** Choose which candidate a slot downloads. */
  r.post("/songs/:id/pick", async (c) => {
    const loaded = await load(c);
    if ("error" in loaded) return loaded.error;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = PickSlotRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    try {
      const saved = await deps.songs.save(reuseDownloaded(pickCandidate(loaded.song, parsed.data.slotId, parsed.data.soundUuid)));
      publish(saved);
      const body: SongResponse = { song: saved };
      return c.json(body);
    } catch (err) {
      if (err instanceof SlotNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof NotACandidateError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  /**
   * Puts whatever the song has on disk into the Live set: creates its tracks
   * on first run (and sets the tempo, once), imports each downloaded sample
   * into the scene for its section, and lays copies along the arrangement.
   * Adds only; a re-run picks up where the last one stopped.
   */
  const arrange = async (song: Song, signal: AbortSignal) =>
    arrangeSong(song, {
      ableton: deps.ableton,
      log: deps.log,
      signal,
      userPrompt: song.request.text,
      onProgress: async (s) => publish(await deps.songs.save(s)),
      onSnapshot: (session) => deps.store.setSession(session),
    });

  /**
   * The paid step: download every pending pick, one credit per distinct new
   * asset. Reads no body; the app confirms with the user first. Each file that
   * lands is saved and published before the next one starts, so a dropped
   * connection loses nothing already paid for, and is put into Live right
   * away, so the set fills in as the sounds arrive. Partial failure is a 200.
   */
  r.post("/songs/:id/download", async (c) => {
    const loaded = await load(c);
    if ("error" in loaded) return loaded.error;
    if (downloadPlan(loaded.song).length === 0) return c.json({ error: "nothing picked that is not already downloaded" }, 409);
    const outcome = await downloadPicks(loaded.song, {
      splice: deps.splice,
      dir: deps.downloadsDir,
      log: deps.log,
      signal: c.req.raw.signal,
      onProgress: async (song) => {
        publish(await deps.songs.save(song));
        try {
          const arranged = await arrange(song, c.req.raw.signal);
          for (const f of arranged.failed) deps.log.warn(`arranging after download: ${describeStep(f.step)} failed: ${f.error}`);
          return arranged.song;
        } catch (err) {
          deps.log.warn(`arranging after download failed: ${err instanceof Error ? err.message : String(err)}`);
          return song;
        }
      },
      onStatus: (progress) => deps.store.events.emit({ type: "download.progress", progress }),
    });
    if (outcome.downloaded.length > 0) {
      const n = outcome.downloaded.length;
      deps.store.setLastMessage(`got ${n} sound${n === 1 ? "" : "s"} from Splice${outcome.failed.length ? `, ${outcome.failed.length} failed` : ""}`, deps.now());
    }
    const body: DownloadSongResponse = { song: outcome.song, downloaded: outcome.downloaded, failed: outcome.failed };
    return c.json(body);
  });

  /** Build the song in Live from what is on disk. Reads no body. Partial failure is a 200: read `failed`. */
  r.post("/songs/:id/arrange", async (c) => {
    const loaded = await load(c);
    if ("error" in loaded) return loaded.error;
    const outcome = await arrange(loaded.song, c.req.raw.signal);
    if (outcome.applied.length > 0 || outcome.failed.length > 0) {
      const n = outcome.applied.length;
      deps.store.setLastMessage(
        `${n} step${n === 1 ? "" : "s"} in Live${outcome.failed.length ? `, ${outcome.failed.length} failed` : ""}${outcome.status.notes.length ? `; ${outcome.status.notes[0]}` : ""}`,
        deps.now(),
      );
    }
    const body: ArrangeSongResponse = {
      song: outcome.song,
      applied: outcome.applied.map(describeStep),
      failed: outcome.failed.map((f) => ({ step: describeStep(f.step), error: f.error })),
      notes: outcome.status.notes,
    };
    return c.json(body);
  });

  /** Drop a part from the song: its track, its slots and placements. The last track cannot go. */
  r.delete("/songs/:id/tracks/:partId", async (c) => {
    const loaded = await load(c);
    if ("error" in loaded) return loaded.error;
    try {
      const saved = await deps.songs.save(removeTrack(loaded.song, c.req.param("partId")));
      publish(saved);
      const body: SongResponse = { song: saved };
      return c.json(body);
    } catch (err) {
      if (err instanceof TrackNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof LastTrackError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  r.delete("/songs/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidSongId(id)) return c.json({ error: `invalid song id ${JSON.stringify(id)}` }, 400);
    const deleted = await deps.songs.delete(id);
    if (deleted && deps.store.getSong()?.id === id) deps.store.setSong(null);
    const body: DeleteSongResponse = { deleted };
    return c.json(body);
  });

  return r;
}
