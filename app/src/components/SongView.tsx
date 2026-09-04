import { useState } from "react";
import { dawStatus, formTotalBars, keyName, parseForm, pendingDownloadUuids, slotDownloaded, type DownloadProgress, type SessionState, type Song } from "@aibleton/protocol";
import { shortName } from "../lib/format";
import { CandidateList } from "./CandidateList";
import { FormStrip } from "./FormStrip";
import { SongArrangement } from "./SongArrangement";

interface Props {
  song: Song;
  /** Ableton's picture of the set, for what of the song is in Live already. */
  session: SessionState | null;
  /** True when mate's Splice port is the fixture stub: downloads write placeholder files and spend nothing. */
  spliceStub: boolean;
  /** True when mate's Ableton port is the in-memory stub: "Live" is a pretend set. */
  abletonStub: boolean;
  resolving: boolean;
  downloading: boolean;
  arranging: boolean;
  downloadProgress: DownloadProgress | null;
  onResolve: () => Promise<void>;
  onPick: (slotId: string, soundUuid: string) => Promise<void>;
  onDownload: () => Promise<void>;
  onArrange: () => Promise<void>;
  onRemoveTrack: (partId: string) => Promise<void>;
}

/**
 * The active song as the session mate intends to build: the brief in a row of
 * chips, the form as a roadmap, then the arrangement — every track laid out
 * along the form with its looped clips in each occurrence. Clicking a clip
 * opens that slot's Splice candidates below. This is mate's state, not Ableton's.
 */
export function SongView({ song, session, spliceStub, abletonStub, resolving, downloading, arranging, downloadProgress, onResolve, onPick, onDownload, onArrange, onRemoveTrack }: Props) {
  const { brief, plan } = song;
  const totalBars = formTotalBars(parseForm(song.template.form));
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [confirmDownload, setConfirmDownload] = useState(false);

  const credits = pendingDownloadUuids(plan).length;
  const hasCandidates = plan.slots.some((s) => s.candidates.length > 0);
  const picked = plan.slots.filter((s) => s.pickedUuid !== null).length;
  const onDisk = plan.slots.filter(slotDownloaded).length;
  const busy = resolving || downloading || arranging;
  const daw = dawStatus(song, session);
  const tracksInLive = daw.tracks.filter((t) => t.index !== null).length;
  const slotsInLive = daw.slots.filter((s) => s.state === "in-live").length;
  const placed = daw.placements.filter((p) => p.placed).length;
  const liveDone = daw.steps.length === 0;
  const selected = plan.slots.find((s) => s.id === selectedSlotId) ?? null;
  const selectedTrack = selected ? plan.tracks.find((t) => t.partId === selected.partId) ?? null : null;

  const swallow = (p: Promise<void>) => p.catch(() => undefined);
  const progress = downloading && downloadProgress?.songId === song.id ? downloadProgress : null;
  const progressText = progress
    ? progress.current
      ? `getting ${progress.done + progress.failed + 1} of ${progress.total} · ${shortName(progress.current.fileName)}`
      : `${progress.done} of ${progress.total} done${progress.failed ? `, ${progress.failed} failed` : ""}`
    : null;

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
                title={
                  !hasCandidates
                    ? "Find sounds first"
                    : credits === 0
                      ? "Every pick is already on disk"
                      : "Download every picked sound. One Splice credit per new sound."
                }
              >
                {downloading ? "getting…" : `get sounds (${credits} credit${credits === 1 ? "" : "s"})`}
              </button>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted">
          <span className="uppercase tracking-wider text-muted/70">live</span>
          <span title="Tracks mate created in the set, named with a [mate] suffix">
            {tracksInLive}/{plan.tracks.length} tracks
          </span>
          <span title="Session clips holding a downloaded sound">
            {slotsInLive}/{plan.slots.length} clips
          </span>
          <span title="Copies laid along the arrangement">
            {placed}/{daw.placements.length} placed
          </span>
          {daw.notes.length ? (
            <span className="truncate text-audio" title={daw.notes.join("\n")}>
              {daw.notes[0]}
              {daw.notes.length > 1 ? ` (+${daw.notes.length - 1})` : ""}
            </span>
          ) : null}
          <button
            type="button"
            disabled={busy || onDisk === 0 || (liveDone && session !== null)}
            onClick={() => void swallow(onArrange())}
            className="ml-auto rounded-sm border border-accent-2/60 bg-panel-2 px-2.5 py-1 text-xs font-medium text-accent-2 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              onDisk === 0
                ? "Get sounds first: only downloaded sounds go into Live"
                : liveDone && session !== null
                  ? "Everything on disk is in Live"
                  : "Create the song's tracks in Live and put every downloaded sound in place. Adds only; never touches your own tracks."
            }
          >
            {arranging ? "building…" : liveDone && session !== null && slotsInLive > 0 ? "in Live ✓" : "build in Live"}
          </button>
          {abletonStub ? <span className="text-muted/70">ableton stub: a pretend set</span> : null}
        </div>
        {downloading ? (
          <div className="flex items-center gap-2 font-mono text-[10px] text-muted" role="status" aria-live="polite">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            <span className="truncate">{progressText ?? "asking Splice…"}</span>
            {progress?.lastError ? (
              <span className="truncate text-audio" title={progress.lastError}>
                failed: {progress.lastError}
              </span>
            ) : null}
          </div>
        ) : null}
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

      <SongArrangement
        song={song}
        daw={daw}
        selectedSlotId={selectedSlotId}
        onSelect={setSelectedSlotId}
        busy={busy}
        resolving={resolving}
        onRemoveTrack={(partId) => swallow(onRemoveTrack(partId))}
      />

      {selected ? (
        <CandidateList slot={selected} track={selectedTrack} busy={busy} onPick={(uuid) => swallow(onPick(selected.id, uuid))} />
      ) : null}

      <p className="shrink-0 text-[10px] text-muted/70">
        {plan.slots.length} sample slots · {picked} picked · {onDisk} on disk · {slotsInLive} in Live · “?” no pick yet, “○” picked, “✓” on disk, “▶” in Live · click a clip to choose its sound
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
