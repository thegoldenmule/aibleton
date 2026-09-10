import type { DawState } from "@aibleton/protocol";
import type { Logger } from "../../log.ts";
import { McpConnection } from "../mcp/client.ts";
import { parseSnapshotV2, parseToolJson, toDawState } from "./snapshot.schema.ts";
import type { AbletonPort, CallContext, MidiNote } from "./types.ts";

export interface McpAbletonOptions {
  command: string;
  args: string[];
  log: Logger;
  connectTimeoutMs?: number;
  now?: () => number;
}

/** Importing a file makes Live analyse it; the server allows the remote script a minute. */
const IMPORT_TIMEOUT_MS = 90_000;

/**
 * The server answers every failure with prose starting "Error", never an MCP
 * error, and answers most mutations with a sentence rather than JSON. So a
 * result is checked for that prefix before anything else is read from it.
 */
export function assertNotError(text: string, tool: string): string {
  const inner = unwrapResult(text);
  if (/^\s*error\b/i.test(inner)) throw new Error(`${tool}: ${inner.trim().slice(0, 300)}`);
  return inner;
}

function unwrapResult(text: string): string {
  try {
    const outer = JSON.parse(text.trim());
    if (outer && typeof outer === "object" && "result" in outer && typeof outer.result === "string") return outer.result;
  } catch {
    // Bare text.
  }
  return text;
}

/** AbletonPort backed by the `ableton-mcp` stdio server. */
export class McpAbletonAdapter implements AbletonPort {
  readonly kind = "mcp" as const;
  private readonly conn: McpConnection;
  private readonly now: () => number;

  constructor(private readonly opts: McpAbletonOptions) {
    this.conn = new McpConnection({ kind: "stdio", command: opts.command, args: opts.args }, opts.log, "aibleton-mate-ableton");
    this.now = opts.now ?? Date.now;
  }

  async connect(): Promise<void> {
    await this.conn.connect(this.opts.connectTimeoutMs ?? 15_000);
  }

  /** Calls a tool; throws on the server's "Error ..." replies; returns the raw inner text. */
  private async callText(name: string, args: Record<string, unknown>, ctx?: CallContext, timeoutMs?: number): Promise<string> {
    const text = await this.conn.callTool(name, { ...args, user_prompt: ctx?.userPrompt ?? "" }, timeoutMs);
    return assertNotError(text, name);
  }

  /** Calls a tool and parses its JSON payload; undefined when the reply is prose (most mutations). */
  private async call(name: string, args: Record<string, unknown>, ctx?: CallContext): Promise<unknown> {
    const text = await this.callText(name, args, ctx);
    try {
      return parseToolJson(text);
    } catch {
      this.opts.log.debug(`non-JSON result from ${name}`, text.slice(0, 200));
      return undefined;
    }
  }

  async getSnapshot(ctx?: CallContext): Promise<DawState> {
    const raw = await this.call("get_session_snapshot", { include_notes: true, include_params: false }, ctx);
    return toDawState(parseSnapshotV2(raw), this.now());
  }

  async createMidiTrack(index = -1, ctx?: CallContext): Promise<number> {
    const res = await this.call("create_midi_track", { index }, ctx);
    const parsed = extractIndex(res);
    if (parsed !== null) return parsed;
    const snap = await this.getSnapshot(ctx);
    const at = index < 0 || index >= snap.tracks.length ? snap.tracks.length - 1 : index;
    const track = snap.tracks[at];
    if (!track || track.kind !== "midi") throw new Error(`create_midi_track: no MIDI track at ${at} after creation`);
    return track.index;
  }

  async createAudioTrack(name: string, ctx?: CallContext): Promise<number> {
    // The reply is a sentence with the default name in it, so the index comes from a fresh snapshot.
    await this.callText("create_audio_track", { index: -1 }, ctx);
    const snap = await this.getSnapshot(ctx);
    const track = snap.tracks[snap.tracks.length - 1];
    if (!track || track.kind !== "audio") throw new Error("create_audio_track: no audio track at the end of the set after creation");
    await this.setTrackName(track.index, name, ctx);
    return track.index;
  }

