import type { KeyRoot } from "@aibleton/protocol";

/**
 * A key as Splice tags it. Roots are normalised to the protocol's sharp
 * spelling ("A#", never "Bb"); the mode is null when Splice only gives a root
 * ("Key: a"), which it does for some packs.
 */
export interface SoundKey {
  root: KeyRoot;
  mode: "major" | "minor" | null;
}

export interface Sound {
  uuid: string;
  fileName: string;
  bpm: number | null;
  /** Null for unpitched material (most drum loops) and when Splice omits it. */
  key: SoundKey | null;
  durationSec: number | null;
  type: "loop" | "oneshot";
  pack: string;
  tags: string[];
  url: string;
}

export interface SearchOptions {
  bpmMin?: number;
  bpmMax?: number;
  type?: "loop" | "oneshot";
}

export interface StackLayer {
  uuid: string;
  /** Splice's layer type, lowercased: "drums", "bass", "keys", "pads"... */
  layerType: string;
  sound: Sound;
}

/**
 * A Splice stack. `bpm` and `key` are what the stack *player* renders at; the
 * layers' sounds keep their catalog bpm and key, which is what a download gives.
 */
export interface Stack {
  uuid: string;
  name: string;
  bpm: number;
  key: SoundKey | null;
  layers: StackLayer[];
  shareUrl?: string;
  /** Raw text from the server, kept because Splice returns markdown rather than JSON. */
  raw?: string;
}

export interface DownloadResult {
  uuid: string;
  fileName: string;
  url: string;
}

export interface SplicePort {
  readonly kind: "mcp" | "stub";
  searchSounds(query: string, opts?: SearchOptions): Promise<Sound[]>;
  promptToStack(prompt: string, bpm: number): Promise<Stack>;
  createStack(seedUuid: string, bpm?: number): Promise<Stack>;
  /** Spends a Splice credit on first download of an asset; not wired to any brain tool yet. */
  downloadAsset(uuid: string): Promise<DownloadResult>;
  close(): Promise<void>;
}

export interface SplicePortResult {
  port: SplicePort;
  live: boolean;
  fallbackReason?: string;
}
