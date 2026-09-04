import { Hono } from "hono";
import {
  ComposeSongRequestSchema,
  type ActiveSongResponse,
  type DeleteSongResponse,
  type SongListResponse,
  type SongResponse,
} from "@aibleton/protocol";
import type { BandStore } from "../../core/bands.ts";
import { isValidSongId, type SongStore } from "../../core/songs.ts";
import type { StateStore } from "../../core/state.ts";
import type { TemplateStore } from "../../core/templates.ts";
import type { Logger } from "../../log.ts";
import { BriefRefusedError, type Briefer } from "../../songwriting/briefer/index.ts";
import { composeSong } from "../../songwriting/compose.ts";
import { EmptyLibraryError } from "../../songwriting/pick.ts";

export interface SongRouteDeps {
  songs: SongStore;
  templates: TemplateStore;
  bands: BandStore;
  briefer: Briefer;
  /** Holds the active song, which is what the app's session view renders. */
  store: StateStore;
  log: Logger;
  /** Injected so tests can drive createdAt and the default seed from a ManualClock. */
  now: () => number;
}

export function songRoutes(deps: SongRouteDeps): Hono {
  const r = new Hono();

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
    try {
      const song = await composeSong({
        text: opts.text,
        seed,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        templates,
        bands,
        briefer: deps.briefer,
        now: deps.now,
        signal: c.req.raw.signal,
      });
      await deps.songs.save(song);
      deps.store.setSong(song);
      const body: SongResponse = { song };
      return c.json(body);
    } catch (err) {
      if (err instanceof EmptyLibraryError) {
        return c.json({ error: `${err.message} (see /templates and /bands)`, library: err.library }, 409);
      }
      if (err instanceof BriefRefusedError) {
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
