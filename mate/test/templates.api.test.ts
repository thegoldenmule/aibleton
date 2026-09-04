import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryAbletonAdapter } from "../src/ports/ableton/stub.ts";
import { FixtureSpliceAdapter } from "../src/ports/splice/stub.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TemplateListResponseSchema,
  TemplateResponseSchema,
  type Template,
} from "@aibleton/protocol";
import { createApp } from "../src/api/server.ts";
import { EventBus } from "../src/core/events.ts";
import { StateStore } from "../src/core/state.ts";
import { TemplateStore } from "../src/core/templates.ts";
import { BandStore } from "../src/core/bands.ts";
import { SongStore } from "../src/core/songs.ts";
import { ScriptedBriefer } from "../src/songwriting/briefer/index.ts";
import { RecipeBook, RecipeStore } from "../src/core/recipes.ts";
import { ScriptedRecipeWriter } from "../src/songwriting/recipe-writer/index.ts";
import { ManualClock } from "../src/core/clock.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import type { Intelligence } from "../src/intelligence/types.ts";

const idleIntelligence: Intelligence = {
  start() {},
  async stop() {},
  submit: () => "noop",
  post() {},
  phase: () => "idle",
  async settle() {},
};

let dir: string;

function build(now = 1_000) {
  const clock = new ManualClock(now);
  const events = new EventBus();
  const app = createApp({
    store: new StateStore(events),
    templates: new TemplateStore({ dir }),
    bands: new BandStore({ dir: join(dir, "bands") }),
    songs: new SongStore({ dir: join(dir, "songs") }),
    recipes: new RecipeBook({ store: new RecipeStore({ dir: join(dir, "recipes") }), writer: new ScriptedRecipeWriter(), now: () => clock.now() }),
    briefer: new ScriptedBriefer(),
    intelligence: idleIntelligence,
    splice: new FixtureSpliceAdapter(),
    ableton: new InMemoryAbletonAdapter(),
    config: loadConfig({}),
    log: silentLogger,
    startedAt: 0,
    now: () => clock.now(),
  });
  return { app, clock };
}

function template(over: Partial<Template> = {}): Template {
  return {
    id: "jam-1",
    name: "Jam",
    form: "a8 b8 a8 b8",
    sections: { a: { label: "a", brief: "groove" }, b: { label: "b", brief: "lift" } },
    createdAt: 10,
    ...over,
  };
}

async function post(app: ReturnType<typeof build>["app"], path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-templates-api-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("templates api", () => {
  test("GET /templates is empty to start", async () => {
    const { app } = build();
    const res = await app.request("/templates");
    expect(res.status).toBe(200);
    const body = TemplateListResponseSchema.parse(await res.json());
    expect(body.templates).toEqual([]);
  });

  test("POST /templates then GET /templates/:id round-trips", async () => {
    const { app } = build();
    const saved = await post(app, "/templates", { template: template() });
    expect(saved.status).toBe(200);
    expect(TemplateResponseSchema.parse(await saved.json()).template).toEqual(template());

    const got = await app.request("/templates/jam-1");
    expect(got.status).toBe(200);
    expect(TemplateResponseSchema.parse(await got.json()).template).toEqual(template());
  });

  test("GET /templates lists saved templates newest first", async () => {
    const { app } = build();
    await post(app, "/templates", { template: template({ id: "old", createdAt: 1 }) });
    await post(app, "/templates", { template: template({ id: "new", createdAt: 99 }) });
    const body = TemplateListResponseSchema.parse(await (await app.request("/templates")).json());
    expect(body.templates.map((t) => t.id)).toEqual(["new", "old"]);
  });

  test("GET /templates/:id is 404 when missing", async () => {
    const { app } = build();
    expect((await app.request("/templates/nope")).status).toBe(404);
  });

  test("DELETE /templates/:id reports whether it removed anything", async () => {
    const { app } = build();
    await post(app, "/templates", { template: template() });
    expect(await (await app.request("/templates/jam-1", { method: "DELETE" })).json()).toEqual({ deleted: true });
    expect(await (await app.request("/templates/jam-1", { method: "DELETE" })).json()).toEqual({ deleted: false });
  });

  test("POST /templates rejects a form using an undefined section", async () => {
    const { app } = build();
    const res = await post(app, "/templates", { template: template({ form: "a8 b8 c8" }) });
    expect(res.status).toBe(400);
  });

  test("POST /templates rejects a traversal id", async () => {
    const { app } = build();
    const res = await post(app, "/templates", { template: template({ id: "../evil" }) });
    expect(res.status).toBe(400);
  });

  test("GET /templates/:id rejects a traversal id", async () => {
    const { app } = build();
    expect((await app.request("/templates/..%2Fevil")).status).toBe(400);
  });

  test("POST /templates/generate returns an unsaved, valid template", async () => {
    const { app } = build();
    const res = await post(app, "/templates/generate", { seed: 7, alphabet: 3, count: 9 });
    expect(res.status).toBe(200);
    const { template: made } = TemplateResponseSchema.parse(await res.json());
    expect(made.form.split(" ")).toHaveLength(9);
    expect(Object.keys(made.sections).sort()).toEqual(["a", "b", "c"]);
    expect(made.createdAt).toBe(1_000);

    const list = TemplateListResponseSchema.parse(await (await app.request("/templates")).json());
    expect(list.templates).toEqual([]);
  });

  test("POST /templates/generate is deterministic for a seed", async () => {
    const { app } = build();
    const one = TemplateResponseSchema.parse(await (await post(app, "/templates/generate", { seed: 42 })).json());
    const two = TemplateResponseSchema.parse(await (await post(app, "/templates/generate", { seed: 42 })).json());
    expect(one.template.form).toBe(two.template.form);
  });

  test("POST /templates/generate accepts an empty body and defaults the seed from the clock", async () => {
    const { app } = build(555);
    const res = await post(app, "/templates/generate", {});
    expect(res.status).toBe(200);
    const { template: made } = TemplateResponseSchema.parse(await res.json());
    expect(made.name).toBe("Form 555");
  });

  test("POST /templates/generate rejects bad options", async () => {
    const { app } = build();
    expect((await post(app, "/templates/generate", { alphabet: 99 })).status).toBe(400);
  });

  test("a generated template can be saved straight back", async () => {
    const { app } = build();
    const { template: made } = TemplateResponseSchema.parse(
      await (await post(app, "/templates/generate", { seed: 3 })).json(),
    );
    expect((await post(app, "/templates", { template: made })).status).toBe(200);
    const list = TemplateListResponseSchema.parse(await (await app.request("/templates")).json());
    expect(list.templates.map((t) => t.id)).toEqual([made.id]);
  });
});
