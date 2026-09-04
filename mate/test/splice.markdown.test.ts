import { describe, expect, test } from "bun:test";
import { parseDownload, parseKey, parseSearchResults, parseStack } from "../src/ports/splice/markdown.ts";

const fixture = (name: string) => Bun.file(new URL(`../src/ports/splice/fixtures/${name}`, import.meta.url)).text();
const searchMd = await fixture("search_response.md");
const keysMd = await fixture("search_response_keys.md");
const stackMd = await fixture("stack_response.md");

describe("parseKey", () => {
  test("reads Splice's spellings", () => {
    expect(parseKey("f# minor")).toEqual({ root: "F#", mode: "minor" });
    expect(parseKey("a# major")).toEqual({ root: "A#", mode: "major" });
    expect(parseKey("a")).toEqual({ root: "A", mode: null });
    expect(parseKey("C")).toEqual({ root: "C", mode: null });
    expect(parseKey("Bb min")).toEqual({ root: "A#", mode: "minor" });
    expect(parseKey("Ebmaj")).toEqual({ root: "D#", mode: "major" });
  });

  test("rejects junk", () => {
    expect(parseKey(undefined)).toBeNull();
    expect(parseKey("")).toBeNull();
    expect(parseKey("h minor")).toBeNull();
    expect(parseKey("120")).toBeNull();
  });
});

describe("parseSearchResults", () => {
  test("parses the captured Splice response into 10 sounds", () => {
    const sounds = parseSearchResults(searchMd);
    expect(sounds).toHaveLength(10);
    expect(sounds[0]).toEqual({
      uuid: "368ee8d9-036b-4f66-8d7b-433f517d9ca9",
      fileName: "TS_ORGANIC_VOL1_124_drum_loop_grooves_motown_crash_fill_1.wav",
      bpm: 124,
      key: null,
      durationSec: 7.7,
      type: "loop",
      pack: "That Sound",
      tags: ["drums", "live sounds", "acoustic", "rock", "fills", "pop"],
      url: "https://splice.com/sounds/sample/a11a964e3927194516c2333911e66deecbe556a317308f0573a86c754d45e427/ts-organic-vol1-124-drum-loop-grooves-motown-crash-fill-1-wav",
    });
    expect(sounds[4]?.uuid).toBe("83eba392-3fd5-4228-bbcc-f79ae33a222d");
    expect(sounds[4]?.bpm).toBe(101);
    expect(sounds[4]?.pack).toBe("Drumdrops");
    expect(sounds[9]?.tags).toContain("breaks");
    expect(new Set(sounds.map((s) => s.uuid)).size).toBe(10);
  });

  test("reads the Key field on pitched sounds", () => {
    const sounds = parseSearchResults(keysMd);
    expect(sounds).toHaveLength(10);
    expect(sounds[0]).toMatchObject({ fileName: "CO_IF_110_bass_guitar_linden_Cmin.wav", bpm: 110, key: { root: "C", mode: "minor" }, durationSec: 17.5 });
    expect(sounds[1]?.key).toEqual({ root: "A", mode: null });
    expect(sounds[2]?.key).toEqual({ root: "C", mode: "major" });
    expect(sounds[3]?.key).toEqual({ root: "G#", mode: "minor" });
  });

  test("tolerates missing fields and one-shots", () => {
    const partial = `### 1. KICK_01.wav\nType: oneshot\n**Asset UUID:** 11111111-2222-3333-4444-555555555555\n\n### 2. no uuid here\nBPM: 90`;
    const sounds = parseSearchResults(partial);
    expect(sounds).toHaveLength(1);
    expect(sounds[0]).toMatchObject({ fileName: "KICK_01.wav", type: "oneshot", bpm: null, key: null, durationSec: null, pack: "", tags: [] });
  });

  test("returns empty for unrelated text", () => {
    expect(parseSearchResults("No results found.")).toEqual([]);
  });
});

