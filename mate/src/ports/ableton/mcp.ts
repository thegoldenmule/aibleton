import type { SessionState } from "@aibleton/protocol";
import type { Logger } from "../../log.ts";
import { McpConnection } from "../mcp/client.ts";
import { parseSnapshotV2, parseToolJson, toSessionState } from "./snapshot.schema.ts";
import type { AbletonPort, CallContext, MidiNote } from "./types.ts";

export interface McpAbletonOptions {
  command: string;
  args: string[];
  log: Logger;
  connectTimeoutMs?: number;
  now?: () => number;
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

  private async call(name: string, args: Record<string, unknown>, ctx?: CallContext): Promise<unknown> {
    const text = await this.conn.callTool(name, { ...args, user_prompt: ctx?.userPrompt ?? "" });
    try {
      return parseToolJson(text);
    } catch {
      // Some mutating tools may answer with plain text; callers that need data handle undefined.
      this.opts.log.debug(`non-JSON result from ${name}`, text.slice(0, 200));
      return undefined;
    }
  }

  async getSnapshot(ctx?: CallContext): Promise<SessionState> {
    const raw = await this.call("get_session_snapshot", { include_notes: true, include_params: false }, ctx);
    return toSessionState(parseSnapshotV2(raw), this.now());
  }

  async createMidiTrack(index = -1, ctx?: CallContext): Promise<number> {
    const res = await this.call("create_midi_track", { index }, ctx);
    const parsed = extractIndex(res);
    if (parsed !== null) return parsed;
    const snap = await this.getSnapshot(ctx);
    const midi = snap.tracks.filter((t) => t.kind === "midi");
    const last = midi[midi.length - 1];
    if (!last) throw new Error("create_midi_track: no MIDI track found after creation");
    return last.index;
  }

  async createClip(track: number, slot: number, lengthBeats: number, ctx?: CallContext): Promise<void> {
    await this.call("create_clip", { track_index: track, clip_index: slot, length: lengthBeats }, ctx);
  }

  async addNotes(track: number, slot: number, notes: MidiNote[], ctx?: CallContext): Promise<void> {
    await this.call(
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
    await this.call("set_tempo", { tempo: bpm }, ctx);
  }

  async fireClip(track: number, slot: number, ctx?: CallContext): Promise<void> {
    await this.call("fire_clip", { track_index: track, clip_index: slot }, ctx);
  }

  async startPlayback(ctx?: CallContext): Promise<void> {
    await this.call("start_playback", {}, ctx);
  }

  async stopPlayback(ctx?: CallContext): Promise<void> {
    await this.call("stop_playback", {}, ctx);
  }

  async loadDrumKit(track: number, rackUri: string, kitPath: string, ctx?: CallContext): Promise<void> {
    await this.call("load_drum_kit", { track_index: track, rack_uri: rackUri, kit_path: kitPath }, ctx);
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
