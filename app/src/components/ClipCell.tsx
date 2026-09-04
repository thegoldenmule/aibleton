import type { ClipSlot } from "@aibleton/protocol";

export function ClipCell({ slot, kind }: { slot: ClipSlot; kind: "midi" | "audio" }) {
  const clip = slot.clip;
  if (!clip) {
    return (
      <div
        className="h-12 rounded-sm border border-line bg-panel/60 text-[10px] text-muted/60 flex items-end justify-end px-1 pb-0.5"
        title={`Slot ${slot.index + 1}: empty`}
      >
        {slot.index + 1}
      </div>
    );
  }
  const tone = kind === "midi" ? "border-midi/60 bg-midi/15 text-midi" : "border-audio/60 bg-audio/15 text-audio";
  return (
    <div
      className={`h-12 rounded-sm border px-1.5 py-1 flex flex-col justify-between overflow-hidden ${tone} ${
        clip.isPlaying ? "ring-1 ring-accent" : ""
      }`}
      title={`${clip.name || "(unnamed)"} · ${clip.length} beats`}
    >
      <span className="truncate text-[11px] font-medium leading-tight">{clip.name || "(unnamed)"}</span>
      <span className="font-mono text-[10px] opacity-80">
        {formatBeats(clip.length)}
        {clip.isPlaying ? " ▶" : ""}
      </span>
    </div>
  );
}

function formatBeats(beats: number): string {
  return Number.isInteger(beats) ? `${beats} b` : `${beats.toFixed(2)} b`;
}
