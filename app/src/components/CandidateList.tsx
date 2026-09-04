import { keyName, type SampleSlot, type SongTrack, type SpliceCandidate } from "@aibleton/protocol";
import { roleClass } from "./BandRoster";

interface Props {
  slot: SampleSlot;
  track: SongTrack | null;
  busy: boolean;
  onPick: (soundUuid: string) => void;
}

function keyLabel(key: SpliceCandidate["key"]): string {
  if (!key) return "—";
  return key.mode ? `${key.root} ${key.mode}` : key.root;
}

/**
 * One slot's Splice candidates, best first. Preview is a link to the sound's
 * page on splice.com: mate never plays audio, and Splice's search results
 * carry none. "use" changes which candidate the slot downloads.
 */
export function CandidateList({ slot, track, busy, onPick }: Props) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 rounded-sm border border-line bg-panel-2 p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-xs font-medium">{slot.id}</span>
        {track ? <span className={`rounded-sm border px-1 font-mono text-[9px] ${roleClass(track.role)}`}>{track.role}</span> : null}
        <span className="font-mono text-[10px] text-muted">
          wants {slot.loopBars} bar{slot.loopBars === 1 ? "" : "s"} · {slot.bpm.target} bpm ({slot.bpm.min}–{slot.bpm.max}) · {keyName(slot.key)}
        </span>
      </div>
      {slot.candidates.length === 0 ? (
        <p className="text-xs text-muted">no candidates yet — find sounds first</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {slot.candidates.map((c) => {
            const picked = c.uuid === slot.pickedUuid;
            const onDisk = slot.resolved?.soundUuid === c.uuid && slot.resolved.localPath !== null;
            return (
              <li key={c.uuid} className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-sm border px-2 py-1 ${picked ? "border-accent/60 bg-accent/10" : "border-line bg-panel"}`}>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={c.fileName}>
                  {c.fileName}
                </span>
                <span className="font-mono text-[10px] text-muted">
                  {c.bpm ?? "?"} bpm · {keyLabel(c.key)} · {c.bars ?? "?"} bars · {c.pack || "—"} · score {c.score}
                </span>
                {onDisk ? <span className="font-mono text-[10px] text-accent-2">✓ on disk</span> : null}
                {c.url ? (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-muted hover:text-foreground"
                    title="Open on splice.com to listen"
                  >
                    preview ↗
                  </a>
                ) : null}
                <button
                  type="button"
                  disabled={busy || picked}
                  onClick={() => onPick(c.uuid)}
                  className="rounded-sm border border-accent/60 px-2 py-0.5 text-[11px] font-medium text-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {picked ? "picked" : "use"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
