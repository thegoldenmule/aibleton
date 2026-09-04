import { LOOP_BARS, SongPlanSchema, beatsPerBar, keyName, parseForm, sampleSlotId } from "@aibleton/protocol";
import type { Band, BandPart, LoopBars, Placement, SampleSlot, SongBrief, SongOccurrence, SongPlan, SongTrack, Template } from "@aibleton/protocol";
import { songLineup } from "./lineup.ts";

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

/** A fresh, unresolved sample slot for a part in a section: its Splice query composed from the briefs. */
export function buildSlot(template: Template, brief: SongBrief, part: BandPart, label: string): SampleSlot {
  const note = brief.parts.find((p) => p.partId === part.id);
  const section = template.sections[label];
  const sectionNote = brief.sections.find((s) => s.label === label);
  const tags = distinct([...(note?.soundHints ?? []), ...(sectionNote?.descriptors ?? []), ...brief.genres, ...brief.descriptors]);
  return {
    id: sampleSlotId(part.id, label),
    partId: part.id,
    label,
    query: distinct([part.brief, section?.brief, ...tags, keyName(brief.key)]).join(", "),
    bpm: brief.bpm,
    key: brief.key,
    tags,
    loopBars: note?.loopBars ?? DEFAULT_LOOP_BARS,
    resolved: null,
    candidates: [],
    pickedUuid: null,
  };
}

/** The placement of a slot over one occurrence: the loop fitted to the bars and repeated to fill them. */
export function buildPlacement(slot: SampleSlot, occurrence: SongOccurrence): Placement {
  const loopBars = fitLoop(occurrence.bars, slot.loopBars);
  return {
    partId: slot.partId,
    label: occurrence.label,
    occurrence: occurrence.index,
    slotId: slot.id,
    startBar: occurrence.startBar,
    bars: occurrence.bars,
    loopBars,
    repeats: occurrence.bars / loopBars,
    startBeat: occurrence.startBeat,
    lengthBeats: occurrence.lengthBeats,
  };
}

/**
 * Lay a briefed template and band out as a DAW plan: one track per part, the
 * form as a timeline, and for each occurrence a placement per part that
 * plays in it (`songLineup`), looping the part's sample slot for that
 * section label to fill the occurrence's bars. A slot exists only for a
 * part x label that is played somewhere; the rest is silence. Pure; the
 * same inputs always yield the same plan.
 */
export function layoutSong(template: Template, band: Band, brief: SongBrief): SongPlan {
  const timeSignature = brief.timeSignature;
  const bpb = beatsPerBar(timeSignature);

  const tracks: SongTrack[] = band.parts.map((part, index) => ({
    index,
    partId: part.id,
    name: part.name,
    role: part.role,
    kind: "audio",
    liveName: null,
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
  const slotById = new Map<string, SampleSlot>();
  const placements: Placement[] = [];
  const lineup = songLineup(template, band, brief);

  for (const part of band.parts) {
    for (const occurrence of timeline) {
      if (!lineup[occurrence.index]!.has(part.id)) continue;
      const id = sampleSlotId(part.id, occurrence.label);
      let slot = slotById.get(id);
      if (!slot) {
        slot = buildSlot(template, brief, part, occurrence.label);
        slotById.set(id, slot);
        slots.push(slot);
      }
      placements.push(buildPlacement(slot, occurrence));
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
