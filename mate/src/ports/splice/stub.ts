import fixtures from "./fixtures/sounds.json";
import { hashHex } from "./markdown.ts";
import type { DownloadResult, SearchOptions, Sound, SplicePort, Stack, StackLayer } from "./types.ts";

const LAYER_TYPES = ["drums", "percussion", "bass", "keys"] as const;

/** Splice port backed by a fixture file. Deterministic, offline, never spends credits. */
export class FixtureSpliceAdapter implements SplicePort {
  readonly kind = "stub" as const;
  readonly calls: { method: keyof SplicePort; args: unknown[] }[] = [];
  private readonly sounds: Sound[];

  constructor(sounds: Sound[] = fixtures as Sound[]) {
    this.sounds = sounds;
  }

  async searchSounds(query: string, opts: SearchOptions = {}): Promise<Sound[]> {
    this.calls.push({ method: "searchSounds", args: [query, opts] });
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
    const inRange = this.sounds.filter((s) => {
      if (opts.type && s.type !== opts.type) return false;
      if (s.bpm !== null) {
        if (opts.bpmMin !== undefined && s.bpm < opts.bpmMin) return false;
        if (opts.bpmMax !== undefined && s.bpm > opts.bpmMax) return false;
      }
      return true;
    });
    const score = (s: Sound) => {
      const hay = `${s.fileName} ${s.pack} ${s.tags.join(" ")}`.toLowerCase();
      return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    };
    const ranked = [...inRange].sort((a, b) => score(b) - score(a));
    const matched = ranked.filter((s) => score(s) > 0);
    // Always give the brain something to work with.
    const result = matched.length >= 3 ? matched : ranked.slice(0, Math.max(3, matched.length));
    return result.length ? result : this.sounds.slice(0, 3);
  }

  async promptToStack(prompt: string, bpm: number): Promise<Stack> {
    this.calls.push({ method: "promptToStack", args: [prompt, bpm] });
    return this.fakeStack(`prompt:${prompt}:${bpm}`, prompt.slice(0, 64) || "Stub stack", bpm, undefined);
  }

  async createStack(seedUuid: string, bpm?: number): Promise<Stack> {
    this.calls.push({ method: "createStack", args: [seedUuid, bpm] });
    const seed = this.sounds.find((s) => s.uuid === seedUuid) ?? this.sounds[0]!;
    if (seed.type !== "loop") throw new Error("Splice stacks require a loop as the seed, not a one-shot");
    return this.fakeStack(`seed:${seedUuid}:${bpm ?? ""}`, `Stack from ${seed.fileName}`, bpm ?? seed.bpm ?? 120, seed);
  }

  async downloadAsset(uuid: string): Promise<DownloadResult> {
    this.calls.push({ method: "downloadAsset", args: [uuid] });
    const sound = this.sounds.find((s) => s.uuid === uuid);
    const fileName = sound?.fileName ?? `${uuid}.wav`;
    return { uuid, fileName, url: `https://stub.splice.local/download/${uuid}/${encodeURIComponent(fileName)}` };
  }

  async close(): Promise<void> {}

  private fakeStack(key: string, name: string, bpm: number, seed: Sound | undefined): Stack {
    const h = hashHex(key);
    const pool = this.sounds.filter((s) => s.uuid !== seed?.uuid);
    const start = parseInt(h.slice(0, 4), 16) % Math.max(1, pool.length);
    const picks: Sound[] = seed ? [seed] : [];
    for (let i = 0; picks.length < 4 && i < pool.length; i++) picks.push(pool[(start + i) % pool.length]!);
    const layers: StackLayer[] = picks.map((sound, i) => ({
      uuid: fakeUuid(`${h}:layer:${i}`),
      layerType: LAYER_TYPES[i] ?? "others",
      sound,
    }));
    return { uuid: fakeUuid(`${h}:stack`), name, bpm, layers };
  }
}

function fakeUuid(key: string): string {
  const a = hashHex(key), b = hashHex(key + "b"), c = hashHex(key + "c"), d = hashHex(key + "d");
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-a${c.slice(1, 4)}-${c.slice(4)}${d}`.slice(0, 36);
}
