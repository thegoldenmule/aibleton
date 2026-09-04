import { useState } from "react";
import { formTotalBars, keyName, parseForm, pendingDownloadUuids, slotDownloaded, type Song } from "@aibleton/protocol";
import { CandidateList } from "./CandidateList";
import { FormStrip } from "./FormStrip";
import { SlotGrid } from "./SlotGrid";
import { SongArrangement } from "./SongArrangement";

interface Props {
  song: Song;
  /** True when mate's Splice port is the fixture stub: downloads write placeholder files and spend nothing. */
  spliceStub: boolean;
  resolving: boolean;
  downloading: boolean;
  onResolve: () => Promise<void>;
  onPick: (slotId: string, soundUuid: string) => Promise<void>;
  onDownload: () => Promise<void>;
}

/**
 * The active song as the session mate intends to build: the brief in a row of
 * chips, the form as a roadmap, then the arrangement — every track laid out
 * along the form with its looped clips in each occurrence — and the sample
 * slots with their Splice candidates. This is mate's state, not Ableton's.
 */
export function SongView({ song, spliceStub, resolving, downloading, onResolve, onPick, onDownload }: Props) {
  const { brief, plan } = song;
  const totalBars = formTotalBars(parseForm(song.template.form));
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [confirmDownload, setConfirmDownload] = useState(false);

  const credits = pendingDownloadUuids(plan).length;
  const hasCandidates = plan.slots.some((s) => s.candidates.length > 0);
  const picked = plan.slots.filter((s) => s.pickedUuid !== null).length;
  const onDisk = plan.slots.filter(slotDownloaded).length;
  const busy = resolving || downloading;
  const selected = plan.slots.find((s) => s.id === selectedSlotId) ?? null;
  const selectedTrack = selected ? plan.tracks.find((t) => t.partId === selected.partId) ?? null : null;

  const swallow = (p: Promise<void>) => p.catch(() => undefined);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex shrink-0 flex-col gap-2 rounded-sm border border-line bg-panel-2 p-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-sm font-semibold">{song.name}</h3>
          <span className="min-w-0 truncate text-xs text-muted" title={song.request.text}>
            “{song.request.text}”
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void swallow(onResolve())}
              className="rounded-sm border border-accent-2/60 bg-panel-2 px-2.5 py-1 text-xs font-medium text-accent-2 disabled:cursor-not-allowed disabled:opacity-40"
              title="Search Splice for every slot. Free."
            >
              {resolving ? "finding…" : hasCandidates ? "find again" : "find sounds"}
            </button>
            {confirmDownload ? (
              <>
                <span className="text-[11px] text-audio">
                  spend {credits} credit{credits === 1 ? "" : "s"}?
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmDownload(false);
                    void swallow(onDownload());
                  }}
                  className="rounded-sm border border-audio/60 px-2 py-0.5 text-[11px] font-medium text-audio disabled:cursor-not-allowed disabled:opacity-40"
                >
                  confirm
                </button>
                <button type="button" onClick={() => setConfirmDownload(false)} className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-muted">
                  cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy || !hasCandidates || credits === 0}
                onClick={() => setConfirmDownload(true)}
                className="rounded-sm bg-accent px-2.5 py-1 text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
                title={credits === 0 ? "Every pick is already on disk" : "Download every picked sound. One Splice credit per new sound."}
              >
                {downloading ? "getting…" : `get sounds (${credits} credit${credits === 1 ? "" : "s"})`}
              </button>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone="accent">{plan.bpm} bpm</Chip>
          <Chip tone="accent-2">{keyName(plan.key)}</Chip>
          <Chip>
            {plan.timeSignature.numerator}/{plan.timeSignature.denominator}
          </Chip>
          <Chip>{totalBars} bars</Chip>
          {brief.genres.map((genre) => (
            <Chip key={`g-${genre}`} tone="midi">
              {genre}
            </Chip>
          ))}
          {brief.descriptors.map((word) => (
            <Chip key={`d-${word}`}>{word}</Chip>
          ))}
          {brief.swing !== null ? <Chip>swing {Math.round(brief.swing * 100)}%</Chip> : null}
        </div>
        <FormStrip form={song.template.form} sections={song.template.sections} showLegend={false} />
        <p className="text-[11px] text-muted">
          <span className="text-foreground/80">{song.template.name}</span> × <span className="text-foreground/80">{song.band.name}</span>
          {brief.templateFeedback.notes || brief.bandFeedback.notes ? (
            <span title={[brief.templateFeedback.notes, brief.bandFeedback.notes].filter(Boolean).join("\n")}> · notes</span>
          ) : null}
          {spliceStub ? <span className="font-mono text-[10px] text-muted/70"> · splice stub: placeholder files, no credits spent</span> : null}
        </p>
      </div>

      <SongArrangement song={song} />

      <SlotGrid song={song} selectedId={selectedSlotId} onSelect={setSelectedSlotId} />

      {selected ? (
        <CandidateList slot={selected} track={selectedTrack} busy={busy} onPick={(uuid) => swallow(onPick(selected.id, uuid))} />
      ) : null}

      <p className="shrink-0 text-[10px] text-muted/70">
        {plan.slots.length} sample slots · {picked} picked · {onDisk} on disk · “?” no pick yet, “○” picked, “✓” on disk · nothing sent to Ableton yet
      </p>
    </div>
  );
}

/** Full class strings only — Tailwind cannot see interpolated names. */
const CHIP_CLASS: Record<string, string> = {
  accent: "border-accent/60 bg-accent/15 text-accent",
  "accent-2": "border-accent-2/60 bg-accent-2/15 text-accent-2",
  midi: "border-midi/60 bg-midi/15 text-midi",
  plain: "border-line bg-panel text-muted",
};

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: keyof typeof CHIP_CLASS }) {
  return <span className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${CHIP_CLASS[tone]}`}>{children}</span>;
}
