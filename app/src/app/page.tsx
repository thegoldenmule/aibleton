"use client";

import { ComposingState } from "../components/ComposingState";
import { EmptyState } from "../components/EmptyState";
import { SongTransport } from "../components/SongTransport";
import { SongView } from "../components/SongView";
import { WorkspacePanel } from "../components/WorkspacePanel";
import { FALLBACK_ADAPTERS } from "../lib/status";
import { useMate } from "../lib/useMate";

/** The bandmate's picture of the song it is working on. Ableton shows Ableton's. */
export default function SongPage() {
  const {
    state,
    lastError,
    activity,
    downloadProgress,
    resolveSounds,
    pickSound,
    downloadSounds,
    removeTrack,
    setPlaying,
    buildInLive,
  } = useMate();

  const daw = state?.daw ?? null;
  const song = state?.song ?? null;
  const adapters = state?.adapters ?? FALLBACK_ADAPTERS;
  // One busy signal from the server, split back out for the buttons that each mean one thing.
  // Whoever asked for the work — this tab, another one, or the bandmate itself — it shows here.
  const resolving = activity?.kind === "resolve";
  const downloading = activity?.kind === "download";
  const arranging = activity?.kind === "arrange";

  return (
    <WorkspacePanel
      title="song"
      meta={
        <div className="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-1">
          {song ? <span>{song.plan.tracks.length} tracks · composed {new Date(song.createdAt).toLocaleTimeString()}</span> : null}
          <SongTransport plan={song?.plan ?? null} transport={daw?.transport ?? null} />
        </div>
      }
    >
      {!state ? (
        <EmptyState error={lastError} />
      ) : activity?.kind === "compose" ? (
        <ComposingState activity={activity} />
      ) : song ? (
        <SongView
          key={song.id}
          song={song}
          session={daw}
          spliceStub={adapters.splice === "stub"}
          abletonStub={adapters.ableton === "stub"}
          resolving={resolving}
          downloading={downloading}
          arranging={arranging}
          downloadProgress={downloadProgress}
          onResolve={() => resolveSounds(song.id)}
          onPick={(slotId, soundUuid) => pickSound(song.id, slotId, soundUuid)}
          onDownload={() => downloadSounds(song.id)}
          onArrange={() => buildInLive(song.id)}
          onRemoveTrack={(partId) => removeTrack(song.id, partId)}
          onSetPlaying={(partId, occurrence, plays) => setPlaying(song.id, partId, occurrence, plays)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-xs text-muted">
          <p>No song yet.</p>
          <p>Tell your bandmate what you want to play and it will pick a template and a band and lay out a song.</p>
        </div>
      )}
    </WorkspacePanel>
  );
}
