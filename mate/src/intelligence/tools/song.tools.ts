import type Anthropic from "@anthropic-ai/sdk";
import type { Action } from "../brain/types.ts";

type Tool = Anthropic.Beta.BetaTool;

const int = { type: "integer" as const };
const str = { type: "string" as const };
const bool = { type: "boolean" as const };

/**
 * The song plan, as tools. These reach `SongService` — the same implementation the drummer's
 * buttons call — so a request typed in chat and a click do exactly the same thing.
 *
 * `download_asset` is deliberately absent from all three lists: it spends a Splice credit, so it
 * stays behind the app's confirm button and can never be a brain action.
 */
export const SONG_READ_TOOLS: Tool[] = [
  {
    name: "get_slot_candidates",
    description:
      "List what the Splice search found for one slot: uuid, file name, pack, bpm, key, whole bars and the resolver's score, best first, with the current pick marked. Free and immediate — the song you are shown carries only the count, so read this before pick_slot.",
    input_schema: { type: "object", properties: { slot_id: { ...str, description: "A slot id from the song, e.g. \"bass-p:a\"" } }, required: ["slot_id"], additionalProperties: false },
    strict: true,
  },
];

export const SONG_COMPOSE_TOOLS: Tool[] = [
  {
    name: "compose_song",
    description:
      "Write a whole song plan from a description and make it the active one: form, a brief per section, a band, a slot per part per section, then a free Splice search for every slot. This is the only way a song gets made, so reach for it as soon as the drummer describes music they want rather than asking them to press anything. Slow (tens of seconds; they watch the steps go by) and it queues like any other action, so say what you are making and stop. Do not call resolve_song afterwards: the search is already part of this.",
    input_schema: {
      type: "object",
      properties: {
        text: { ...str, description: "What the song should be, in the drummer's own words where you have them" },
        name: { ...str, description: "Optional title; one is made up from the brief otherwise" },
      },
      required: ["text"],
    },
  },
];

export const SONG_ACTION_TOOLS: Tool[] = [
  {
    name: "clear_active_song",
    description:
      "Put the active song away so a new one can be composed. It stays in the library and nothing is taken out of the Live set — it just stops being the one you are both working on. Use it when the drummer wants to start something else; compose_song refuses while a song is active.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "resolve_song",
    description:
      "Search Splice again for every slot in the active song and re-rank the candidates. Free — no credits — but a few seconds per slot. compose_song already did this once, so only reach for it after the plan changed (a part dropped, a section re-cast) or when a slot found nothing.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "pick_slot",
    description:
      "Choose which candidate a slot will download. Free: the credit is spent later, by the drummer's own download button. Read get_slot_candidates first — a uuid that is not in that slot's list is refused.",
    input_schema: {
      type: "object",
      properties: { slot_id: str, sound_uuid: { ...str, description: "uuid of one of that slot's candidates" } },
      required: ["slot_id", "sound_uuid"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "set_placement",
    description:
      "Bring one part in for one occurrence of a section, or rest it. This is how a section gets sparser or busier: rest the bass in the first verse, bring the guitar into the last chorus. occurrence is an index from that section's occurrences in the song, not the section number. Resting a part everywhere in a section drops its slot and its pick.",
    input_schema: {
      type: "object",
      properties: { part_id: str, occurrence: { ...int, description: "Timeline index, from the section's occurrences" }, plays: { ...bool, description: "true brings the part in, false rests it" } },
      required: ["part_id", "occurrence", "plays"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "remove_track",
    description:
      "Drop a part from the song for good: its track, its slots and every placement. The last remaining part cannot go — rest it with set_placement instead. Live has no delete, so anything already built stays in the set for the drummer to cut.",
    input_schema: { type: "object", properties: { part_id: str }, required: ["part_id"], additionalProperties: false },
    strict: true,
  },
  {
    name: "arrange_song",
    description:
      "Build the active song in the Live set from the sounds already on disk: its tracks and the tempo the first time, then each sample into the scene for its section and copies along the arrangement. Adds only, never removes, and a re-run carries on from where the last one stopped. Slots that have not been downloaded yet are simply skipped, so there is nothing to build until the drummer has downloaded.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];

/** Map a mutating song tool call onto a domain Action. None of them carry a song id: they mean the active song. */
export function songToolToAction(name: string, input: Record<string, unknown>): Action | null {
  switch (name) {
    case "compose_song": {
      const text = String(input.text ?? "");
      const title = typeof input.name === "string" ? input.name.trim() : "";
      return title ? { type: "composeSong", text, name: title } : { type: "composeSong", text };
    }
    case "clear_active_song":
      return { type: "clearActiveSong" };
    case "resolve_song":
      return { type: "resolveSong" };
    case "pick_slot":
      return { type: "pickSlot", slotId: String(input.slot_id), soundUuid: String(input.sound_uuid) };
    case "set_placement":
      return { type: "setPlacement", partId: String(input.part_id), occurrence: Number(input.occurrence), plays: input.plays === true };
    case "remove_track":
      return { type: "removeTrack", partId: String(input.part_id) };
    case "arrange_song":
      return { type: "arrangeSong" };
    default:
      return null;
  }
}