  async setTrackName(track: number, name: string, ctx?: CallContext): Promise<void> {
    await this.callText("set_track_name", { track_index: track, name }, ctx);
  }

  async createClip(track: number, slot: number, lengthBeats: number, ctx?: CallContext): Promise<void> {
    await this.callText("create_clip", { track_index: track, clip_index: slot, length: lengthBeats }, ctx);
  }

  async createAudioClip(track: number, slot: number, path: string, ctx?: CallContext): Promise<{ lengthBeats: number }> {
    const text = await this.callText("create_audio_clip", { track_index: track, clip_index: slot, path }, ctx, IMPORT_TIMEOUT_MS);
    // "Created audio clip 'x' at track 4, slot 0 (length 16.0 beats)"
    const m = /\(length\s+([0-9.]+)\s+beats\)/.exec(text);
    if (m) return { lengthBeats: Number(m[1]) };
    const snap = await this.getSnapshot(ctx);
    const clip = snap.tracks[track]?.clipSlots[slot]?.clip;
    if (!clip) throw new Error(`create_audio_clip: no clip at track ${track} slot ${slot} after import`);
    return { lengthBeats: clip.length };
  }

  async setClipName(track: number, slot: number, name: string, ctx?: CallContext): Promise<void> {
    await this.callText("set_clip_name", { track_index: track, clip_index: slot, name }, ctx);
  }

  async deleteClip(track: number, slot: number, ctx?: CallContext): Promise<void> {
    await this.callText("delete_clip", { track_index: track, clip_index: slot }, ctx);
  }

  async duplicateToArrangement(track: number, slot: number, atBeat: number, ctx?: CallContext): Promise<void> {
    await this.callText("duplicate_to_arrangement", { track_index: track, clip_index: slot, destination_time: atBeat }, ctx);
  }

  async createLocator(name: string, atBeat: number, ctx?: CallContext): Promise<void> {
    await this.callText("create_locator", { name, time: atBeat }, ctx);
  }

  async addNotes(track: number, slot: number, notes: MidiNote[], ctx?: CallContext): Promise<void> {
    await this.callText(
      "add_notes_to_clip",
      {
        track_index: track,
        clip_index: slot,
        notes: notes.map((n) => ({
          pitch: n.pitch,
          start_time: n.startTime,
          duration: n.duration,
          velocity: n.velocity,
          mute: n.mute ?? false,
        })),
      },
      ctx,
    );
  }

  async setTempo(bpm: number, ctx?: CallContext): Promise<void> {
    await this.callText("set_tempo", { tempo: bpm }, ctx);
  }

  async fireClip(track: number, slot: number, ctx?: CallContext): Promise<void> {
    await this.callText("fire_clip", { track_index: track, clip_index: slot }, ctx);
  }

  async startPlayback(ctx?: CallContext): Promise<void> {
    await this.callText("start_playback", {}, ctx);
  }

  async stopPlayback(ctx?: CallContext): Promise<void> {
    await this.callText("stop_playback", {}, ctx);
  }

  async loadDrumKit(track: number, rackUri: string, kitPath: string, ctx?: CallContext): Promise<void> {
    await this.callText("load_drum_kit", { track_index: track, rack_uri: rackUri, kit_path: kitPath }, ctx);
  }

  async close(): Promise<void> {
    await this.conn.close();
  }
}

/** Pull a track index out of whatever create_midi_track returned, if it is there. */
function extractIndex(res: unknown): number | null {
  if (typeof res === "number") return res;
  if (res && typeof res === "object") {
    const o = res as Record<string, unknown>;
    for (const key of ["index", "track_index"]) {
      const v = o[key];
      if (typeof v === "number") return v;
    }
  }
  return null;
}
