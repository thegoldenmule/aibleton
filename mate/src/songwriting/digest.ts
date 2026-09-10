import { keyName, parseForm, slotDownloaded } from "@aibleton/protocol";
import type { Song } from "@aibleton/protocol";

/**
 * What the brain is told about the active song. A whole `Song` is 56 KB
 * median over the songs on disk — `slot.candidates` alone is 30 KB — against a
 * ~2k-token prompt, so it can never go in a message. The digest is ~2 KB: the
 * shape of the song plus the exact identifiers the song tools take
 * (`slots[].id`, `tracks[].partId`, `sections[].occurrences`), so the model
 * never has to guess one.
 *
 * Left out on purpose: candidate arrays (read with `get_slot_candidates` when
 * they are actually needed), the brief's prose, and per-placement beat
 * arithmetic. Pure, and pinned by a size test so it cannot silently regrow.
 */

export interface SongDigestSection {
  label: string;
  /**
   * Bars in its first occurrence. Occurrences of one label may differ; `form`
   * carries the exact truth (`"a8 b8 a8 b4"`), so nothing is lost.
   */
  bars: number;
  /** Timeline indexes this section is at — the `occurrence` a placement takes. */
  occurrences: number[];
  brief: string;
  /** 0..1 from the brief, null when it said nothing. */
  intensity: number | null;
}

export interface SongDigestTrack {
  partId: string;
  name: string;
  role: string;
  brief: string;
  /** Occurrences the part plays, collapsed: `"0-2, 5"`. Anything not listed is a rest. */
  plays: string;
  /** Its track in the Live set, once arranged. */
  liveName: string | null;
}

export interface SongDigestSlot {
  id: string;
  partId: string;
  label: string;
  loopBars: number;
  /** How many candidates the search found; the list itself is a tool call away. */
  candidates: number;
  /** File name of the picked candidate, null when nothing is picked. */
  picked: string | null;
  downloaded: boolean;
}

export interface SongDigest {
  id: string;
  name: string;
  /** What the drummer asked for. */
  request: string;
  key: string;
  bpm: number;
  meter: string;
  form: string;
  sections: SongDigestSection[];
  tracks: SongDigestTrack[];
  slots: SongDigestSlot[];
  counts: {
    sections: number;
    tracks: number;
    slots: number;
    /** Slots the Splice search found something for. */
    resolved: number;
    picked: number;
    downloaded: number;
  };
}

/** `[0,1,2,5]` → `"0-2, 5"`. A dense grid over a twelve-part form is a few characters this way. */
function collapse(indexes: readonly number[]): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    runs.push(end > i ? `${sorted[i]}-${sorted[end]}` : `${sorted[i]}`);
    i = end + 1;
  }
  return runs.join(", ");
}

/** Everything the brain needs to talk about a song, and nothing that costs tokens to carry. */
export function songDigest(song: Song): SongDigest {
  const { plan } = song;
  const fileNameOf = (slotId: string, uuid: string): string | null => {
    const slot = plan.slots.find((s) => s.id === slotId)!;
    if (slot.resolved?.soundUuid === uuid) return slot.resolved.fileName;
    return slot.candidates.find((c) => c.uuid === uuid)?.fileName ?? uuid;
  };

  // Section labels in form order, first appearance wins — the same order songTracks lays scenes out in.
  const entries = parseForm(song.template.form);
  const labels: string[] = [];
  for (const entry of entries) if (!labels.includes(entry.label)) labels.push(entry.label);

  const sections: SongDigestSection[] = labels.map((label) => {
    const occurrences = plan.timeline.filter((o) => o.label === label);
    return {
      label,
      bars: occurrences[0]?.bars ?? entries.find((e) => e.label === label)!.bars,
      occurrences: occurrences.map((o) => o.index),
      brief: song.template.sections[label]?.brief ?? "",
      intensity: song.brief.sections.find((s) => s.label === label)?.intensity ?? null,
    };
  });

  const tracks: SongDigestTrack[] = plan.tracks.map((track) => ({
    partId: track.partId,
    name: track.name,
    role: track.role,
    brief: song.band.parts.find((p) => p.id === track.partId)?.brief ?? "",
    plays: collapse(plan.placements.filter((p) => p.partId === track.partId).map((p) => p.occurrence)),
    liveName: track.liveName,
  }));

  const slots: SongDigestSlot[] = plan.slots.map((slot) => ({
    id: slot.id,
    partId: slot.partId,
    label: slot.label,
    loopBars: slot.loopBars,
    candidates: slot.candidates.length,
    picked: slot.pickedUuid === null ? null : fileNameOf(slot.id, slot.pickedUuid),
    downloaded: slotDownloaded(slot),
  }));

  return {
    id: song.id,
    name: song.name,
    request: song.request.text,
    key: keyName(plan.key),
    bpm: plan.bpm,
    meter: `${plan.timeSignature.numerator}/${plan.timeSignature.denominator}`,
    form: song.template.form,
    sections,
    tracks,
    slots,
    counts: {
      sections: sections.length,
      tracks: tracks.length,
      slots: slots.length,
      resolved: slots.filter((s) => s.candidates > 0).length,
      picked: slots.filter((s) => s.picked !== null).length,
      downloaded: slots.filter((s) => s.downloaded).length,
    },
  };
}
