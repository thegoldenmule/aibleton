import { LOOP_BARS, SongPlanSchema, beatsPerBar, keyName, parseForm, sampleSlotId } from "@aibleton/protocol";
import type { Band, LoopBars, Placement, SampleSlot, SongBrief, SongOccurrence, SongPlan, SongTrack, Template } from "@aibleton/protocol";

/** Loop length used for a part the brief says nothing about. */
export const DEFAULT_LOOP_BARS: LoopBars = 4;

/**
 * The longest allowed loop that divides `bars` evenly without exceeding
 * `preferred`. An 8-bar section with a 4-bar preference loops 4 twice; a
 * 6-bar section with the same preference falls to 2 three times; a 5-bar
 * section can only take 1-bar loops.
 */
export function fitLoop(bars: number, preferred: LoopBars): LoopBars {
  let fit: LoopBars = 1;
  for (const candidate of LOOP_BARS) {
    if (candidate > preferred) break;
    if (bars % candidate === 0) fit = candidate;
  }
  return fit;
}

/** Deduplicated, trimmed, non-empty words in first-seen order. */
function distinct(words: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const w = word?.trim();
    if (!w) continue;
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * Lay a briefed template and band out as a DAW plan: one track per part, the
 * form as a timeline, one sample slot per part x section label, and a
 * placement per part x occurrence that loops the slot's sample to fill the
 * occurrence's bars. Pure; the same inputs always yield the same plan.
 */
export function layoutSong(template: Template, band: Band, brief: SongBrief): SongPlan {
  const timeSignature = brief.timeSignature;
  const bpb = beatsPerBar(timeSignature);
  const partNotes = new Map(brief.parts.map((p) => [p.partId, p]));
  const sectionNotes = new Map(brief.sections.map((s) => [s.label, s]));
  const key = keyName(brief.key);

  const tracks: SongTrack[] = band.parts.map((part, index) => ({
    index,
    partId: part.id,
    name: part.name,
    role: part.role,
    kind: "audio",
  }));

  const timeline: SongOccurrence[] = [];
  let startBar = 0;
  parseForm(template.form).forEach((entry, index) => {
    timeline.push({
      index,
      label: entry.label,
      bars: entry.bars,
      startBar,
      startBeat: startBar * bpb,
      lengthBeats: entry.bars * bpb,
    });
    startBar += entry.bars;
  });

  const slots: SampleSlot[] = [];
  const slotIds = new Set<string>();
  const placements: Placement[] = [];

  for (const part of band.parts) {
    const note = partNotes.get(part.id);
    const preferred = note?.loopBars ?? DEFAULT_LOOP_BARS;
    for (const occurrence of timeline) {
      const id = sampleSlotId(part.id, occurrence.label);
      if (!slotIds.has(id)) {
        slotIds.add(id);
        const section = template.sections[occurrence.label];
        const sectionNote = sectionNotes.get(occurrence.label);
        const tags = distinct([...(note?.soundHints ?? []), ...(sectionNote?.descriptors ?? []), ...brief.genres, ...brief.descriptors]);
        slots.push({
          id,
          partId: part.id,
          label: occurrence.label,
          query: distinct([part.brief, section?.brief, ...tags, key]).join(", "),
          bpm: brief.bpm,
          key: brief.key,
          tags,
          loopBars: preferred,
          resolved: null,
        });
      }
      const loopBars = fitLoop(occurrence.bars, preferred);
      placements.push({
        partId: part.id,
        label: occurrence.label,
        occurrence: occurrence.index,
        slotId: id,
        startBar: occurrence.startBar,
        bars: occurrence.bars,
        loopBars,
        repeats: occurrence.bars / loopBars,
        startBeat: occurrence.startBeat,
        lengthBeats: occurrence.lengthBeats,
      });
    }
  }

  return SongPlanSchema.parse({
    bpm: brief.bpm.target,
    key: brief.key,
    timeSignature,
    tracks,
    timeline,
    slots,
    placements,
  });
}
