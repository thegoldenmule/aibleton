import { Hono } from "hono";
import {
  ComposeSongRequestSchema,
  PickSlotRequestSchema,
  SetPlacementRequestSchema,
  type ActiveSongResponse,
  type ArrangeSongResponse,
  type DeleteSongResponse,
  type DownloadSongResponse,
  type ResolveSongResponse,
  type SongListResponse,
  type SongResponse,
} from "@aibleton/protocol";
import { isValidSongId } from "../../core/songs.ts";
import type { Logger } from "../../log.ts";
import { ModelRefusedError } from "../../core/anthropic.ts";
import { describeStep } from "../../songwriting/arrange.ts";
import { downloadPlan } from "../../songwriting/download.ts";
import { LastTrackError, OccurrenceNotFoundError, TrackNotFoundError } from "../../songwriting/edit.ts";
import { EmptyLibraryError } from "../../songwriting/pick.ts";
import { NotACandidateError, SlotNotFoundError } from "../../songwriting/resolve.ts";
import type { SongService } from "../../songwriting/service.ts";

/**
 * The drummer's clicks. Every song operation lives in `SongService`; this file
 * is Hono plumbing, zod parsing and the status codes — the one thing an HTTP
 * caller needs that the agent loop does not.
 */
export interface SongRouteDeps {
  /** The single implementation of every song operation; the loop calls the same one. */
  songs: SongService;
  log: Logger;
}

export function songRoutes(deps: SongRouteDeps): Hono {
  const r = new Hono();

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
   * waits on the model, so a client disconnect aborts the brief. Replaces
   * whatever was active: the drummer pressed the button, so they meant it.
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
    try {
      const outcome = await deps.songs.compose({
        text: opts.text,
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        signal: c.req.raw.signal,
        replaceActive: true,
      });
      const body: SongResponse = { song: outcome.song };
      return c.json(body);
    } catch (err) {
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
    const body: ActiveSongResponse = { song: deps.songs.clearActive() };
    return c.json(body);
  });

  r.get("/songs/:id", async (c) => {
    const loaded = await load(c);
    if ("error" in loaded) return loaded.error;
    const body: SongResponse = { song: loaded.song };
    return c.json(body);
  });

  r.post("/songs/:id/activate", async (c) => {
    const id = c.req.param("id");
    if (!isValidSongId(id)) return c.json({ error: `invalid song id ${JSON.stringify(id)}` }, 400);
    const song = await deps.songs.activate(id);
    if (!song) return c.json({ error: `no song ${id}` }, 404);
    const body: SongResponse = { song };
    return c.json(body);
  });

  /**
   * Search Splice for every slot and store ranked candidates. Free. Reads no
   * body. Slow-ish, and the run carries on even if the browser that asked for
   * it goes away, so it gets a signal of its own rather than the request's.
   */
  r.post("/songs/:id/resolve", async (c) => {
    const loaded = await load(c);
    if ("error" in loaded) return loaded.error;
    try {
      const result = await deps.songs.resolve(loaded.song, new AbortController().signal);
      const body: ResolveSongResponse = { song: result.song, failedSlotIds: result.failedSlotIds };
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
      const body: SongResponse = { song: await deps.songs.pick(loaded.song, parsed.data.slotId, parsed.data.soundUuid) };
      return c.json(body);
    } catch (err) {
      if (err instanceof SlotNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof NotACandidateError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  /**
   * The paid step: download every pending pick, one credit per distinct new
   * asset. Reads no body; the app confirms with the user first. Never a brain
   * tool. Partial failure is a 200.
   */
  r.post("/songs/:id/download", async (c) => {
    const loaded = await load(c);
    if ("error" in loaded) return loaded.error;
    if (downloadPlan(loaded.song).length === 0) return c.json({ error: "nothing picked that is not already downloaded" }, 409);
    const outcome = await deps.songs.download(loaded.song, c.req.raw.signal);
    const body: DownloadSongResponse = { song: outcome.song, downloaded: outcome.downloaded, failed: outcome.failed };
    return c.json(body);
  });

  /** Build the song in Live from what is on disk. Reads no body. Partial failure is a 200: read `failed`. */
  r.post("/songs/:id/arrange", async (c) => {
    const loaded = await load(c);
    if ("error" in loaded) return loaded.error;
    const outcome = await deps.songs.arrange(loaded.song, c.req.raw.signal);
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
      const body: SongResponse = { song: await deps.songs.removeTrack(loaded.song, c.req.param("partId")) };
      return c.json(body);
    } catch (err) {
      if (err instanceof TrackNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof LastTrackError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  /** Bring a part in for one occurrence, or rest it. */
  r.put("/songs/:id/placements", async (c) => {
    const loaded = await load(c);
    if ("error" in loaded) return loaded.error;
    const parsed = SetPlacementRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "body must be { partId, occurrence, plays }" }, 400);
    const { partId, occurrence, plays } = parsed.data;
    try {
      const body: SongResponse = { song: await deps.songs.setPlacement(loaded.song, partId, occurrence, plays) };
      return c.json(body);
    } catch (err) {
      if (err instanceof TrackNotFoundError || err instanceof OccurrenceNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  r.delete("/songs/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidSongId(id)) return c.json({ error: `invalid song id ${JSON.stringify(id)}` }, 400);
    const body: DeleteSongResponse = { deleted: await deps.songs.delete(id) };
    return c.json(body);
  });

  return r;
}
