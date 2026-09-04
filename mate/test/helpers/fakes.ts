import type { MidiNote, SessionState } from "@aibleton/protocol";
import type { AbletonPort, CallContext } from "../../src/ports/ableton/types.ts";
import type { DownloadResult, SearchOptions, Sound, SplicePort, Stack } from "../../src/ports/splice/types.ts";

export function makeSession(overrides: Partial<SessionState["transport"]> = {}, capturedAt = 0): SessionState {
  return {
    transport: { tempo: 120, signatureNumerator: 4, signatureDenominator: 4, isPlaying: false, currentSongTime: 0, songLength: 0, ...overrides },
    tracks: [
      { index: 0, name: "Drums", kind: "midi", mute: false, solo: false, arm: false, volume: 0.85, clipSlots: [{ index: 0, clip: null }], arrangementClips: [] },
    ],
    capturedAt,
  };
}

export type RecordedCall = { method: string; args: unknown[]; ctx?: CallContext };

/** Recording fake for AbletonPort. Keeps a mutable session so tests can observe setTempo etc. */
export class FakeAbleton implements AbletonPort {
  readonly kind = "stub" as const;
  readonly calls: RecordedCall[] = [];
  session: SessionState = makeSession();
  failSnapshot: Error | null = null;
  failNext: Error | null = null;

  private rec(method: string, args: unknown[], ctx?: CallContext) {
    this.calls.push(ctx ? { method, args, ctx } : { method, args });
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }
  async getSnapshot(): Promise<SessionState> {
    if (this.failSnapshot) throw this.failSnapshot;
    this.calls.push({ method: "getSnapshot", args: [] });
    return structuredClone(this.session);
  }
  async createMidiTrack(index?: number, ctx?: CallContext): Promise<number> {
    this.rec("createMidiTrack", [index], ctx);
    return this.session.tracks.length;
  }
  async createClip(track: number, slot: number, lengthBeats: number, ctx?: CallContext) {
    this.rec("createClip", [track, slot, lengthBeats], ctx);
  }
  async addNotes(track: number, slot: number, notes: MidiNote[], ctx?: CallContext) {
    this.rec("addNotes", [track, slot, notes], ctx);
  }
  async setTempo(bpm: number, ctx?: CallContext) {
    this.rec("setTempo", [bpm], ctx);
    this.session = { ...this.session, transport: { ...this.session.transport, tempo: bpm } };
  }
  async fireClip(track: number, slot: number, ctx?: CallContext) {
    this.rec("fireClip", [track, slot], ctx);
  }
  async startPlayback(ctx?: CallContext) {
    this.rec("startPlayback", [], ctx);
  }
  async stopPlayback(ctx?: CallContext) {
    this.rec("stopPlayback", [], ctx);
  }
  async loadDrumKit(track: number, rackUri: string, kitPath: string, ctx?: CallContext) {
    this.rec("loadDrumKit", [track, rackUri, kitPath], ctx);
  }
  async close() {}
  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

export class FakeSplice implements SplicePort {
  readonly kind = "stub" as const;
  readonly calls: RecordedCall[] = [];
  async searchSounds(query: string, opts?: SearchOptions): Promise<Sound[]> {
    this.calls.push({ method: "searchSounds", args: [query, opts] });
    return [];
  }
  async promptToStack(prompt: string, bpm: number): Promise<Stack> {
    this.calls.push({ method: "promptToStack", args: [prompt, bpm] });
    return { uuid: "00000000-0000-0000-0000-000000000000", name: "fake stack", bpm, key: null, layers: [] };
  }
  async createStack(seedUuid: string, bpm?: number): Promise<Stack> {
    this.calls.push({ method: "createStack", args: [seedUuid, bpm] });
    return { uuid: "00000000-0000-0000-0000-000000000001", name: "fake stack", bpm: bpm ?? 120, key: null, layers: [] };
  }
  async downloadAsset(uuid: string): Promise<DownloadResult> {
    this.calls.push({ method: "downloadAsset", args: [uuid] });
    return { uuid, fileName: "fake.wav", url: "https://example.invalid/fake.wav" };
  }
  async close() {}
}
