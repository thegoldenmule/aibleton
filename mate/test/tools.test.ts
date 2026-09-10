import { describe, expect, test } from "bun:test";
import { isReadOnlyTool, toolDefinitions, toolToAction } from "../src/intelligence/tools/index.ts";

const names = (ctx?: Parameters<typeof toolDefinitions>[0]) => toolDefinitions(ctx).map((t) => t.name);
const SONG_EDIT = ["clear_active_song", "resolve_song", "pick_slot", "set_placement", "remove_track", "arrange_song"];

describe("toolDefinitions", () => {
  test("with no song, compose is the only song tool on offer", () => {
    const list = names({ songTools: true, hasSong: false });
    expect(list).toContain("compose_song");
    for (const n of [...SONG_EDIT, "get_slot_candidates"]) expect(list).not.toContain(n);
    // The Live tools are always there: a song is not a precondition for playing along.
    expect(list).toContain("create_midi_track");
    expect(list).toContain("get_session");
  });

  test("with a song, the editing tools are on offer and compose is not", () => {
    const list = names({ songTools: true, hasSong: true });
    expect(list).not.toContain("compose_song");
    for (const n of [...SONG_EDIT, "get_slot_candidates"]) expect(list).toContain(n);
  });

  test("a trigger the drummer did not type gets no song tools at all", () => {
    // Ticks, abletonChanged and MIDI may talk and use the Live tools; the song plan is off limits.
    const list = names({ songTools: false, hasSong: true });
    for (const n of [...SONG_EDIT, "compose_song", "get_slot_candidates"]) expect(list).not.toContain(n);
    expect(list).toContain("set_tempo");
    expect(list).toContain("schedule_follow_up");
  });

  test("downloading is in no list at all: it spends a credit, so it stays behind the drummer's confirm", () => {
    for (const ctx of [{ songTools: true, hasSong: true }, { songTools: true, hasSong: false }, { songTools: false, hasSong: false }]) {
      expect(names(ctx).filter((n) => n.includes("download"))).toEqual([]);
    }
  });

  test("get_slot_candidates runs inline; the mutating song tools queue as actions", () => {
    expect(isReadOnlyTool("get_slot_candidates")).toBe(true);
    for (const n of [...SONG_EDIT, "compose_song"]) expect(isReadOnlyTool(n)).toBe(false);
  });
});

describe("song tool calls become actions", () => {
  test("each tool maps onto its action, and none of them carries a song id", () => {
    expect(toolToAction("compose_song", { text: "dusty funk" })).toEqual({ type: "composeSong", text: "dusty funk" });
    expect(toolToAction("compose_song", { text: "dusty funk", name: " Tuesday " })).toEqual({ type: "composeSong", text: "dusty funk", name: "Tuesday" });
    // A blank name is not a name: the composer makes one up from the brief.
    expect(toolToAction("compose_song", { text: "x", name: "  " })).toEqual({ type: "composeSong", text: "x" });
    expect(toolToAction("clear_active_song", {})).toEqual({ type: "clearActiveSong" });
    expect(toolToAction("resolve_song", {})).toEqual({ type: "resolveSong" });
    expect(toolToAction("pick_slot", { slot_id: "bass-p:a", sound_uuid: "u1" })).toEqual({ type: "pickSlot", slotId: "bass-p:a", soundUuid: "u1" });
    expect(toolToAction("set_placement", { part_id: "bass-p", occurrence: 2, plays: false })).toEqual({ type: "setPlacement", partId: "bass-p", occurrence: 2, plays: false });
    expect(toolToAction("remove_track", { part_id: "guitar-strat" })).toEqual({ type: "removeTrack", partId: "guitar-strat" });
    expect(toolToAction("arrange_song", {})).toEqual({ type: "arrangeSong" });
    expect(toolToAction("no_such_tool", {})).toBeNull();
  });
});
