import { KEY_ROOTS, LOOP_BARS, MAX_ADDED_PARTS, MAX_BPM, MAX_BRIEF_GENRES, MAX_BRIEF_HINTS, MIN_BPM } from "@aibleton/protocol";
import type { Band, Template } from "@aibleton/protocol";

/**
 * The deterministic clamp between the model's JSON and `SongBriefSchema`.
 * The structured-output schema cannot carry numeric or length limits, so a
 * brief that is nearly right (a bpm window written backwards, six genres, a
 * part id the band does not have) is repaired here rather than rejected after
 * a slow call. Shape errors still fall through to the schema.
 */
export function normalizeBrief(raw: unknown, template: Template, band: Band): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };

  out.summary = typeof raw.summary === "string" ? raw.summary.trim() || "a new song" : raw.summary;
  out.genres = words(raw.genres, MAX_BRIEF_GENRES);
  if (Array.isArray(out.genres) && out.genres.length === 0) out.genres = ["groove"];
  out.descriptors = words(raw.descriptors, MAX_BRIEF_HINTS);
  out.key = normalizeKey(raw.key);
  out.bpm = normalizeBpm(raw.bpm);
  out.timeSignature = normalizeTimeSignature(raw.timeSignature);
  out.swing = unit(raw.swing);

  const partIds = new Set(band.parts.map((p) => p.id));
  out.parts = Array.isArray(raw.parts)
    ? raw.parts
        .filter((p): p is Record<string, unknown> => isRecord(p) && typeof p.partId === "string" && partIds.has(p.partId))
        .map((p) => ({
          partId: p.partId,
          keep: p.keep !== false,
          brief: optionalText(p.brief),
          soundHints: words(p.soundHints, MAX_BRIEF_HINTS),
          loopBars: nearestLoop(p.loopBars),
        }))
    : raw.parts;

  const labels = new Set(Object.keys(template.sections));
  out.sections = Array.isArray(raw.sections)
    ? raw.sections
        .filter((s): s is Record<string, unknown> => isRecord(s) && typeof s.label === "string" && labels.has(s.label))
        .map((s) => ({
          label: s.label,
          brief: optionalText(s.brief),
          descriptors: words(s.descriptors, MAX_BRIEF_HINTS),
          intensity: unit(s.intensity),
        }))
    : raw.sections;

  out.templateFeedback = isRecord(raw.templateFeedback)
    ? { form: optionalText(raw.templateFeedback.form), notes: text(raw.templateFeedback.notes) }
    : { form: null, notes: "" };
  out.bandFeedback = isRecord(raw.bandFeedback)
    ? {
        addParts: Array.isArray(raw.bandFeedback.addParts)
          ? raw.bandFeedback.addParts.filter(isRecord).slice(0, MAX_ADDED_PARTS)
          : [],
        notes: text(raw.bandFeedback.notes),
      }
    : { addParts: [], notes: "" };

  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function optionalText(v: unknown): string | null {
  const t = text(v);
  return t ? t : null;
}

/** Trimmed, deduplicated (case-insensitively) strings, cut to `max`. */
function words(v: unknown, max: number): unknown {
  if (!Array.isArray(v)) return v;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const w = item.trim();
    const key = w.toLowerCase();
    if (!w || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length === max) break;
  }
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function unit(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) ? clamp(v, 0, 1) : v;
}

function normalizeKey(v: unknown): unknown {
  if (!isRecord(v)) return v;
  const root = typeof v.root === "string" ? canonicalRoot(v.root) : v.root;
  const mode = typeof v.mode === "string" ? v.mode.trim().toLowerCase() : v.mode;
  return { root, mode: mode === "maj" ? "major" : mode === "min" || mode === "aeolian" ? "minor" : mode };
}

/** "Eb" -> "D#", "f#" -> "F#", "Bb minor" -> "A#". */
function canonicalRoot(text: string): string {
  const m = /^\s*([a-gA-G])\s*([#b♭♯]?)/.exec(text);
  if (!m) return text;
  const letter = m[1]!.toUpperCase();
  const accidental = m[2] ?? "";
  const index = KEY_ROOTS.indexOf(letter as (typeof KEY_ROOTS)[number]);
  if (index < 0) return text;
  const shift = accidental === "#" || accidental === "♯" ? 1 : accidental === "b" || accidental === "♭" ? -1 : 0;
  return KEY_ROOTS[(index + shift + KEY_ROOTS.length) % KEY_ROOTS.length]!;
}

function normalizeBpm(v: unknown): unknown {
  if (!isRecord(v)) return v;
  const num = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(clamp(n, MIN_BPM, MAX_BPM)) : null);
  const min = num(v.min);
  const max = num(v.max);
  const target = num(v.target);
  if (min === null || max === null || target === null) return v;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return { min: Math.min(lo, target), max: Math.max(hi, target), target };
}

function normalizeTimeSignature(v: unknown): unknown {
  if (v === null || v === undefined) return { numerator: 4, denominator: 4 };
  if (!isRecord(v)) return v;
  const numerator = typeof v.numerator === "number" ? Math.round(clamp(v.numerator, 1, 32)) : v.numerator;
  const denominator = typeof v.denominator === "number" ? nearest([2, 4, 8, 16], v.denominator) : v.denominator;
  return { numerator, denominator };
}

function nearestLoop(v: unknown): unknown {
  return typeof v === "number" && Number.isFinite(v) ? nearest(LOOP_BARS, v) : v;
}

function nearest(allowed: readonly number[], n: number): number {
  let best = allowed[0]!;
  for (const a of allowed) if (Math.abs(a - n) < Math.abs(best - n)) best = a;
  return best;
}
