import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { SystemClock } from "./core/clock.ts";
import { EventBus } from "./core/events.ts";
import { Mailbox } from "./core/mailbox.ts";
import { StateStore } from "./core/state.ts";
import { BandStore } from "./core/bands.ts";
import { TemplateStore } from "./core/templates.ts";
import { createAbletonPort } from "./ports/ableton/index.ts";
import { createSplicePort } from "./ports/splice/index.ts";
import { createBrain } from "./intelligence/brain/index.ts";
import { createIntelligence } from "./intelligence/index.ts";
import { TickSource } from "./inputs/timer.ts";
import { NoopMidiSource } from "./inputs/midi.ts";
import { createApp, startServer } from "./api/server.ts";

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = loadConfig();
  const log = createLogger("mate");

  const clock = new SystemClock();
  const events = new EventBus();
  const store = new StateStore(events);
  const mailbox = new Mailbox();
  const templates = new TemplateStore({ dir: config.templatesDir });
  const bands = new BandStore({ dir: config.bandsDir });

  const abletonResult = await createAbletonPort(config.ableton, {
    command: config.abletonMcpCommand,
    args: config.abletonMcpArgs,
    log: createLogger("ableton"),
  });
  if (abletonResult.fallbackReason) log.warn(`ableton: using stub (${abletonResult.fallbackReason})`);

  const spliceResult = await createSplicePort(config.splice, {
    url: config.spliceMcpUrl,
    token: config.spliceMcpToken,
    log: createLogger("splice"),
  });
  if (spliceResult.fallbackReason) log.warn(`splice: using stub (${spliceResult.fallbackReason})`);

  const brainResult = await createBrain(config.brain, {
    model: config.model,
    log: createLogger("brain"),
    ableton: abletonResult.port,
    splice: spliceResult.port,
  });
  if (brainResult.fallbackReason) log.warn(`brain: using scripted (${brainResult.fallbackReason})`);

  store.setAdapters({
    ableton: abletonResult.port.kind,
    splice: spliceResult.port.kind,
    brain: brainResult.brain.kind,
  });

  const intelligence = createIntelligence({
    clock,
    mailbox,
    store,
    brain: brainResult.brain,
    ableton: abletonResult.port,
    splice: spliceResult.port,
    log: createLogger("loop"),
    options: { tickMs: config.tickMs, maxBrainRetries: config.maxBrainRetries },
  });
  intelligence.start();

  const ticks = new TickSource(intelligence, clock);
  ticks.start();
  const midi = new NoopMidiSource(intelligence);
  await midi.start();

  const app = createApp({
    store,
    templates,
    bands,
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
    server.stop(true);
    log.info("bye");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("mate failed to start", err);
  process.exit(1);
});
