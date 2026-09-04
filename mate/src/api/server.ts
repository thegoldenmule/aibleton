import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Config } from "../config.ts";
import type { StateStore } from "../core/state.ts";
import type { BandStore } from "../core/bands.ts";
import type { RecipeBook } from "../core/recipes.ts";
import type { SongStore } from "../core/songs.ts";
import type { TemplateStore } from "../core/templates.ts";
import type { Intelligence } from "../intelligence/types.ts";
import type { Logger } from "../log.ts";
import type { AbletonPort } from "../ports/ableton/types.ts";
import type { SplicePort } from "../ports/splice/types.ts";
import type { Briefer } from "../songwriting/briefer/index.ts";
import { adaptersRoutes } from "./routes/adapters.ts";
import { commandRoutes } from "./routes/commands.ts";
import { eventRoutes } from "./routes/events.ts";
import { healthRoutes } from "./routes/health.ts";
import { stateRoutes } from "./routes/state.ts";
import { bandRoutes } from "./routes/bands.ts";
import { recipeRoutes } from "./routes/recipes.ts";
import { songRoutes } from "./routes/songs.ts";
import { templateRoutes } from "./routes/templates.ts";

export interface AppDeps {
  store: StateStore;
  templates: TemplateStore;
  bands: BandStore;
  songs: SongStore;
  /** Every recipe the band generator can staff from; fills gaps through the model. */
  recipes: RecipeBook;
  /** Writes the brief for POST /songs/compose. */
  briefer: Briefer;
  intelligence: Intelligence;
  /** Searches and downloads for the song routes. Downloads spend credits. */
  splice: SplicePort;
  /** Where songs get built; the song routes touch only the tracks mate created. */
  ableton: AbletonPort;
  config: Config;
  log: Logger;
  startedAt: number;
  /** Current mailbox depth, reported by POST /commands. Defaults to 0 when not provided. */
  mailboxSize?: () => number;
  /** Wall clock for template createdAt and default seeds. Defaults to Date.now. */
  now?: () => number;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: deps.config.corsOrigin,
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  app.onError((err, c) => {
    deps.log.error(`unhandled error on ${c.req.method} ${c.req.path}`, err);
    return c.json({ error: err.message }, 500);
  });

  app.route("/", healthRoutes(deps.startedAt));
  app.route("/", stateRoutes(deps.store));
  app.route("/", adaptersRoutes(deps.store));
  app.route(
    "/",
    commandRoutes({
      store: deps.store,
      intelligence: deps.intelligence,
      mailboxSize: deps.mailboxSize ?? (() => 0),
    }),
  );
  const now = deps.now ?? (() => Date.now());
  app.route("/", templateRoutes({ templates: deps.templates, now }));
  app.route("/", bandRoutes({ bands: deps.bands, recipes: deps.recipes, log: deps.log, now }));
  app.route("/", recipeRoutes({ recipes: deps.recipes }));
  app.route(
    "/",
    songRoutes({
      songs: deps.songs,
      templates: deps.templates,
      bands: deps.bands,
      briefer: deps.briefer,
      recipes: deps.recipes,
      store: deps.store,
      splice: deps.splice,
      ableton: deps.ableton,
      downloadsDir: deps.config.downloadsDir,
      log: deps.log,
      now,
    }),
  );
  app.route("/", eventRoutes(deps.store, deps.log));

  app.notFound((c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404));

  return app;
}

export function startServer(app: Hono, port: number, log: Logger) {
  const server = Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 });
  log.info(`api listening on http://localhost:${server.port}`);
  return server;
}
