export interface Sound {
  uuid: string;
  fileName: string;
  bpm: number | null;
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
  layerType: string;
  sound: Sound;
}

export interface Stack {
  uuid: string;
  name: string;
  bpm: number;
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
