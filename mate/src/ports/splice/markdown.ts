import type { KeyRoot } from "@aibleton/protocol";
import type { Sound, SoundKey, Stack, StackLayer } from "./types.ts";

/**
 * Splice's MCP server returns markdown, not JSON. These parsers are line-oriented and
 * tolerant of missing fields. They are fixture-tested against real responses captured on
 * 2026-09-03 (search) and 2026-09-04 (search with keys, stack) and will need attention if
 * Splice changes its formatting.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** `### 1. FILE.wav` in search results, `### Layer 1: Drums` in stacks. */
const HEADING_RE = /^#{2,4}\s+(?:(\d+)\.\s+(.+?)|Layer\s+(\d+):\s*(.+?))\s*$/i;

interface Block {
  /** File name for search blocks; the layer type for stack blocks. */
  title: string;
  /** Set only for `### Layer N: <type>` headings. */
  layerType: string | null;
  body: string;
}

function field(block: string, label: string): string | undefined {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, "i");
  return block.match(re)?.[1]?.trim();
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Split markdown into heading blocks; anything before the first heading is dropped. */
function blocks(md: string): Block[] {
  const out: { title: string; layerType: string | null; body: string[] }[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(HEADING_RE);
    if (m) out.push({ title: (m[2] ?? m[4] ?? "").replace(/\*\*/g, "").trim(), layerType: m[4] ? m[4].trim() : null, body: [] });
    else if (out.length) out[out.length - 1]!.body.push(line);
  }
  return out.map((b) => ({ title: b.title, layerType: b.layerType, body: b.body.join("\n") }));
}

const FLATS: Record<string, KeyRoot> = { DB: "C#", EB: "D#", GB: "F#", AB: "G#", BB: "A#", CB: "B", FB: "E" };
const SHARP_FIXUPS: Record<string, KeyRoot> = { "E#": "F", "B#": "C" };
const ROOTS = new Set<string>(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]);

/**
 * Parse a key as Splice writes it: `f# minor`, `a# major`, or a bare root `a`.
 * Flats are folded to sharps. Returns null for anything unrecognised.
 */
