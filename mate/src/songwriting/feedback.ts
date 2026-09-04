import { BandSchema, MAX_ADDED_PARTS, TemplateSchema, formLabels, parseForm, stringifyForm } from "@aibleton/protocol";
import type { Band, BandPart, Section, SongBrief, Template } from "@aibleton/protocol";
import { partId } from "../core/band-generator.ts";

/**
 * Apply the brief's feedback to the template and band. Deterministic and
 * tolerant: unknown ids and labels are ignored, a form that would break the
 * template is dropped, and a band is never emptied. The results are
 * re-validated against the protocol schemas; failing that is a bug here,
 * not bad model output, so it throws.
 */
export function applyFeedback(template: Template, band: Band, brief: SongBrief): { template: Template; band: Band } {
  const revisedTemplate = TemplateSchema.parse(reviseTemplate(template, brief));
  const revisedBand = BandSchema.parse(reviseBand(band, brief));
  return { template: revisedTemplate, band: revisedBand };
}

function reviseTemplate(template: Template, brief: SongBrief): Template {
  const sections: Record<string, Section> = {};
  for (const [label, section] of Object.entries(template.sections)) sections[label] = { ...section };

  for (const note of brief.sections) {
    const section = sections[note.label];
    if (!section) continue;
    if (note.brief && note.brief.trim()) section.brief = note.brief.trim();
    if (note.intensity !== null) section.intensity = note.intensity;
  }

  const form = acceptableForm(brief.templateFeedback.form, Object.keys(sections)) ?? template.form;
  return { ...template, form, sections };
}

/** A revised form is kept only if it parses and uses labels the template already defines. */
function acceptableForm(form: string | null, labels: readonly string[]): string | null {
  if (!form || !form.trim()) return null;
  let entries;
  try {
    entries = parseForm(form);
  } catch {
    return null;
  }
  const known = new Set(labels);
  if (!formLabels(entries).every((label) => known.has(label))) return null;
  return stringifyForm(entries);
}

function reviseBand(band: Band, brief: SongBrief): Band {
  const notes = new Map(brief.parts.map((p) => [p.partId, p]));
  const kept: BandPart[] = [];
  for (const part of band.parts) {
    const note = notes.get(part.id);
    if (note && !note.keep) continue;
    const revised: BandPart = { ...part };
    if (note?.brief && note.brief.trim()) revised.brief = note.brief.trim();
    kept.push(revised);
  }
  // A band with no players is not a band; keep the original line-up rather than none.
  const parts = kept.length > 0 ? kept : band.parts.map((p) => ({ ...p }));

  const taken = new Set(parts.map((p) => p.id));
  for (const added of brief.bandFeedback.addParts.slice(0, MAX_ADDED_PARTS)) {
    const role = added.role.trim();
    const name = added.name.trim();
    const briefText = added.brief.trim();
    if (!role || !name || !briefText) continue;
    parts.push({ id: partId(role, name, taken), role, name, brief: briefText });
  }

  return { ...band, parts };
}
