import { describe, expect, test } from "bun:test";
import { parseDownload, parseSearchResults, parseStack } from "../src/ports/splice/markdown.ts";

const md = await Bun.file(new URL("../src/ports/splice/fixtures/search_response.md", import.meta.url)).text();

describe("parseSearchResults", () => {
  test("parses the captured Splice response into 10 sounds", () => {
    const sounds = parseSearchResults(md);
    expect(sounds).toHaveLength(10);
    expect(sounds[0]).toEqual({
      uuid: "368ee8d9-036b-4f66-8d7b-433f517d9ca9",
      fileName: "TS_ORGANIC_VOL1_124_drum_loop_grooves_motown_crash_fill_1.wav",
      bpm: 124,
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

  test("tolerates missing fields and one-shots", () => {
    const partial = `### 1. KICK_01.wav\nType: oneshot\n**Asset UUID:** 11111111-2222-3333-4444-555555555555\n\n### 2. no uuid here\nBPM: 90`;
    const sounds = parseSearchResults(partial);
    expect(sounds).toHaveLength(1);
    expect(sounds[0]).toMatchObject({ fileName: "KICK_01.wav", type: "oneshot", bpm: null, durationSec: null, pack: "", tags: [] });
  });

  test("returns empty for unrelated text", () => {
    expect(parseSearchResults("No results found.")).toEqual([]);
  });
});

describe("parseStack", () => {
  test("extracts stack uuid, bpm and layers from the assumed format", () => {
    const text = [
      "## Stack created",
      "**Stack UUID:** aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "**Name:** Motown practice",
      "**BPM:** 124",
      "**Share URL:** https://splice.com/stacks/abc123",
      "",
      "### 1. TS_ORGANIC_VOL1_124_drum_loop_grooves_motown_3.wav",
      "BPM: 124 | Duration: 7.7s | Type: loop",
      "**Layer Type:** drums",
      "**Layer UUID:** 12121212-3434-5656-7878-909090909090",
      "**Asset UUID:** 90ad05fe-9e22-4256-ad0c-71eb60d6c103",
      "",
      "### 2. BASS_LOOP.wav",
      "**Layer UUID:** 21212121-4343-6565-8787-090909090909",
    ].join("\n");
    const stack = parseStack(text, { name: "fallback", bpm: 100 });
    expect(stack.uuid).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(stack.name).toBe("Motown practice");
    expect(stack.bpm).toBe(124);
    expect(stack.shareUrl).toBe("https://splice.com/stacks/abc123");
    expect(stack.layers).toHaveLength(2);
    expect(stack.layers[0]).toMatchObject({ uuid: "12121212-3434-5656-7878-909090909090", layerType: "drums" });
    expect(stack.layers[0]?.sound.uuid).toBe("90ad05fe-9e22-4256-ad0c-71eb60d6c103");
    expect(stack.layers[1]?.sound.fileName).toBe("BASS_LOOP.wav");
    expect(stack.raw).toBe(text);
  });

  test("falls back gracefully on unstructured text", () => {
    const stack = parseStack("Created your stack, enjoy!", { name: "lo-fi", bpm: 85 });
    expect(stack.name).toBe("lo-fi");
    expect(stack.bpm).toBe(85);
    expect(stack.layers).toEqual([]);
    expect(stack.uuid.startsWith("unknown-")).toBe(true);
  });
});

describe("parseDownload", () => {
  test("pulls url and file name", () => {
    const r = parseDownload("**File:** SC_RS_110_drum_loop_slim_boy.wav\nURL: https://cdn.splice.com/x?sig=1", "b56b");
    expect(r).toEqual({ uuid: "b56b", fileName: "SC_RS_110_drum_loop_slim_boy.wav", url: "https://cdn.splice.com/x?sig=1" });
  });
});
