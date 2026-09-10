import type { MidiNote, DawState } from "@aibleton/protocol";

export type { MidiNote, DawState };

/** Per-call context. `userPrompt` is forwarded to the Ableton MCP server's telemetry field. */
export interface CallContext {
  userPrompt?: string;
}

/** Domain-level view of Ableton. No MCP types leak through this interface. */
export interface AbletonPort {
  readonly kind: "mcp" | "stub";
  getSnapshot(ctx?: CallContext): Promise<DawState>;
  /** Returns the index of the new track. */
  createMidiTrack(index?: number, ctx?: CallContext): Promise<number>;
  /** Creates an audio track at the end of the set, named `name`. Returns its index. */
  createAudioTrack(name: string, ctx?: CallContext): Promise<number>;
  setTrackName(track: number, name: string, ctx?: CallContext): Promise<void>;
  createClip(track: number, slot: number, lengthBeats: number, ctx?: CallContext): Promise<void>;
  /**
   * Imports an audio file into an empty session slot on an audio track. Live
   * decides the clip's warp and length; the length it settled on comes back.
   */
  createAudioClip(track: number, slot: number, path: string, ctx?: CallContext): Promise<{ lengthBeats: number }>;
  setClipName(track: number, slot: number, name: string, ctx?: CallContext): Promise<void>;
  deleteClip(track: number, slot: number, ctx?: CallContext): Promise<void>;
  /** Copies a session clip into the arrangement at a beat position on its own track. */
  duplicateToArrangement(track: number, slot: number, atBeat: number, ctx?: CallContext): Promise<void>;
  createLocator(name: string, atBeat: number, ctx?: CallContext): Promise<void>;
  addNotes(track: number, slot: number, notes: MidiNote[], ctx?: CallContext): Promise<void>;
  setTempo(bpm: number, ctx?: CallContext): Promise<void>;
  fireClip(track: number, slot: number, ctx?: CallContext): Promise<void>;
  startPlayback(ctx?: CallContext): Promise<void>;
  stopPlayback(ctx?: CallContext): Promise<void>;
  loadDrumKit(track: number, rackUri: string, kitPath: string, ctx?: CallContext): Promise<void>;
  close(): Promise<void>;
}

export interface AbletonPortResult {
  port: AbletonPort;
  live: boolean;
  /** Why `auto` fell back to the stub, if it did. */
  fallbackReason?: string;
}
