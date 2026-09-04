import { formLabels, parseForm, sampleSlotId, slotDownloaded, type SampleSlot, type Song } from "@aibleton/protocol";
import { roleClass } from "./BandRoster";
import { letterClass } from "./FormStrip";

interface Props {
  song: Song;
  selectedId: string | null;
  onSelect: (slotId: string | null) => void;
}

/** Full class strings only — Tailwind cannot see interpolated names. */
const CELL_CLASS = {
  empty: "border-dashed border-line/70 text-muted/60",
  candidates: "border-line bg-panel-2 text-foreground",
  downloaded: "border-accent-2/60 bg-accent-2/15 text-accent-2",
} as const;

function cellState(slot: SampleSlot): keyof typeof CELL_CLASS {
  if (slotDownloaded(slot)) return "downloaded";
  return slot.candidates.length > 0 ? "candidates" : "empty";
}

/** Short form of a Splice file name: no extension, underscores as spaces. */
export function shortName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/_/g, " ");
}

/**
 * One cell per sample slot: a track row per band part, a column per section
 * label. The arrangement above shows *when* a slot plays; this shows *what*
 * is picked for it and lets the user open one slot's candidates.
 */
export function SlotGrid({ song, selectedId, onSelect }: Props) {
  const { plan } = song;
  const labels = formLabels(parseForm(song.template.form));
  const slotById = new Map(plan.slots.map((s) => [s.id, s]));

  return (
    <div className="shrink-0 overflow-x-auto">
      <div className="grid gap-1" style={{ gridTemplateColumns: `200px repeat(${labels.length}, minmax(112px, 1fr))` }}>
        <div className="text-[10px] uppercase tracking-wider text-muted">sounds</div>
        {labels.map((label) => (
          <div key={label} className={`rounded-sm border px-1.5 py-0.5 text-center font-mono text-[10px] ${letterClass(label)}`}>
            {label}
          </div>
        ))}
        {plan.tracks.map((track) => (
          <SlotRow key={track.partId} track={track} labels={labels} slotById={slotById} selectedId={selectedId} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function SlotRow({
  track,
  labels,
  slotById,
  selectedId,
  onSelect,
}: {
  track: Song["plan"]["tracks"][number];
  labels: string[];
  slotById: Map<string, SampleSlot>;
  selectedId: string | null;
  onSelect: (slotId: string | null) => void;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5 rounded-sm border border-line bg-panel-2 px-2 py-1">
        <span className="truncate text-xs font-medium">{track.name}</span>
        <span className={`rounded-sm border px-1 font-mono text-[9px] ${roleClass(track.role)}`}>{track.role}</span>
      </div>
      {labels.map((label) => {
        const slot = slotById.get(sampleSlotId(track.partId, label));
        if (!slot) return <div key={label} className="rounded-sm border border-dashed border-line/40" />;
        const pick = slot.candidates.find((c) => c.uuid === slot.pickedUuid) ?? null;
        const state = cellState(slot);
        const selected = slot.id === selectedId;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onSelect(selected ? null : slot.id)}
            className={`flex min-w-0 flex-col items-start gap-0.5 rounded-sm border px-1.5 py-1 text-left ${CELL_CLASS[state]}${selected ? " ring-1 ring-accent" : ""}`}
            title={pick ? `${slot.id}\n${pick.fileName}` : `${slot.id}\nno candidates yet`}
          >
            <span className="w-full truncate text-[11px] leading-tight">{pick ? shortName(pick.fileName) : "no candidates"}</span>
            <span className="font-mono text-[10px] opacity-80">
              {state === "downloaded" ? "✓" : pick ? "○" : "?"} · {slot.candidates.length} found
              {pick?.bpm ? ` · ${pick.bpm}` : ""}
              {pick?.key ? ` · ${pick.key.root}${pick.key.mode === null ? "" : pick.key.mode === "major" ? "" : "m"}` : ""}
            </span>
          </button>
        );
      })}
    </>
  );
}
