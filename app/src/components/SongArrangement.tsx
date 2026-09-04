import { useState } from "react";
import { slotDownloaded, type Placement, type SampleSlot, type Song } from "@aibleton/protocol";
import { letterClass } from "./FormStrip";
import { roleClass } from "./BandRoster";
import { shortName } from "../lib/format";

/** Narrowest an occurrence column may get, so a 1-bar section still shows its letter. */
const MIN_COL_PX = 72;
const PX_PER_BAR = 14;
const HEADER_PX = 200;

/**
 * The song as it will be arranged: one column per form occurrence (the same
 * blocks as the roadmap above), one row per track, and in each cell the
 * sample slot for that part x section looped as many times as it takes to
 * fill the occurrence — a 4-bar guitar loop shows twice under an 8-bar `a`,
 * an 8-bar bass loop once. A clip shows the sound picked for its slot;
 * clicking it selects the slot (every clip of that slot lights up) so the
 * candidates can be shown below, and "preview" opens the pick on splice.com.
 * Scrolls horizontally on its own; vertical scroll belongs to the session
 * column so there is one scrollbar for the page.
 */
export function SongArrangement({
  song,
  selectedSlotId,
  onSelect,
  busy,
  onRemoveTrack,
}: {
  song: Song;
  selectedSlotId: string | null;
  onSelect: (slotId: string | null) => void;
  busy: boolean;
  /** Drops a part and all its clips, e.g. the drums when the drummer is the one playing. */
  onRemoveTrack: (partId: string) => void;
}) {
  const { plan } = song;
  const [confirmPartId, setConfirmPartId] = useState<string | null>(null);
  const canRemove = plan.tracks.length > 1;
  const slotById = new Map(plan.slots.map((s) => [s.id, s]));
  const byTrack = new Map<string, Map<number, Placement>>();
  for (const p of plan.placements) {
    let row = byTrack.get(p.partId);
    if (!row) byTrack.set(p.partId, (row = new Map()));
    row.set(p.occurrence, p);
  }

  const colStyle = (bars: number) => ({ flexGrow: bars, flexBasis: 0, minWidth: Math.max(MIN_COL_PX, bars * PX_PER_BAR) });

  return (
    <div className="shrink-0 overflow-x-auto">
      <div className="flex min-w-max flex-col gap-1.5">
        {/* Header: the form, aligned with the columns below. */}
        <div className="grid gap-2" style={{ gridTemplateColumns: `${HEADER_PX}px 1fr` }}>
          <div className="flex items-end px-2 text-[10px] uppercase tracking-wider text-muted">bar</div>
          <div className="flex gap-1">
            {plan.timeline.map((occ) => (
              <div
                key={occ.index}
                className={`flex h-9 items-center justify-between rounded-sm border px-2 ${letterClass(occ.label)}`}
                style={colStyle(occ.bars)}
                title={`${occ.label} · ${occ.bars} bars · starts at bar ${occ.startBar + 1}`}
              >
                <span className="font-mono text-sm font-semibold leading-none">{occ.label}</span>
                <span className="font-mono text-[10px] leading-none opacity-70">
                  {occ.startBar + 1}–{occ.startBar + occ.bars}
                </span>
              </div>
            ))}
          </div>
        </div>

        {plan.tracks.map((track) => {
          const row = byTrack.get(track.partId);
          return (
            <div key={track.partId} className="grid gap-2" style={{ gridTemplateColumns: `${HEADER_PX}px 1fr` }}>
              <div className="flex flex-col justify-between rounded-sm border border-line bg-panel-2 px-2 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-mono text-[10px] text-muted">{track.index + 1}</span>
                  <span className="truncate text-sm font-medium" title={track.name}>
                    {track.name}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`rounded-sm border px-1 text-[10px] font-semibold ${roleClass(track.role)}`}>{track.role}</span>
                  <span className="rounded-sm bg-audio/20 px-1 text-[10px] font-semibold tracking-wide text-audio">AUDIO</span>
                  <span className="ml-auto flex items-center gap-1">
                    {confirmPartId === track.partId ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirmPartId(null);
                            onRemoveTrack(track.partId);
                          }}
                          className="rounded-sm border border-audio/60 px-1.5 text-[10px] font-medium text-audio disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          remove
                        </button>
                        <button type="button" onClick={() => setConfirmPartId(null)} className="rounded-sm border border-line px-1.5 text-[10px] text-muted">
                          keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || !canRemove}
                        onClick={() => setConfirmPartId(track.partId)}
                        className="rounded-sm border border-line px-1.5 text-[10px] text-muted hover:border-audio/60 hover:text-audio disabled:cursor-not-allowed disabled:opacity-40"
                        title={canRemove ? "Remove this track and all its clips from the song" : "A song needs at least one track"}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </div>
              </div>
              <div className="flex gap-1">
                {plan.timeline.map((occ) => {
                  const placement = row?.get(occ.index);
                  const slot = placement ? slotById.get(placement.slotId) : undefined;
                  return (
                    <div key={occ.index} className="flex gap-px" style={colStyle(occ.bars)}>
                      {placement && slot ? (
                        Array.from({ length: placement.repeats }, (_, i) => (
                          <Clip
                            key={i}
                            slot={slot}
                            placement={placement}
                            repeat={i}
                            label={occ.label}
                            selected={slot.id === selectedSlotId}
                            onSelect={() => onSelect(slot.id === selectedSlotId ? null : slot.id)}
                          />
                        ))
                      ) : (
                        <div className="h-14 flex-1 rounded-sm border border-dashed border-line/70" title="rests" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Clip({
  slot,
  placement,
  repeat,
  label,
  selected,
  onSelect,
}: {
  slot: SampleSlot;
  placement: Placement;
  repeat: number;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const first = repeat === 0;
  const pick = slot.candidates.find((c) => c.uuid === slot.pickedUuid) ?? null;
  const previewUrl = first && pick && pick.url ? pick.url : null;
  const onDisk = slotDownloaded(slot);
  const title = [
    slot.id,
    pick ? pick.fileName : "no pick yet",
    `${placement.loopBars}-bar loop, ${repeat + 1} of ${placement.repeats}`,
    slot.query,
  ].join("\n");
  return (
    <div
      className={`relative flex h-14 min-w-0 flex-1 overflow-hidden rounded-sm border ${letterClass(label)}${onDisk ? " border-b-4 border-b-accent-2" : ""}${selected ? " ring-1 ring-accent" : ""}`}
      title={onDisk ? `${title}\non disk: ${slot.resolved?.localPath ?? ""}` : title}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 cursor-pointer flex-col justify-between px-1.5 py-1 text-left"
      >
        <span className={`w-full truncate text-[11px] font-medium leading-tight${previewUrl ? " pr-14" : ""}`}>
          {first ? (pick ? shortName(pick.fileName) : slot.id) : "↻"}
        </span>
        <span className="font-mono text-[10px] opacity-80">
          {placement.loopBars} bar{placement.loopBars === 1 ? "" : "s"}
          {placement.repeats > 1 ? ` · ${repeat + 1}/${placement.repeats}` : ""}
          {onDisk ? " · ✓" : slot.pickedUuid ? " · ○" : " · ?"}
        </span>
      </button>
      {onDisk && first ? (
        <span className="absolute bottom-1 right-1 rounded-sm bg-accent-2 px-1 text-[9px] font-semibold leading-tight text-black" title="Downloaded from Splice">
          ✓ on disk
        </span>
      ) : null}
      {previewUrl ? (
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-1 top-1 rounded-sm border border-current/40 bg-panel/70 px-1 text-[10px] leading-tight opacity-80 hover:opacity-100"
          title="Open on splice.com to listen"
        >
          preview ↗
        </a>
      ) : null}
    </div>
  );
}
