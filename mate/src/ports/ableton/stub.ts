import type { SessionState, Track } from "@aibleton/protocol";
import type { AbletonPort, CallContext, MidiNote } from "./types.ts";

export interface StubCall {
  method: string;
  args: unknown[];
  ctx?: CallContext;
}

function emptyTrack(index: number, name: string, kind: Track["kind"], slots = 8): Track {
  return {
    index,
    name,
    kind,
    mute: false,
    solo: false,
    arm: false,
    volume: 0.85,
    clipSlots: Array.from({ length: slots }, (_, i) => ({ index: i, clip: null })),
    arrangementClips: [],
  };
}

/** Default state shaped like the live set seen during planning: 2 MIDI + 2 audio tracks, 8 slots, 120 BPM. */
export function defaultStubSession(capturedAt = 0): SessionState {
  return {
    transport: {
      tempo: 120,
      signatureNumerator: 4,
      signatureDenominator: 4,
      isPlaying: false,
      currentSongTime: 0,
      songLength: 232,
    },
    tracks: [
      emptyTrack(0, "1-MIDI", "midi"),
      emptyTrack(1, "2-MIDI", "midi"),
      emptyTrack(2, "3-Audio", "audio"),
      emptyTrack(3, "4-Audio", "audio"),
    ],
    capturedAt,
  };
}

/** In-memory Ableton. Mutations update the held session so the UI and tests can observe them. */
export class InMemoryAbletonAdapter implements AbletonPort {
  readonly kind = "stub" as const;
  readonly calls: StubCall[] = [];
  private session: SessionState;
  private readonly now: () => number;

  constructor(opts: { session?: SessionState; now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.session = structuredClone(opts.session ?? defaultStubSession(this.now()));
  }

  private touch(): void {
    this.session.capturedAt = this.now();
  }

  private track(index: number): Track {
    const t = this.session.tracks[index];
    if (!t) throw new Error(`no track at index ${index}`);
    return t;
  }

  private slot(trackIndex: number, slotIndex: number) {
    const s = this.track(trackIndex).clipSlots[slotIndex];
    if (!s) throw new Error(`no clip slot ${slotIndex} on track ${trackIndex}`);
    return s;
  }

  async getSnapshot(ctx?: CallContext): Promise<SessionState> {
    this.calls.push({ method: "getSnapshot", args: [], ctx });
    return structuredClone(this.session);
  }

  async createMidiTrack(index = -1, ctx?: CallContext): Promise<number> {
    this.calls.push({ method: "createMidiTrack", args: [index], ctx });
    const at = index < 0 || index > this.session.tracks.length ? this.session.tracks.length : index;
    const slots = this.session.tracks[0]?.clipSlots.length ?? 8;
    this.session.tracks.splice(at, 0, emptyTrack(at, `${at + 1}-MIDI`, "midi", slots));
    this.session.tracks.forEach((t, i) => (t.index = i));
    this.touch();
    return at;
  }

  async createClip(track: number, slot: number, lengthBeats: number, ctx?: CallContext): Promise<void> {
    this.calls.push({ method: "createClip", args: [track, slot, lengthBeats], ctx });
    if (this.track(track).kind !== "midi") throw new Error(`track ${track} is not a MIDI track`);
    const s = this.slot(track, slot);
    if (s.clip) throw new Error(`slot ${slot} on track ${track} already has a clip`);
    s.clip = { name: "", length: lengthBeats, isPlaying: false, notes: [] };
    this.touch();
  }

  async addNotes(track: number, slot: number, notes: MidiNote[], ctx?: CallContext): Promise<void> {
    this.calls.push({ method: "addNotes", args: [track, slot, notes], ctx });
    const s = this.slot(track, slot);
    if (!s.clip) throw new Error(`slot ${slot} on track ${track} has no clip`);
    s.clip.notes = [...(s.clip.notes ?? []), ...notes.map((n) => ({ ...n }))];
    this.touch();
  }

  async setTempo(bpm: number, ctx?: CallContext): Promise<void> {
    this.calls.push({ method: "setTempo", args: [bpm], ctx });
    if (!(bpm > 0)) throw new Error(`invalid tempo ${bpm}`);
    this.session.transport.tempo = bpm;
    this.touch();
  }

  async fireClip(track: number, slot: number, ctx?: CallContext): Promise<void> {
    this.calls.push({ method: "fireClip", args: [track, slot], ctx });
    const s = this.slot(track, slot);
    if (!s.clip) throw new Error(`slot ${slot} on track ${track} has no clip`);
    for (const other of this.track(track).clipSlots) if (other.clip) other.clip.isPlaying = false;
    s.clip.isPlaying = true;
    this.session.transport.isPlaying = true;
    this.touch();
  }

  async startPlayback(ctx?: CallContext): Promise<void> {
    this.calls.push({ method: "startPlayback", args: [], ctx });
    this.session.transport.isPlaying = true;
    this.touch();
  }

  async stopPlayback(ctx?: CallContext): Promise<void> {
    this.calls.push({ method: "stopPlayback", args: [], ctx });
    this.session.transport.isPlaying = false;
    for (const t of this.session.tracks) for (const s of t.clipSlots) if (s.clip) s.clip.isPlaying = false;
    this.touch();
  }

  async loadDrumKit(track: number, rackUri: string, kitPath: string, ctx?: CallContext): Promise<void> {
    this.calls.push({ method: "loadDrumKit", args: [track, rackUri, kitPath], ctx });
    if (this.track(track).kind !== "midi") throw new Error(`track ${track} is not a MIDI track`);
    this.touch();
  }

  async close(): Promise<void> {}
}
