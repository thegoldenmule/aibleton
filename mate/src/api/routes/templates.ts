import { Hono } from "hono";
import {
  GenerateTemplateRequestSchema,
  formLabels,
  parseForm,
  PutTemplateRequestSchema,
  TemplateSchema,
  type DeleteTemplateResponse,
  type Template,
  type TemplateListResponse,
  type TemplateResponse,
} from "@aibleton/protocol";
import { newId } from "../../core/commands.ts";
import { defaultSections, generateForm } from "../../core/generator.ts";
import { isValidTemplateId, type TemplateStore } from "../../core/templates.ts";

export interface TemplateRouteDeps {
  templates: TemplateStore;
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
    const opts = parsed.data;
    const at = deps.now();
    const seed = opts.seed ?? at;

    let form: string;
    try {
      form = generateForm({
        seed,
        ...(opts.alphabet !== undefined ? { alphabet: opts.alphabet } : {}),
        ...(opts.count !== undefined ? { count: opts.count } : {}),
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.maxRun !== undefined ? { maxRun: opts.maxRun } : {}),
        ...(opts.bars !== undefined ? { bars: opts.bars } : {}),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const draft: Template = {
      id: newId("tpl"),
      name: opts.name ?? `Form ${seed}`,
      form,
      sections: defaultSections(formLabels(parseForm(form))),
      ...(opts.bpm !== undefined ? { bpm: opts.bpm } : {}),
      createdAt: at,
    };
    const checked = TemplateSchema.safeParse(draft);
    if (!checked.success) {
      return c.json({ error: "generator produced an invalid template", issues: checked.error.issues }, 500);
    }
    const body: TemplateResponse = { template: checked.data };
    return c.json(body);
  });

  return r;
}
