import { describe, expect, test } from "bun:test";
import {
  BAND_EVENT_TYPES,
  DURABLE_BAND_EVENT_TYPES,
  DURABLE_TEMPLATE_EVENT_TYPES,
  MATE_EVENT_TYPES,
  TEMPLATE_EVENT_TYPES,
  VOLATILE_BAND_EVENT_TYPES,
  VOLATILE_TEMPLATE_EVENT_TYPES,
  applyBandEvent,
  applyTemplateEvent,
  fromJournaledBand,
  fromJournaledTemplate,
  toJournaledBand,
  toJournaledTemplate,
  type Band,
  type BandEvent,
  type Template,
  type TemplateEvent,
} from "@aibleton/protocol";
import { fixtureBand, fixtureTemplate } from "./helpers/song.ts";

/** A deep-equal copy that is not the same object: what arrives by the other route. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const bandIds = (bands: readonly Band[]): string[] => bands.map((band) => band.id);
const templateIds = (templates: readonly Template[]): string[] => templates.map((template) => template.id);

/**
 * Nothing routes these by prefix or by envelope — the SSE `event:` field is the
 * only tag, and the app registers one listener per name. Two aggregates sharing
 * a name would silently feed one fold the other's payload, so the clash has to
 * fail here rather than in a browser.
 */
test("no two aggregates claim the same event name", () => {
  const all = [...MATE_EVENT_TYPES, ...BAND_EVENT_TYPES, ...TEMPLATE_EVENT_TYPES];
  expect(new Set(all).size).toBe(all.length);
});

describe("band events", () => {
  test("every BandEvent type is classified exactly once", () => {
    const all = [...DURABLE_BAND_EVENT_TYPES, ...VOLATILE_BAND_EVENT_TYPES];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...BAND_EVENT_TYPES].sort());
  });

  test("every event survives the round trip to disk and back", () => {
    const events: BandEvent[] = [
      { type: "band.saved", band: fixtureBand() },
      { type: "band.deleted", id: "band-1" },
    ];
    expect(events.map((event) => event.type).sort()).toEqual([...BAND_EVENT_TYPES].sort());
    for (const event of events) {
      expect(fromJournaledBand(toJournaledBand(event))).toEqual(event);
    }
  });

  test("a save of a known id replaces it rather than adding a second", () => {
    const first = fixtureBand({ id: "band-1", name: "The Pocket" });
    const renamed = fixtureBand({ id: "band-1", name: "The Deeper Pocket" });
    const after = applyBandEvent(applyBandEvent([], { type: "band.saved", band: first }), {
      type: "band.saved",
      band: renamed,
    });
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("The Deeper Pocket");
  });

  test("an out-of-order save still lands newest first", () => {
    const older = fixtureBand({ id: "band-old", createdAt: 10 });
    const newer = fixtureBand({ id: "band-new", createdAt: 30 });
    const middle = fixtureBand({ id: "band-mid", createdAt: 20 });
    let bands: readonly Band[] = [];
    for (const band of [newer, older, middle]) bands = applyBandEvent(bands, { type: "band.saved", band });
    expect(bandIds(bands)).toEqual(["band-new", "band-mid", "band-old"]);
  });

  test("two bands minted in the same millisecond keep a stable order", () => {
    const b = fixtureBand({ id: "band-b", createdAt: 7 });
    const a = fixtureBand({ id: "band-a", createdAt: 7 });
    const forwards = [b, a].reduce<readonly Band[]>((acc, band) => applyBandEvent(acc, { type: "band.saved", band }), []);
    const backwards = [a, b].reduce<readonly Band[]>((acc, band) => applyBandEvent(acc, { type: "band.saved", band }), []);
    expect(bandIds(forwards)).toEqual(["band-a", "band-b"]);
    expect(bandIds(backwards)).toEqual(["band-a", "band-b"]);
  });

  test("a delete removes the band", () => {
    const bands = applyBandEvent([], { type: "band.saved", band: fixtureBand({ id: "band-1" }) });
    expect(applyBandEvent(bands, { type: "band.deleted", id: "band-1" })).toEqual([]);
  });

  test("deleting an id the library never held changes nothing", () => {
    const bands = applyBandEvent([], { type: "band.saved", band: fixtureBand({ id: "band-1" }) });
    expect(applyBandEvent(bands, { type: "band.deleted", id: "band-gone" })).toBe(bands);
  });

  test("re-saving an equal band keeps the same reference", () => {
    const band = fixtureBand({ id: "band-1" });
    const bands = applyBandEvent([], { type: "band.saved", band });
    expect(applyBandEvent(bands, { type: "band.saved", band: copy(band) })).toBe(bands);
  });

  test("applying the same saved event twice is a no-op", () => {
    const event: BandEvent = { type: "band.saved", band: fixtureBand({ id: "band-1" }) };
    const once = applyBandEvent([], event);
    expect(applyBandEvent(once, event)).toBe(once);
  });
});

