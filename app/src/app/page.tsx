"use client";

import { ComposingState } from "../components/ComposingState";
import { ConversationPane } from "../components/ConversationPane";
import { EmptyState } from "../components/EmptyState";
import { MailboxPanel } from "../components/MailboxPanel";
import { SongView } from "../components/SongView";
import { TransportBar } from "../components/TransportBar";
import { WorkspacePanel } from "../components/WorkspacePanel";
import { MateProvider, useMate } from "../lib/useMate";
import { useNow } from "../lib/useNow";

const FALLBACK_ADAPTERS = { ableton: "stub", splice: "stub", brain: "scripted" } as const;

export default function Page() {
  return (
    <MateProvider>
      <Home />
    </MateProvider>
  );
}

function Home() {
  const {
    state,
    connection,
    lastError,
    activity,
    queued,
    downloadProgress,
    send,
    clearSong,
    resolveSounds,
    pickSound,
    downloadSounds,
    removeTrack,
    setPlaying,
    buildInLive,
  } = useMate();
  // Relative timestamps in the mailbox; ticks once a minute, not per frame.
  const now = useNow(15_000);

  const daw = state?.daw ?? null;
  const song = state?.song ?? null;
  // One busy signal from the server, split back out for the buttons that each mean one thing.
  // Whoever asked for the work — this tab, another one, or the bandmate itself — it shows here.
  const resolving = activity?.kind === "resolve";
  const downloading = activity?.kind === "download";
  const arranging = activity?.kind === "arrange";

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <TransportBar
        transport={daw?.transport ?? null}
        phase={state?.phase ?? "idle"}
        error={state?.error ?? null}
        adapters={state?.adapters ?? FALLBACK_ADAPTERS}
        connection={connection}
        goal={state?.goal ?? null}
      />

      <div className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-1 gap-3 lg:grid-cols-[1fr_360px_320px]">
        {/* The bandmate's picture of the song it is working on. Ableton shows Ableton's. */}
        <WorkspacePanel
          title="song"
          meta={song ? `${song.plan.tracks.length} tracks · composed ${new Date(song.createdAt).toLocaleTimeString()}` : undefined}
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
              spliceStub={(state.adapters ?? FALLBACK_ADAPTERS).splice === "stub"}
              abletonStub={(state.adapters ?? FALLBACK_ADAPTERS).ableton === "stub"}
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

        <ConversationPane
          phase={state?.phase ?? "idle"}
          disabled={!state}
          song={song}
          transcript={state?.transcript ?? []}
          activity={activity}
          queued={queued}
          now={now}
          send={send}
          clearSong={clearSong}
        />

        <MailboxPanel
          commands={state?.recentCommands ?? []}
          phase={state?.phase ?? "idle"}
          activity={activity}
          queued={state?.queued ?? []}
          now={now}
          answersOnly={state?.phase === "paused"}
          disabled={!state}
          setAnswersOnly={(answersOnly) => void send({ type: answersOnly ? "pause" : "resume" })}
        />
      </div>
      {lastError && state ? (
        <p className="truncate font-mono text-[11px] text-audio" title={lastError}>
          {lastError}
        </p>
      ) : null}
    </main>
  );
}