export function parseKey(raw: string | undefined | null): SoundKey | null {
  const m = raw?.trim().match(/^([a-g])\s*(#|♯|b|♭)?\s*(major|minor|maj|min|m)?\s*$/i);
  if (!m) return null;
  const letter = m[1]!.toUpperCase();
  const accidental = m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : (m[2] ?? "");
  let root: string = letter + accidental;
  if (accidental === "b") root = FLATS[root.toUpperCase()] ?? root;
  root = SHARP_FIXUPS[root] ?? root;
  if (!ROOTS.has(root)) return null;
  const modeRaw = m[3]?.toLowerCase();
  const mode: SoundKey["mode"] = !modeRaw ? null : modeRaw.startsWith("maj") ? "major" : "minor";
  return { root: root as KeyRoot, mode };
}

/**
 * Build a sound from one block body. The body's first UUID is not always the asset's
 * (stack layers list the layer UUID first), so the labelled field wins and `exclude`
 * keeps a fallback scan from picking up a known non-asset UUID.
 */
function soundFromBlock(fileName: string, body: string, exclude: string[] = []): Sound | null {
  const labelled = field(body, "Asset UUID")?.match(UUID_RE)?.[0];
  const skip = new Set(exclude.map((u) => u.toLowerCase()));
  const scanned = body.match(new RegExp(UUID_RE.source, "gi"))?.find((u) => !skip.has(u.toLowerCase()));
  const uuid = labelled ?? scanned;
  if (!uuid) return null;
  const typeRaw = body.match(/Type:\s*(loop|one-?shot)/i)?.[1]?.toLowerCase();
  const tags = (field(body, "Tags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    uuid: uuid.toLowerCase(),
    fileName,
    bpm: num(body.match(/\bBPM:\s*([\d.]+)/i)?.[1]),
    key: parseKey(body.match(/\bKey:\s*([^|\n]+)/i)?.[1]),
    durationSec: num(body.match(/Duration:\s*([\d.]+)\s*s/i)?.[1]),
    type: typeRaw && typeRaw.startsWith("one") ? "oneshot" : "loop",
    pack: field(body, "Pack") ?? "",
    tags,
    url: field(body, "Link")?.match(/https?:\/\/\S+/)?.[0] ?? "",
  };
}

/**
 * Parse the `describe_a_sound` result. Expected block shape:
 *   ### 1. FILE_NAME.wav
 *   BPM: 124 | Key: f# minor | Duration: 7.7s | Type: loop      (Key only for pitched sounds)
 *   **Pack:** That Sound
 *   **Tags:** drums, acoustic
 *   **Link:** https://splice.com/...
 *   **Asset UUID:** 368ee8d9-...
 */
export function parseSearchResults(md: string): Sound[] {
  const sounds: Sound[] = [];
  for (const block of blocks(md)) {
    if (block.layerType !== null) continue;
    const sound = soundFromBlock(block.title, block.body);
    if (sound) sounds.push(sound);
  }
  return sounds;
}

/**
 * Parse a stack result from `prompt_to_stack` / `create_stack` / `update_stack`.
 * Real shape (fixtures/stack_response.md):
 *   ## Stack: <name>
 *   **BPM:** 120 | **Key:** f minor
 *   ### Layer 1: Drums
 *   **Layer UUID:** <uuid>
 *   **Sample:** FILE_NAME.wav
 *   BPM: 130 | Duration: 7.4s | Type: loop        (plus Pack, Tags, Link, Asset UUID as in search)
 *   ...
 *   **Stack UUID:** <uuid>
 *   **Permalink:** https://splice.com/sounds/stacks/<uuid>
 * Anything not found falls back to the provided defaults; the raw text is always kept.
 */
export function parseStack(md: string, fallback: { name: string; bpm: number }): Stack {
  const stackUuid = field(md, "Stack UUID")?.match(UUID_RE)?.[0] ?? md.match(/Stack UUID:?\s*([0-9a-f-]{36})/i)?.[1];
  const name = md.match(/^#{1,3}\s+Stack:\s*(.+?)\s*$/im)?.[1] ?? field(md, "Name") ?? fallback.name;
  const bpm = num(field(md, "BPM")?.match(/[\d.]+/)?.[0]) ?? fallback.bpm;
  const key = parseKey(field(md, "Key")?.match(/^[^|\n]+/)?.[0]);
  const shareUrl =
    field(md, "Permalink")?.match(/https?:\/\/\S+/)?.[0] ??
    field(md, "Share URL")?.match(/https?:\/\/\S+/)?.[0] ??
    md.match(/https?:\/\/(?:www\.)?splice\.com\/\S*stacks?\/\S+/i)?.[0];

  const layers: StackLayer[] = [];
  for (const block of blocks(md)) {
    const layerUuid = field(block.body, "Layer UUID")?.match(UUID_RE)?.[0];
    const fileName = field(block.body, "Sample") ?? block.title;
    const sound = soundFromBlock(fileName, block.body, layerUuid ? [layerUuid] : []);
    if (!sound) continue;
    layers.push({
      uuid: (layerUuid ?? sound.uuid).toLowerCase(),
      layerType: (block.layerType ?? field(block.body, "Layer Type") ?? "unknown").toLowerCase(),
      sound,
    });
  }

  const uuid = stackUuid ?? (layers.length === 0 ? md.match(UUID_RE)?.[0] : undefined) ?? `unknown-${hashHex(md)}`;
  return { uuid: uuid.toLowerCase(), name, bpm, key, layers, shareUrl, raw: md };
}

/** Parse a `download_asset` result: a presigned URL plus a file name. */
export function parseDownload(md: string, uuid: string): { uuid: string; fileName: string; url: string } {
  const url = md.match(/https?:\/\/[^\s)>\]]+/)?.[0] ?? "";
  const fileName =
    field(md, "File(?: name)?") ?? md.match(/([\w.-]+\.(?:wav|aiff?|mp3|flac|mid))/i)?.[1] ?? uuid;
  return { uuid, fileName, url };
}

/** Small deterministic hash used for synthetic ids (shared with the stub). */
export function hashHex(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