describe("template events", () => {
  test("every TemplateEvent type is classified exactly once", () => {
    const all = [...DURABLE_TEMPLATE_EVENT_TYPES, ...VOLATILE_TEMPLATE_EVENT_TYPES];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...TEMPLATE_EVENT_TYPES].sort());
  });

  test("every event survives the round trip to disk and back", () => {
    const events: TemplateEvent[] = [
      { type: "template.saved", template: fixtureTemplate() },
      { type: "template.deleted", id: "tpl-1" },
    ];
    expect(events.map((event) => event.type).sort()).toEqual([...TEMPLATE_EVENT_TYPES].sort());
    for (const event of events) {
      expect(fromJournaledTemplate(toJournaledTemplate(event))).toEqual(event);
    }
  });

  test("a save of a known id replaces it rather than adding a second", () => {
    const first = fixtureTemplate({ id: "tpl-1", name: "Tuesday jam" });
    const renamed = fixtureTemplate({ id: "tpl-1", name: "Wednesday jam" });
    const after = applyTemplateEvent(applyTemplateEvent([], { type: "template.saved", template: first }), {
      type: "template.saved",
      template: renamed,
    });
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("Wednesday jam");
  });

  test("an out-of-order save still lands newest first", () => {
    const older = fixtureTemplate({ id: "tpl-old", createdAt: 10 });
    const newer = fixtureTemplate({ id: "tpl-new", createdAt: 30 });
    const middle = fixtureTemplate({ id: "tpl-mid", createdAt: 20 });
    let templates: readonly Template[] = [];
    for (const template of [newer, older, middle]) {
      templates = applyTemplateEvent(templates, { type: "template.saved", template });
    }
    expect(templateIds(templates)).toEqual(["tpl-new", "tpl-mid", "tpl-old"]);
  });

  test("two templates minted in the same millisecond keep a stable order", () => {
    const b = fixtureTemplate({ id: "tpl-b", createdAt: 7 });
    const a = fixtureTemplate({ id: "tpl-a", createdAt: 7 });
    const fold = (order: Template[]): readonly Template[] =>
      order.reduce<readonly Template[]>((acc, template) => applyTemplateEvent(acc, { type: "template.saved", template }), []);
    expect(templateIds(fold([b, a]))).toEqual(["tpl-a", "tpl-b"]);
    expect(templateIds(fold([a, b]))).toEqual(["tpl-a", "tpl-b"]);
  });

  test("a delete removes the template", () => {
    const templates = applyTemplateEvent([], { type: "template.saved", template: fixtureTemplate({ id: "tpl-1" }) });
    expect(applyTemplateEvent(templates, { type: "template.deleted", id: "tpl-1" })).toEqual([]);
  });

  test("deleting an id the library never held changes nothing", () => {
    const templates = applyTemplateEvent([], { type: "template.saved", template: fixtureTemplate({ id: "tpl-1" }) });
    expect(applyTemplateEvent(templates, { type: "template.deleted", id: "tpl-gone" })).toBe(templates);
  });

  test("re-saving an equal template keeps the same reference", () => {
    const template = fixtureTemplate({ id: "tpl-1" });
    const templates = applyTemplateEvent([], { type: "template.saved", template });
    expect(applyTemplateEvent(templates, { type: "template.saved", template: copy(template) })).toBe(templates);
  });

  test("applying the same saved event twice is a no-op", () => {
    const event: TemplateEvent = { type: "template.saved", template: fixtureTemplate({ id: "tpl-1" }) };
    const once = applyTemplateEvent([], event);
    expect(applyTemplateEvent(once, event)).toBe(once);
  });
});
