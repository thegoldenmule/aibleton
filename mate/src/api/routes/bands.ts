import { Hono } from "hono";
import {
  GenerateBandRequestSchema,
  PutBandRequestSchema,
  type Band,
  type BandListResponse,
  type BandResponse,
  type DeleteBandResponse,
} from "@aibleton/protocol";
import { ModelRefusedError } from "../../core/anthropic.ts";
import { isValidBandId, type BandLibrary } from "../../core/bands.ts";
import type { RecipeBook } from "../../core/recipes.ts";
import type { Logger } from "../../log.ts";
import { GenerateOptionsError, GeneratedInvalidError, RecipeUnavailableError, staffBand } from "../../songwriting/library.ts";

export interface BandRouteDeps {
  /** The log-backed library. Reads come off its fold; a save that cannot reach the log rejects. */
  bands: BandLibrary;
  recipes: RecipeBook;
  log: Logger;
  /** Injected so tests can drive createdAt and the default seed from a ManualClock. */
  now: () => number;
}

export function bandRoutes(deps: BandRouteDeps): Hono {
  const r = new Hono();

  r.get("/bands", async (c) => {
    const body: BandListResponse = { bands: await deps.bands.list() };
    return c.json(body);
  });

  r.get("/bands/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidBandId(id)) return c.json({ error: `invalid band id ${JSON.stringify(id)}` }, 400);
    const band = await deps.bands.get(id);
    if (!band) return c.json({ error: `no band ${id}` }, 404);
    const body: BandResponse = { band };
    return c.json(body);
  });

  r.post("/bands", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = PutBandRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid band", issues: parsed.error.issues }, 400);
    const { band } = parsed.data;
    if (!isValidBandId(band.id)) return c.json({ error: `invalid band id ${JSON.stringify(band.id)}` }, 400);
    const body: BandResponse = { band: await deps.bands.save(band) };
    return c.json(body);
  });

  r.delete("/bands/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidBandId(id)) return c.json({ error: `invalid band id ${JSON.stringify(id)}` }, 400);
    const body: DeleteBandResponse = { deleted: await deps.bands.delete(id) };
    return c.json(body);
  });

  /**
   * Staffs a band and hands it back unsaved; POST /bands persists it. A genre
   * with no recipe has one written by the model first, which is slow.
   */
  r.post("/bands/generate", async (c) => {
    let raw: unknown = {};
    if (c.req.header("content-type")?.includes("application/json")) {
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
    }
    const parsed = GenerateBandRequestSchema.safeParse(raw ?? {});
    if (!parsed.success) return c.json({ error: "invalid options", issues: parsed.error.issues }, 400);

    let band: Band;
    try {
      band = await staffBand(parsed.data, { recipes: deps.recipes, now: deps.now, signal: c.req.raw.signal });
    } catch (err) {
      if (err instanceof ModelRefusedError) return c.json({ error: err.message, category: err.category }, 422);
      if (err instanceof RecipeUnavailableError) {
        deps.log.warn(`recipe for ${JSON.stringify(err.genre)} failed: ${err.reason}`);
        return c.json({ error: err.message }, 502);
      }
      if (err instanceof GenerateOptionsError) return c.json({ error: err.message }, 400);
      if (err instanceof GeneratedInvalidError) return c.json({ error: err.message, issues: err.issues }, 500);
      throw err;
    }

    const body: BandResponse = { band };
    return c.json(body);
  });

  return r;
}