describe("parseStack", () => {
  test("parses the captured prompt_to_stack response", () => {
    const stack = parseStack(stackMd, { name: "fallback", bpm: 100 });
    expect(stack.uuid).toBe("c03f989b-bbd5-494a-8b09-7c528224704e");
    expect(stack.name).toBe("indie rock verse at 120 bpm in F minor: live acoustic drums groove, electric bass, clean electric guitar, organ");
    expect(stack.bpm).toBe(120);
    expect(stack.key).toEqual({ root: "F", mode: "minor" });
    expect(stack.shareUrl).toBe("https://splice.com/sounds/stacks/c03f989b-bbd5-494a-8b09-7c528224704e");
    expect(stack.layers.map((l) => l.layerType)).toEqual(["drums", "bass", "guitar", "keys"]);
    expect(stack.layers[0]).toMatchObject({
      uuid: "e16b7c7b-e723-4e10-9d2a-36c3cd8c2fcb",
      sound: { uuid: "43eb3f58-652d-4092-932e-23b1291abfd2", fileName: "TS_COLOSSUS_130_arcturus_fuller.wav", bpm: 130, key: null, durationSec: 7.4, pack: "That Sound" },
    });
    // Layers keep their catalog bpm and key; only the stack header is at 120 / F minor.
    expect(stack.layers[1]?.sound).toMatchObject({ uuid: "02002768-dfcd-4fc7-a744-9cc8f1f0b65f", bpm: 118, key: { root: "F#", mode: "minor" } });
    expect(stack.layers[3]?.sound.tags).toContain("organ");
    expect(stack.raw).toBe(stackMd);
  });

  test("still reads numbered layer blocks", () => {
    const text = [
      "**Stack UUID:** aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "**Name:** Motown practice",
      "**BPM:** 124",
      "",
      "### 1. TS_ORGANIC_VOL1_124_drum_loop_grooves_motown_3.wav",
      "**Layer Type:** drums",
      "**Layer UUID:** 12121212-3434-5656-7878-909090909090",
      "**Asset UUID:** 90ad05fe-9e22-4256-ad0c-71eb60d6c103",
      "",
      "### 2. BASS_LOOP.wav",
      "**Layer UUID:** 21212121-4343-6565-8787-090909090909",
      "**Asset UUID:** 6bd4c962-33dc-49cd-92b8-a6257e77c44e",
      "",
      "### 3. NO_ASSET.wav",
      "**Layer UUID:** 31313131-4343-6565-8787-090909090909",
    ].join("\n");
    const stack = parseStack(text, { name: "fallback", bpm: 100 });
    expect(stack).toMatchObject({ uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "Motown practice", bpm: 124, key: null });
    expect(stack.layers).toHaveLength(2);
    expect(stack.layers[0]).toMatchObject({ uuid: "12121212-3434-5656-7878-909090909090", layerType: "drums" });
    expect(stack.layers[0]?.sound.uuid).toBe("90ad05fe-9e22-4256-ad0c-71eb60d6c103");
    expect(stack.layers[1]?.sound).toMatchObject({ uuid: "6bd4c962-33dc-49cd-92b8-a6257e77c44e", fileName: "BASS_LOOP.wav" });
    // A layer with only a layer UUID has nothing downloadable, so it is dropped rather than
    // mislabelled with the layer id as its asset id.
  });

  test("falls back gracefully on unstructured text", () => {
    const stack = parseStack("Created your stack, enjoy!", { name: "lo-fi", bpm: 85 });
    expect(stack).toMatchObject({ name: "lo-fi", bpm: 85, key: null, layers: [] });
    expect(stack.uuid.startsWith("unknown-")).toBe(true);
  });
});

describe("parseDownload", () => {
  test("pulls url and file name", () => {
    const r = parseDownload("**File:** SC_RS_110_drum_loop_slim_boy.wav\nURL: https://cdn.splice.com/x?sig=1", "b56b");
    expect(r).toEqual({ uuid: "b56b", fileName: "SC_RS_110_drum_loop_slim_boy.wav", url: "https://cdn.splice.com/x?sig=1" });
  });
});
