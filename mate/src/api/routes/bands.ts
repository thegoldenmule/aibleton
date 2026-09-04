import { Hono } from "hono";
import {
  BandSchema,
  GenerateBandRequestSchema,
  PutBandRequestSchema,
  type Band,
  type BandListResponse,
  type BandResponse,
  type DeleteBandResponse,
} from "@aibleton/protocol";
import { ModelRefusedError } from "../../core/anthropic.ts";
import { isValidBandId, type BandStore } from "../../core/bands.ts";
import type { RecipeBook } from "../../core/recipes.ts";
import type { Logger } from "../../log.ts";
import { generateBand } from "../../core/band-generator.ts";
import { newId } from "../../core/commands.ts";

export interface BandRouteDeps {
  bands: BandStore;
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
    const opts = parsed.data;
    const at = deps.now();
    const seed = opts.seed ?? at;

    if (opts.genre !== undefined) {
      try {
        await deps.recipes.ensure(opts.genre, c.req.raw.signal);
      } catch (err) {
        if (err instanceof ModelRefusedError) return c.json({ error: err.message, category: err.category }, 422);
        const message = err instanceof Error ? err.message : String(err);
        deps.log.warn(`recipe for ${JSON.stringify(opts.genre)} failed: ${message}`);
        return c.json({ error: `could not write a recipe for ${JSON.stringify(opts.genre)}: ${message}` }, 502);
      }
    }

    let staffed: ReturnType<typeof generateBand>;
    try {
      staffed = generateBand(
        {
          seed,
          ...(opts.genre !== undefined ? { genre: opts.genre } : {}),
          ...(opts.size !== undefined ? { size: opts.size } : {}),
        },
        deps.recipes,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const draft: Band = {
      id: newId("band"),
      name: opts.name ?? `${staffed.metadata.genre ?? "mixed"} band ${seed}`,
      parts: staffed.parts,
      metadata: staffed.metadata,
      createdAt: at,
    };
    const checked = BandSchema.safeParse(draft);
    if (!checked.success) {
      return c.json({ error: "generator produced an invalid band", issues: checked.error.issues }, 500);
    }
    const body: BandResponse = { band: checked.data };
    return c.json(body);
  });

  return r;
}
