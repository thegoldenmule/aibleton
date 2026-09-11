import { Hono } from "hono";
import {
  GenerateTemplateRequestSchema,
  PutTemplateRequestSchema,
  type DeleteTemplateResponse,
  type Template,
  type TemplateListResponse,
  type TemplateResponse,
} from "@aibleton/protocol";
import { isValidTemplateId, type TemplateLibrary } from "../../core/templates.ts";
import { GenerateOptionsError, GeneratedInvalidError, layTemplate } from "../../songwriting/library.ts";

export interface TemplateRouteDeps {
  /** The log-backed library. Reads come off its fold; a save that cannot reach the log rejects. */
  templates: TemplateLibrary;
  /** Injected so tests can drive createdAt and the default seed from a ManualClock. */
  now: () => number;
}

export function templateRoutes(deps: TemplateRouteDeps): Hono {
  const r = new Hono();

  r.get("/templates", async (c) => {
    const body: TemplateListResponse = { templates: await deps.templates.list() };
    return c.json(body);
  });

  r.get("/templates/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidTemplateId(id)) return c.json({ error: `invalid template id ${JSON.stringify(id)}` }, 400);
    const template = await deps.templates.get(id);
    if (!template) return c.json({ error: `no template ${id}` }, 404);
    const body: TemplateResponse = { template };
    return c.json(body);
  });

  r.post("/templates", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = PutTemplateRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid template", issues: parsed.error.issues }, 400);
    const { template } = parsed.data;
    if (!isValidTemplateId(template.id)) {
      return c.json({ error: `invalid template id ${JSON.stringify(template.id)}` }, 400);
    }
    const body: TemplateResponse = { template: await deps.templates.save(template) };
    return c.json(body);
  });

  r.delete("/templates/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidTemplateId(id)) return c.json({ error: `invalid template id ${JSON.stringify(id)}` }, 400);
    const body: DeleteTemplateResponse = { deleted: await deps.templates.delete(id) };
    return c.json(body);
  });

  /** Generates a template and hands it back unsaved; POST /templates persists it. */
  r.post("/templates/generate", async (c) => {
    let raw: unknown = {};
    if (c.req.header("content-type")?.includes("application/json")) {
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
    }
    const parsed = GenerateTemplateRequestSchema.safeParse(raw ?? {});
    if (!parsed.success) return c.json({ error: "invalid options", issues: parsed.error.issues }, 400);

    let template: Template;
    try {
      template = layTemplate(parsed.data, { now: deps.now });
    } catch (err) {
      if (err instanceof GenerateOptionsError) return c.json({ error: err.message }, 400);
      if (err instanceof GeneratedInvalidError) return c.json({ error: err.message, issues: err.issues }, 500);
      throw err;
    }

    const body: TemplateResponse = { template };
    return c.json(body);
  });

  return r;
}
