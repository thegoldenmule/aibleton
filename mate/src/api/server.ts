import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Config } from "../config.ts";
import type { SessionManager } from "../core/sessions.ts";
import type { StateStore } from "../core/state.ts";
import type { BandLibrary } from "../core/bands.ts";
import type { RecipeBook } from "../core/recipes.ts";
import type { TemplateLibrary } from "../core/templates.ts";
import type { Intelligence } from "../intelligence/types.ts";
import type { Logger } from "../log.ts";
import type { SongService } from "../songwriting/service.ts";
import { adaptersRoutes } from "./routes/adapters.ts";
import { commandRoutes } from "./routes/commands.ts";
import { eventRoutes } from "./routes/events.ts";
import { healthRoutes } from "./routes/health.ts";
import { stateRoutes } from "./routes/state.ts";
import { bandRoutes } from "./routes/bands.ts";
import { recipeRoutes } from "./routes/recipes.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { songRoutes } from "./routes/songs.ts";
import { templateRoutes } from "./routes/templates.ts";

export interface AppDeps {
  store: StateStore;
  templates: TemplateLibrary;
  bands: BandLibrary;
  /** Every song operation, shared with the agent loop. */
  songs: SongService;
  /** Every recipe the band generator can staff from; fills gaps through the model. */
  recipes: RecipeBook;
  /**
   * The session library. Optional: without it mate runs exactly as before,
   * minus `/sessions` — which is what the tests that build an app without a
   * journal on disk want.
   */
  sessions?: SessionManager;
  intelligence: Intelligence;
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
      // `PUT` is here for `PUT /songs/:id/placements`, the arrangement grid's
      // placement toggle: without it the preflight is refused and the toggle
      // silently does nothing in a browser.
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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
  app.route("/", songRoutes({ songs: deps.songs, log: deps.log }));
  if (deps.sessions) {
    app.route("/", sessionRoutes({ sessions: deps.sessions, store: deps.store, log: deps.log }));
  }
  app.route(
    "/",
    eventRoutes(
      [
        // The session stream is first, so the first frame on the wire is still
        // `event: snapshot` carrying a StateResponse — what every client has
        // read since there was only one aggregate.
        {
          snapshot: "snapshot",
          state: () => deps.store.snapshot(),
          subscribe: (send) => deps.store.events.subscribe(send),
        },
        {
          snapshot: "bands.snapshot",
          state: async () => ({ bands: await deps.bands.list() }),
          subscribe: (send) => deps.bands.events.subscribe(send),
        },
        {
          snapshot: "templates.snapshot",
          state: async () => ({ templates: await deps.templates.list() }),
          subscribe: (send) => deps.templates.events.subscribe(send),
        },
        {
          snapshot: "recipes.snapshot",
          state: async () => ({ recipes: await deps.recipes.library.list() }),
          subscribe: (send) => deps.recipes.library.events.subscribe(send),
        },
      ],
      deps.log,
    ),
  );

  app.notFound((c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404));

  return app;
}

export function startServer(app: Hono, port: number, log: Logger) {
  const server = Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 });
  log.info(`api listening on http://localhost:${server.port}`);
  return server;
}
