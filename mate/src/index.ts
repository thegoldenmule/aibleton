import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { toJournaled, type BandEvent, type MateEvent, type RecipeEvent, type TemplateEvent } from "@aibleton/protocol";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { SystemClock } from "./core/clock.ts";
import { EventBus } from "./core/events.ts";
import { Mailbox } from "./core/mailbox.ts";
import { StateStore } from "./core/state.ts";
import { createBandLibrary } from "./core/bands.ts";
import { RecipeBook, createRecipeLibrary } from "./core/recipes.ts";
import { SongStore } from "./core/songs.ts";
import { createTemplateLibrary } from "./core/templates.ts";
import { SessionManager, SessionStore } from "./core/sessions.ts";
import { attachJournal } from "./core/journal.ts";
import { restoreStore } from "./core/restore.ts";
import { createAbletonPort } from "./ports/ableton/index.ts";
import { createSplicePort } from "./ports/splice/index.ts";
import { createAnthropicClient } from "./core/anthropic.ts";
import { createBrain } from "./intelligence/brain/index.ts";
import { createIntelligence } from "./intelligence/index.ts";
import { createBriefer } from "./songwriting/briefer/index.ts";
import { SongService } from "./songwriting/service.ts";
import { createRecipeWriter } from "./songwriting/recipe-writer/index.ts";
import { TickSource } from "./inputs/timer.ts";
import { NoopMidiSource } from "./inputs/midi.ts";
import { createApp, startServer } from "./api/server.ts";

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = loadConfig();
  const log = createLogger("mate");

  const clock = new SystemClock();
  const events = new EventBus<MateEvent>();
  const store = new StateStore(events);
  const mailbox = new Mailbox();
  const songs = new SongStore({ dir: config.songsDir });

  // The libraries open before the session, because they are a different
  // aggregate with a different log and nothing about them depends on which
  // session is current. The reconcile has to finish here too: once a route or
  // the loop can write, the fold has to already be the whole library. Nothing
  // between this and the session open may emit a `MateEvent` — the session
  // journal is attached after its replay, so anything emitted in between would
  // be lost.
  const libraryLog = createLogger("library");
  const bandLibrary = await createBandLibrary({
    dir: config.bandsDir,
    path: join(config.libraryDir, "bands.jsonl"),
    events: new EventBus<BandEvent>(),
    now: () => clock.now(),
    log: libraryLog,
  });
  const bands = bandLibrary.store;
  const templateLibrary = await createTemplateLibrary({
    dir: config.templatesDir,
    path: join(config.libraryDir, "templates.jsonl"),
    events: new EventBus<TemplateEvent>(),
    now: () => clock.now(),
    log: libraryLog,
  });
  const templates = templateLibrary.store;
  const recipeLibrary = await createRecipeLibrary({
    dir: config.recipesDir,
    path: join(config.libraryDir, "recipes.jsonl"),
    events: new EventBus<RecipeEvent>(),
    now: () => clock.now(),
    log: libraryLog,
  });

  // The session mate left behind, folded back in before anything else runs. It
  // has to happen here, before the loop starts: `AgentLoop.start()` reads the
  // active song once, so a restored song flows through that existing path
  // rather than depending on subscription timing, nothing from the loop can
  // interleave with the replay, and the HTTP server comes up on the restored
  // state — no window where the app renders an empty session and then jumps.
  const sessionLog = createLogger("session");
  const sessions = new SessionStore({ dir: config.sessionsDir, now: () => clock.now(), log: sessionLog });
  const session = await sessions.openCurrent();
  const restored = await restoreStore({ store, entries: session.entries, songs, log: sessionLog });
  // Attached *after* the replay: that ordering is the whole re-journaling
  // guard. It listens to the bus, not the store — `action.applied` and
  // `cancelled` are emitted straight onto the bus and never pass a setter.
  const detachJournal = attachJournal(events, session.journal, toJournaled, () => clock.now());
  if (restored.events > 0) {
    sessionLog.info(`resumed session ${session.meta.id} (${session.meta.name}): ${restored.events} event(s)${restored.song ? `, song "${restored.song.name}"` : ""}`);
  }
  libraryLog.info(
    `bands: ${bandLibrary.replayed} event(s) replayed, ${bandLibrary.adopted} adopted, ${bandLibrary.repaired} record file(s) repaired`,
  );
  libraryLog.info(
    `templates: ${templateLibrary.replayed} event(s) replayed, ${templateLibrary.adopted} adopted, ${templateLibrary.repaired} record file(s) repaired`,
  );
  libraryLog.info(
    `recipes: ${recipeLibrary.replayed} event(s) replayed, ${recipeLibrary.adopted} adopted, ${recipeLibrary.repaired} record file(s) repaired`,
  );

  const abletonResult = await createAbletonPort(config.ableton, {
    command: config.abletonMcpCommand,
    args: config.abletonMcpArgs,
    log: createLogger("ableton"),
  });
  if (abletonResult.fallbackReason) log.warn(`ableton: using stub (${abletonResult.fallbackReason})`);

  const spliceResult = await createSplicePort(config.splice, {
    url: config.spliceMcpUrl,
    token: config.spliceMcpToken,
    oauth: { file: config.spliceOauthFile, callbackPort: config.spliceOauthCallbackPort },
    log: createLogger("splice"),
  });
  if (spliceResult.fallbackReason) log.warn(`splice: using stub (${spliceResult.fallbackReason})`);

  let anthropic: Anthropic | null = null;
  let anthropicError: string | undefined;
  if (config.brain !== "scripted") {
    try {
      anthropic = createAnthropicClient();
    } catch (err) {
      anthropicError = err instanceof Error ? err.message : String(err);
    }
  }

  const brieferResult = createBriefer(config.brain, {
    client: anthropic,
    ...(anthropicError !== undefined ? { clientError: anthropicError } : {}),
    model: config.model,
    log: createLogger("briefer"),
  });
  if (brieferResult.fallbackReason) log.warn(`briefer: using scripted (${brieferResult.fallbackReason})`);

  const writerResult = createRecipeWriter(config.brain, {
    client: anthropic,
    ...(anthropicError !== undefined ? { clientError: anthropicError } : {}),
    model: config.model,
    log: createLogger("recipes"),
  });
  if (writerResult.fallbackReason) log.warn(`recipe writer: using scripted (${writerResult.fallbackReason})`);
  // The library was opened with the others; the book is the read-through in
  // front of it, and it needs the writer, which needs the Anthropic client.
  const recipes = new RecipeBook({ library: recipeLibrary.store, writer: writerResult.writer, now: () => clock.now() });

  const brainResult = await createBrain(config.brain, {
    client: anthropic,
    ...(anthropicError !== undefined ? { clientError: anthropicError } : {}),
    model: config.model,
    log: createLogger("brain"),
    ableton: abletonResult.port,
    splice: spliceResult.port,
    // The store, not the service: the brain is built first, and this is read per call anyway.
    getSong: () => store.getSong(),
    // All three libraries exist by now, which is why the brain is built here and not above the
    // recipe book. They go in directly rather than behind a getter: it only ever reads them.
    library: { bands, templates, recipes },
  });
  if (brainResult.fallbackReason) log.warn(`brain: using scripted (${brainResult.fallbackReason})`);

  store.setAdapters({
    ableton: abletonResult.port.kind,
    splice: spliceResult.port.kind,
    brain: brainResult.brain.kind,
  });

  // One implementation of every song operation, shared by the REST routes and the loop.
  const songService = new SongService({
    songs,
    templates,
    bands,
    briefer: brieferResult.briefer,
    recipes,
    store,
    splice: spliceResult.port,
    ableton: abletonResult.port,
    downloadsDir: config.downloadsDir,
    log: createLogger("songs"),
    now: () => clock.now(),
  });

  const intelligence = createIntelligence({
    clock,
    mailbox,
    store,
    brain: brainResult.brain,
    ableton: abletonResult.port,
    splice: spliceResult.port,
    // The same instance the routes use, so a typed request and a click do the same thing.
    songs: songService,
    // The same three the brain reads, on the writing side: a generate action staffs the band and
    // saves it here, so it lands in an open /bands tab off the SSE stream with no refresh.
    library: { bands, templates, recipes },
    log: createLogger("loop"),
    options: { tickMs: config.tickMs, maxBrainRetries: config.maxBrainRetries },
  });
  intelligence.start();

  // The one place the current session changes, from here on: it owns the open
  // session and the journal's detach, so a switch and a shutdown flush and
  // record the same way. It is built after the loop because a switch reseeds it.
  const sessionManager = new SessionManager({
    sessions,
    store,
    events,
    songs,
    intelligence,
    session,
    detach: detachJournal,
    now: () => clock.now(),
    log: sessionLog,
  });

  const ticks = new TickSource(intelligence, clock);
  ticks.start();
  const midi = new NoopMidiSource(intelligence);
  await midi.start();

  const app = createApp({
    store,
    templates,
    bands,
    songs: songService,
    recipes,
    sessions: sessionManager,
    intelligence,
    config,
    log: createLogger("api"),
    startedAt,
    mailboxSize: () => mailbox.size(),
    now: () => clock.now(),
  });
  const server = startServer(app, config.port, log);

  log.info(
    `mate up | ableton=${abletonResult.port.kind} splice=${spliceResult.port.kind} brain=${brainResult.brain.kind} model=${config.model} tick=${config.tickMs}ms cors=${config.corsOrigin}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    ticks.stop();
    await midi.stop();
    try {
      await intelligence.stop();
    } catch (err) {
      log.warn("error stopping intelligence", err);
    }
    await Promise.allSettled([abletonResult.port.close(), spliceResult.port.close()]);
    // Nothing more may reach the journal, then the tail reaches disk, then the
    // metadata records where it got to so the next boot continues past it. The
    // manager, not `session`, because a switch may have moved on since boot.
    try {
      await sessionManager.close();
    } catch (err) {
      sessionLog.warn("could not close the session", err);
    }
    // After the session, because a library append is awaited to disk by the
    // caller that made it: there is only ever the journal's own tail to flush.
    try {
      await Promise.all([bandLibrary.close(), templateLibrary.close(), recipeLibrary.close()]);
    } catch (err) {
      libraryLog.warn("could not close a library", err);
    }
    server.stop(true);
    log.info("bye");
    process.exit(0);
  };
  // Every exit that can be handled flushes the journal, because the documented
  // dev command runs `--watch` and a reload does not always send SIGTERM:
  //
  // - SIGINT / SIGTERM / SIGHUP — the full shutdown; SIGHUP is here because a
  //   closed terminal or a reload that hangs up sends it and nothing else.
  // - `beforeExit` — the loop drained on its own. Rare for a server, but it is
  //   the one exit where async work still runs, so it gets the full shutdown.
  // - `exit` — the process is already leaving and no promise will resolve
  //   again, so only the blocking tail write is possible. It is a no-op after
  //   any of the above, which have already emptied the buffer.
  //
  // What cannot be covered, honestly: SIGKILL, a hard `process.abort`, and a
  // power cut. There is no handler for those, and there is no fsync per event
  // to fall back on — that trade-off is deliberate and documented on
  // `SessionJournal`. Under SIGKILL the buffered tail is lost; `readJournal`
  // reports a torn last line and `open` never reuses its sequence number.
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("beforeExit", () => void shutdown("beforeExit"));
  process.on("exit", () => {
    try {
      sessionManager.flushSync();
    } catch (err) {
      sessionLog.warn("could not flush the journal on exit", err);
    }
    try {
      bandLibrary.flushSync();
      templateLibrary.flushSync();
      recipeLibrary.flushSync();
    } catch (err) {
      libraryLog.warn("could not flush a library log on exit", err);
    }
  });
}

main().catch((err) => {
  console.error("mate failed to start", err);
  process.exit(1);
});
