import type { MidiNote, SessionState } from "@aibleton/protocol";

export type { MidiNote, SessionState };

/** Per-call context. `userPrompt` is forwarded to the Ableton MCP server's telemetry field. */
export interface CallContext {
  userPrompt?: string;
}

/** Domain-level view of Ableton. No MCP types leak through this interface. */
export interface AbletonPort {
  readonly kind: "mcp" | "stub";
  getSnapshot(ctx?: CallContext): Promise<SessionState>;
  /** Returns the index of the new track. */
  createMidiTrack(index?: number, ctx?: CallContext): Promise<number>;
  createClip(track: number, slot: number, lengthBeats: number, ctx?: CallContext): Promise<void>;
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
