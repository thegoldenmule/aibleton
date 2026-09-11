import { join } from "node:path";
import type { BandEvent, JournaledBandEvent, JournaledTemplateEvent, TemplateEvent } from "@aibleton/protocol";
import { bandLibraryOptions, createBandLibrary, type BandLibrary } from "../../src/core/bands.ts";
import { EventBus } from "../../src/core/events.ts";
import { LibraryStore, type OpenLibrary } from "../../src/core/library.ts";
import { templateLibraryOptions, createTemplateLibrary, type TemplateLibrary } from "../../src/core/templates.ts";
import { silentLogger, type Logger } from "../../src/log.ts";
import type { Band, Template } from "@aibleton/protocol";

export interface LibraryHarnessOptions {
  /** Shared with other libraries in the same harness when a test wants one bus; a fresh one by default. */
  events?: EventBus<BandEvent>;
  now?: () => number;
  log?: Logger;
  /** Where the log goes. Defaults to `<dir>/../library/bands.jsonl`, i.e. outside the record directory. */
  path?: string;
}

export interface TemplateLibraryHarnessOptions extends Omit<LibraryHarnessOptions, "events"> {
  events?: EventBus<TemplateEvent>;
}

/**
 * A band library over `dir`, built **synchronously** so a synchronous harness
 * (`songServiceHarness`) can hold one. The open runs in the background and
 * every read parks behind it; `lib.opened` is what it found.
 */
export function bandLibrary(dir: string, opts: LibraryHarnessOptions = {}): BandLibrary {
  return new LibraryStore(bandLibraryOptions(bandArgs(dir, opts)));
}

/** The same library, awaited, with the counts the boot reported. */
export function openBandLibrary(dir: string, opts: LibraryHarnessOptions = {}): Promise<OpenLibrary<Band, BandEvent, JournaledBandEvent>> {
  return createBandLibrary(bandArgs(dir, opts));
}

/** The template mirror, synchronous for the same reason. */
export function templateLibrary(dir: string, opts: TemplateLibraryHarnessOptions = {}): TemplateLibrary {
  return new LibraryStore(templateLibraryOptions(templateArgs(dir, opts)));
}

/** The template mirror, awaited. */
export function openTemplateLibrary(
  dir: string,
  opts: TemplateLibraryHarnessOptions = {},
): Promise<OpenLibrary<Template, TemplateEvent, JournaledTemplateEvent>> {
  return createTemplateLibrary(templateArgs(dir, opts));
}

/** Where a library's log lives when a test does not say: beside the record directory, never inside it. */
export function logPathFor(dir: string, name: string): string {
  return join(dir, "..", "library", `${name}.jsonl`);
}

function bandArgs(dir: string, opts: LibraryHarnessOptions) {
  return {
    dir,
    path: opts.path ?? logPathFor(dir, "bands"),
    events: opts.events ?? new EventBus<BandEvent>(),
    now: opts.now ?? (() => 1_000),
    log: opts.log ?? silentLogger,
  };
}

function templateArgs(dir: string, opts: TemplateLibraryHarnessOptions) {
  return {
    dir,
    path: opts.path ?? logPathFor(dir, "templates"),
    events: opts.events ?? new EventBus<TemplateEvent>(),
    now: opts.now ?? (() => 1_000),
    log: opts.log ?? silentLogger,
  };
}
