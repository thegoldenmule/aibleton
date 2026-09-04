import type { Sound, Stack, StackLayer } from "./types.ts";

/**
 * Splice's MCP server returns markdown, not JSON. These parsers are line-oriented and
 * tolerant of missing fields; they are fixture-tested against a real response captured
 * on 2026-09-03 and will need attention if Splice changes its formatting.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEADING_RE = /^#{2,4}\s+(\d+)\.\s+(.+?)\s*$/;

function field(block: string, label: string): string | undefined {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, "i");
  return block.match(re)?.[1]?.trim();
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Split markdown into `### N. <title>` blocks; returns [title, body] pairs. */
function numberedBlocks(md: string): { title: string; body: string }[] {
  const lines = md.split(/\r?\n/);
  const blocks: { title: string; body: string[] }[] = [];
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) blocks.push({ title: m[2]!, body: [] });
    else if (blocks.length) blocks[blocks.length - 1]!.body.push(line);
  }
  return blocks.map((b) => ({ title: b.title, body: b.body.join("\n") }));
}

/**
 * Parse the `describe_a_sound` result. Expected block shape:
 *   ### 1. FILE_NAME.wav
 *   BPM: 124 | Duration: 7.7s | Type: loop
 *   **Pack:** That Sound
 *   **Tags:** drums, acoustic
 *   **Link:** https://splice.com/...
 *   **Asset UUID:** 368ee8d9-...
 */
export function parseSearchResults(md: string): Sound[] {
  const sounds: Sound[] = [];
  for (const { title, body } of numberedBlocks(md)) {
    const uuid = field(body, "Asset UUID")?.match(UUID_RE)?.[0] ?? body.match(UUID_RE)?.[0];
    if (!uuid) continue;
    const bpm = num(body.match(/BPM:\s*([\d.]+)/i)?.[1]);
    const durationSec = num(body.match(/Duration:\s*([\d.]+)\s*s/i)?.[1]);
    const typeRaw = body.match(/Type:\s*(loop|one-?shot)/i)?.[1]?.toLowerCase();
    const type: Sound["type"] = typeRaw && typeRaw.startsWith("one") ? "oneshot" : "loop";
    const tags = (field(body, "Tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    sounds.push({
      uuid: uuid.toLowerCase(),
      fileName: title.replace(/\*\*/g, "").trim(),
      bpm,
      durationSec,
      type,
      pack: field(body, "Pack") ?? "",
      tags,
      url: field(body, "Link")?.match(/https?:\/\/\S+/)?.[0] ?? "",
    });
  }
  return sounds;
}

/**
 * Parse a stack result from `prompt_to_stack` / `create_stack` / `update_stack`.
 *
 * No real response has been captured yet, so this is deliberately lenient. Assumed format
 * (based on the tool descriptions, which mention "Stack UUID", "Layer UUID" and a share URL):
 *   **Stack UUID:** <uuid>          (or "Stack UUID: <uuid>")
 *   **Name:** <name>                (optional)
 *   **BPM:** 120                    (optional)
 *   ### 1. <layer file name>        (one numbered block per layer, like search results)
 *   **Layer UUID:** <uuid>
 *   **Layer Type:** drums           (optional)
 *   **Asset UUID:** <uuid>          (optional)
 *   **Share URL:** https://...      (optional)
 * Anything not found falls back to the provided defaults; the raw text is always kept.
 */
export function parseStack(md: string, fallback: { name: string; bpm: number }): Stack {
  const stackUuid =
    md.match(/Stack UUID:?\**\s*:?\s*(?:\*\*)?\s*([0-9a-f-]{36})/i)?.[1] ??
    md.match(UUID_RE)?.[0] ??
    `unknown-${hashHex(md)}`;
  const name = field(md, "Name") ?? md.match(/^#{1,3}\s+(?!\d+\.)(.+)$/m)?.[1]?.trim() ?? fallback.name;
  const bpm = num(md.match(/\*\*BPM:\*\*\s*([\d.]+)/i)?.[1] ?? md.match(/\bBPM:?\s*([\d.]+)/i)?.[1]) ?? fallback.bpm;
  const shareUrl = md.match(/https?:\/\/(?:www\.)?splice\.com\/\S*stacks?\/\S+/i)?.[0];

  const layers: StackLayer[] = [];
  for (const { title, body } of numberedBlocks(md)) {
    const layerUuid = field(body, "Layer UUID")?.match(UUID_RE)?.[0];
    const assetUuid = field(body, "Asset UUID")?.match(UUID_RE)?.[0];
    const anyUuid = layerUuid ?? assetUuid ?? body.match(UUID_RE)?.[0];
    if (!anyUuid) continue;
    const sound = parseSearchResults(`### 1. ${title}\n${body}`)[0] ?? {
      uuid: (assetUuid ?? anyUuid).toLowerCase(),
      fileName: title,
      bpm: num(body.match(/BPM:\s*([\d.]+)/i)?.[1]),
      durationSec: null,
      type: "loop" as const,
      pack: field(body, "Pack") ?? "",
      tags: [],
      url: "",
    };
    layers.push({
      uuid: (layerUuid ?? anyUuid).toLowerCase(),
      layerType: field(body, "Layer Type")?.toLowerCase() ?? field(body, "Type")?.toLowerCase() ?? "unknown",
      sound,
    });
  }

  return { uuid: stackUuid.toLowerCase(), name, bpm, layers, shareUrl, raw: md };
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
