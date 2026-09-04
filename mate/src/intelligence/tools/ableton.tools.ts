import type Anthropic from "@anthropic-ai/sdk";
import type { Action } from "../brain/types.ts";

type Tool = Anthropic.Beta.BetaTool;

const int = { type: "integer" as const };
const num = { type: "number" as const };
const str = { type: "string" as const };

export const ABLETON_READ_TOOLS: Tool[] = [
  {
    name: "get_session",
    description:
      "Return the current Ableton session: transport (tempo, time signature, playing) and every track with its clip slots. Tracks with mine: true are yours to change; the rest belong to the drummer.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];

export const ABLETON_ACTION_TOOLS: Tool[] = [
  {
    name: "create_midi_track",
    description: "Create a new MIDI track of your own at the end of the track list. Optionally name it; the name gets a \"[mate]\" suffix.",
    input_schema: { type: "object", properties: { name: { ...str, description: "Optional track name" } } },
  },
  {
    name: "create_clip",
    description: "Create an empty MIDI clip in a track's session clip slot. length_beats is the loop length in beats (4 = one bar of 4/4).",
    input_schema: {
      type: "object",
      properties: { track: int, slot: int, length_beats: num },
      required: ["track", "slot", "length_beats"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "add_notes",
    description:
      "Add MIDI notes to an existing clip. Drum rack pitches: 36 kick, 38 snare, 42 closed hat, 46 open hat, 49 crash, 51 ride. start_time and duration are in beats.",
    input_schema: {
      type: "object",
      properties: {
        track: int,
        slot: int,
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: { pitch: int, start_time: num, duration: num, velocity: int },
            required: ["pitch", "start_time", "duration", "velocity"],
            additionalProperties: false,
          },
        },
      },
      required: ["track", "slot", "notes"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "set_tempo",
    description: "Set the session tempo in BPM.",
    input_schema: { type: "object", properties: { bpm: num }, required: ["bpm"], additionalProperties: false },
    strict: true,
  },
  {
    name: "fire_clip",
    description: "Launch the clip in a track's session slot.",
    input_schema: { type: "object", properties: { track: int, slot: int }, required: ["track", "slot"], additionalProperties: false },
    strict: true,
  },
  {
    name: "start_playback",
    description: "Start the Ableton transport.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "stop_playback",
    description: "Stop the Ableton transport.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "load_drum_kit",
    description: "Load a Drum Rack and a kit into a MIDI track. rack_uri e.g. 'Drums/Drum Rack'; kit_path is a browser path e.g. 'drums/acoustic/kit1'.",
    input_schema: {
      type: "object",
      properties: { track: int, rack_uri: str, kit_path: str },
      required: ["track", "rack_uri", "kit_path"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export function abletonToolToAction(name: string, input: Record<string, unknown>): Action | null {
  const n = (k: string) => Number(input[k]);
  switch (name) {
    case "create_midi_track":
      return typeof input.name === "string" && input.name ? { type: "createMidiTrack", name: input.name } : { type: "createMidiTrack" };
    case "create_clip":
      return { type: "createClip", track: n("track"), slot: n("slot"), lengthBeats: n("length_beats") };
    case "add_notes": {
      const raw = Array.isArray(input.notes) ? (input.notes as Record<string, unknown>[]) : [];
      return {
        type: "addNotes",
        track: n("track"),
        slot: n("slot"),
        notes: raw.map((x) => ({
          pitch: Number(x.pitch),
          startTime: Number(x.start_time),
          duration: Number(x.duration),
          velocity: Number(x.velocity),
          mute: false,
        })),
      };
    }
    case "set_tempo":
      return { type: "setTempo", bpm: n("bpm") };
    case "fire_clip":
      return { type: "fireClip", track: n("track"), slot: n("slot") };
    case "start_playback":
      return { type: "startPlayback" };
    case "stop_playback":
      return { type: "stopPlayback" };
    case "load_drum_kit":
      return { type: "loadDrumKit", track: n("track"), rackUri: String(input.rack_uri), kitPath: String(input.kit_path) };
    default:
      return null;
  }
}
