import { keyName, parseForm } from "@aibleton/protocol";
import type { Band, SongBrief, SongPlan, Template, TranscriptField } from "@aibleton/protocol";

/**
 * The words a compose says about itself. Everything here is structured — the
 * picks, the brief, the edits, the plan — so it stays label-and-value all the
 * way to the conversation pane instead of being flattened into a sentence.
 * Pure and synchronous; `composeSong` calls these and hands the result to
 * `onProgress`.
 */

/** Section letters read better upper-case in the pane than the lower-case the form is stored in. */
export function formLine(form: string): string {
  return form.toUpperCase();
}

const field = (label: string, value: string): TranscriptField => ({ label, value });

/** Keeps a value to one readable line in a narrow pane. */
function clip(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Intensity is optional on a section; say so rather than printing undefined. */
function intensity(value: number | undefined): string {
  return value === undefined ? "unset" : `${value}`;
}

/** What the deterministic picks landed on, before the model has seen anything. */
export function pickedFields(template: Template, band: Band): TranscriptField[] {
  const entries = parseForm(template.form);
  const bars = entries.reduce((sum, e) => sum + e.bars, 0);
  const labels = Object.keys(template.sections).sort();
  return [
    field("form", `${template.name} — ${formLine(template.form)}`),
    field("length", `${entries.length} sections, ${bars} bars`),
    ...labels.map((l) => field(`section ${l.toUpperCase()}`, clip(template.sections[l]!.brief))),
    field("band", band.name),
    field("parts", band.parts.map((p) => `${p.name} (${p.role})`).join(", ")),
  ];
}

/** What the slow call is actually asking for, so the wait is legible. */
export function askFields(template: Template, band: Band): TranscriptField[] {
  return [
    field("about", `“${template.name}” played by “${band.name}”`),
    field("for", "key, tempo, meter, feel, and the sound of every part"),
    field("notes on", "the form, the line-up, and who plays in each section"),
  ];
}

/** What the model decided: the numbers every Splice search runs on, then its words. */
export function briefFields(brief: SongBrief): TranscriptField[] {
  const { min, max, target } = brief.bpm;
  const fields = [
    field("summary", brief.summary),
    field("key", keyName(brief.key)),
    field("tempo", `${target} bpm (${min}–${max})`),
    field("meter", `${brief.timeSignature.numerator}/${brief.timeSignature.denominator}${brief.swing ? ` · swing ${Math.round(brief.swing * 100)}%` : ""}`),
  ];
  if (brief.genres.length > 0) fields.push(field("genres", brief.genres.join(", ")));
  if (brief.descriptors.length > 0) fields.push(field("feel", brief.descriptors.join(", ")));
  const notes = [brief.templateFeedback.notes, brief.bandFeedback.notes].map((n) => n.trim()).filter(Boolean);
  if (notes.length > 0) fields.push(field("notes", clip(notes.join(" · "), 90)));
  return fields;
}

/**
 * What the brief's notes changed about the picked form and band, one line per
 * change. Empty when the model left both alone — the caller says so instead.
 */
export function editFields(before: Template, band: Band, after: Template, revised: Band): TranscriptField[] {
  const fields: TranscriptField[] = [];
  if (after.form !== before.form) fields.push(field("form", `${formLine(before.form)} → ${formLine(after.form)}`));
  for (const [label, section] of Object.entries(after.sections)) {
    const was = before.sections[label];
    if (!was) continue;
    const changes: string[] = [];
    if (was.intensity !== section.intensity) changes.push(`intensity ${intensity(was.intensity)} → ${intensity(section.intensity)}`);
    if (was.brief !== section.brief) changes.push(`“${clip(section.brief)}”`);
    if (changes.length > 0) fields.push(field(`section ${label.toUpperCase()}`, changes.join(" · ")));
  }
  const had = new Map(band.parts.map((p) => [p.id, p]));
  const kept = new Set(revised.parts.map((p) => p.id));
  const dropped = band.parts.filter((p) => !kept.has(p.id));
  const added = revised.parts.filter((p) => !had.has(p.id));
  const rewritten = revised.parts.filter((p) => had.get(p.id) !== undefined && had.get(p.id)!.brief !== p.brief);
  if (dropped.length > 0) fields.push(field("dropped", dropped.map((p) => `${p.name} (${p.role})`).join(", ")));
  if (added.length > 0) fields.push(field("added", added.map((p) => `${p.name} (${p.role})`).join(", ")));
  for (const part of rewritten) fields.push(field(part.name, `“${clip(part.brief)}”`));
  return fields;
}

/** The plan as counts, plus who sits out — the interesting half of a line-up. */
export function layoutFields(plan: SongPlan): TranscriptField[] {
  const playing = new Set(plan.placements.map((p) => `${p.partId}@${p.occurrence}`));
  const rests = plan.tracks
    .map((track) => ({ name: track.name, n: plan.timeline.filter((o) => !playing.has(`${track.partId}@${o.index}`)).length }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  return [
    field("tracks", `${plan.tracks.length}`),
    field("samples", `${plan.slots.length} slots, ${plan.placements.length} clips`),
    field("timeline", `${plan.timeline.length} sections at ${plan.bpm} bpm`),
    field("resting", rests.length === 0 ? "nobody — everyone plays throughout" : rests.map((r) => `${r.name} ${r.n}/${plan.timeline.length}`).join(" · ")),
  ];
}

/** The facts under the bandmate's closing reply: what it built, in one glance. */
export function songFields(template: Template, band: Band, brief: SongBrief, plan: SongPlan): TranscriptField[] {
  return [
    field("key", `${keyName(brief.key)} · ${brief.bpm.target} bpm · ${brief.timeSignature.numerator}/${brief.timeSignature.denominator}`),
    field("form", formLine(template.form)),
    field("band", `${band.name} — ${band.parts.length} parts`),
    field("plan", `${plan.tracks.length} tracks · ${plan.slots.length} sample slots · ${plan.timeline.length} sections`),
  ];
}
