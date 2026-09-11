/**
 * `bun run library:rename-seeded`: take the seed out of the names already saved.
 *
 * Rolled bands and templates used to be named for their seed, and since the
 * default seed is the clock, the library filled up with "hiphop band
 * 1788541344590". `songwriting/library.ts` no longer does that — it names from
 * `core/naming.ts` and records the seed in the record's `seed` field — but the
 * records written before that change still carry the old name.
 *
 * The log is the write, so this is not a file edit: it recovers the seed from
 * the name, renames the record, and **appends a `band.saved`/`template.saved`
 * event** carrying the whole corrected record, exactly as any other save does.
 * The record files are the projection and are rewritten from that.
 *
 * A name only matches when it is *exactly* what the old generator would have
 * produced for that record — `${genre} band ${n}` for the genre the record
 * actually carries, or `Form ${n}` — so a band the drummer called "Big Band
 * 1940" is left alone. Idempotent: nothing matches on a second run.
 *
 * Dry run by default; pass `--apply` to write.
 */
import { join } from "node:path";
import type { Band, BandEvent, Template, TemplateEvent } from "@aibleton/protocol";
import { loadConfig } from "../config.ts";
import { createBandLibrary } from "../core/bands.ts";
import { EventBus } from "../core/events.ts";
import { bandName, templateName } from "../core/naming.ts";
import { createTemplateLibrary } from "../core/templates.ts";
import { createLogger } from "../log.ts";

/** What the old generator wrote, and what replaces it. */
interface Rename<T> {
  before: string;
  after: string;
  seed: number;
  record: T;
}

/**
 * The seed the old name ends in, or `null`. Reconstructing the whole old name
 * and comparing is what keeps a hand-written name safe: the prefix has to be
 * this record's own genre, and the suffix has to be all that is left.
 */
function seedInBandName(band: Band): number | null {
  const genre = band.metadata.genre ?? "mixed";
  const prefix = `${genre} band `;
  if (!band.name.startsWith(prefix)) return null;
  return wholeNumber(band.name.slice(prefix.length));
}

function seedInTemplateName(template: Template): number | null {
  if (!template.name.startsWith("Form ")) return null;
  return wholeNumber(template.name.slice("Form ".length));
}

function wholeNumber(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function report(kind: string, renames: Rename<unknown>[]): void {
  if (renames.length === 0) {
    console.log(`${kind}: nothing to rename`);
    return;
  }
  console.log(`${kind}: ${renames.length} to rename`);
  for (const r of renames) console.log(`  ${r.before}  ->  ${r.after}   (seed ${r.seed})`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const config = loadConfig();
  const log = createLogger("rename-seeded");

  const bandLibrary = await createBandLibrary({
    dir: config.bandsDir,
    path: join(config.libraryDir, "bands.jsonl"),
    events: new EventBus<BandEvent>(),
    now: () => Date.now(),
    log,
  });
  const templateLibrary = await createTemplateLibrary({
    dir: config.templatesDir,
    path: join(config.libraryDir, "templates.jsonl"),
    events: new EventBus<TemplateEvent>(),
    now: () => Date.now(),
    log,
  });

  try {
    const bands: Rename<Band>[] = [];
    for (const band of await bandLibrary.store.list()) {
      const seed = seedInBandName(band);
      if (seed === null) continue;
      const after = bandName(seed);
      bands.push({ before: band.name, after, seed, record: { ...band, name: after, seed: band.seed ?? seed } });
    }

    const templates: Rename<Template>[] = [];
    for (const template of await templateLibrary.store.list()) {
      const seed = seedInTemplateName(template);
      if (seed === null) continue;
      const after = templateName(seed);
      templates.push({
        before: template.name,
        after,
        seed,
        record: { ...template, name: after, seed: template.seed ?? seed },
      });
    }

    report("bands", bands);
    report("templates", templates);

    if (!apply) {
      console.log("\ndry run — pass --apply to write these to the log.");
      return;
    }
    // One append per aggregate: a burst that only makes sense whole.
    if (bands.length > 0) await bandLibrary.store.saveAll(bands.map((r) => r.record));
    if (templates.length > 0) await templateLibrary.store.saveAll(templates.map((r) => r.record));
    console.log(`\nwrote ${bands.length} band event(s) and ${templates.length} template event(s).`);
    console.log("restart mate so its fold picks them up.");
  } finally {
    await Promise.all([bandLibrary.close(), templateLibrary.close()]);
  }
}

await main();
