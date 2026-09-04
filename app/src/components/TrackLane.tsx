import type { Track } from "@aibleton/protocol";
import { ClipCell } from "./ClipCell";

const SLOT_COUNT = 8;

export function TrackLane({ track }: { track: Track }) {
  const slots = Array.from({ length: Math.max(SLOT_COUNT, track.clipSlots.length) }, (_, i) => {
    return track.clipSlots.find((s) => s.index === i) ?? { index: i, clip: null };
  });
  const isMidi = track.kind === "midi";

  return (
    <div className="grid grid-cols-[200px_1fr] gap-2 items-stretch">
      <div className="rounded-sm border border-line bg-panel-2 px-2 py-1.5 flex flex-col justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[10px] text-muted">{track.index + 1}</span>
          <span className="truncate text-sm font-medium" title={track.name}>
            {track.name}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded-sm px-1 text-[10px] font-semibold tracking-wide ${
              isMidi ? "bg-midi/20 text-midi" : "bg-audio/20 text-audio"
            }`}
          >
            {isMidi ? "MIDI" : "AUDIO"}
          </span>
          <Flag on={track.mute} label="M" onClass="bg-accent text-black" />
          <Flag on={track.solo} label="S" onClass="bg-accent-2 text-black" />
          <Flag on={track.arm} label="A" onClass="bg-audio text-black" />
          <span className="ml-auto font-mono text-[10px] text-muted" title="volume">
            {track.volume.toFixed(2)}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1 min-w-0">
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${slots.length}, minmax(64px, 1fr))` }}
        >
          {slots.map((slot) => (
            <ClipCell key={slot.index} slot={slot} kind={track.kind} />
          ))}
        </div>
        <ArrangementStrip clips={track.arrangementClips} />
      </div>
    </div>
  );
}

function Flag({ on, label, onClass }: { on: boolean; label: string; onClass: string }) {
  return (
    <span
      className={`inline-flex h-4 w-4 items-center justify-center rounded-sm text-[10px] font-bold ${
        on ? onClass : "bg-line text-muted/70"
      }`}
    >
      {label}
    </span>
  );
}

function ArrangementStrip({ clips }: { clips: Track["arrangementClips"] }) {
  if (clips.length === 0) {
    return <div className="h-3 rounded-sm border border-dashed border-line/70" title="No arrangement clips" />;
  }
  const end = Math.max(...clips.map((c) => c.endTime), 1);
  return (
    <div className="relative h-3 rounded-sm border border-line bg-panel/60 overflow-hidden" title="Arrangement">
      {clips.map((c, i) => (
        <div
          key={`${c.name}-${c.startTime}-${i}`}
          className="absolute top-0 h-full bg-accent-2/50 border-r border-background"
          style={{ left: `${(c.startTime / end) * 100}%`, width: `${Math.max(0.5, (c.length / end) * 100)}%` }}
          title={`${c.name || "(unnamed)"} · ${c.startTime}–${c.endTime}`}
        />
      ))}
    </div>
  );
}
