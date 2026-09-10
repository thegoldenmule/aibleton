"use client";

import { useSyncExternalStore } from "react";
import type { Activity } from "@aibleton/protocol";
import { ConversationPane } from "../components/ConversationPane";
import { EmptyState } from "../components/EmptyState";
import { MailboxPanel } from "../components/MailboxPanel";
import { SongView } from "../components/SongView";
import { TransportBar } from "../components/TransportBar";
import { useMateState } from "../lib/useMateState";

/** Coarse wall clock for relative timestamps; 0 on the server so SSR and hydration agree. */
function useNow(intervalMs: number): number {
  return useSyncExternalStore(
    (onChange) => {
      const t = setInterval(onChange, intervalMs);
      return () => clearInterval(t);
    },
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    () => 0,
  );
}

const FALLBACK_ADAPTERS = { ableton: "stub", splice: "stub", brain: "scripted" } as const;

export default function Home() {
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
  } = useMateState();
  // Relative timestamps in the mailbox; ticks once a minute, not per frame.
  const now = useNow(15_000);

  const session = state?.session ?? null;
  const song = state?.song ?? null;
  // One busy signal from the server, split back out for the buttons that each mean one thing.
  // Whoever asked for the work — this tab, another one, or the bandmate itself — it shows here.
  const resolving = activity?.kind === "resolve";
  const downloading = activity?.kind === "download";
  const arranging = activity?.kind === "arrange";

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <TransportBar
        transport={session?.transport ?? null}
        phase={state?.phase ?? "idle"}
        error={state?.error ?? null}
        adapters={state?.adapters ?? FALLBACK_ADAPTERS}
        connection={connection}
        goal={state?.goal ?? null}
      />

      <div className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-1 gap-3 lg:grid-cols-[1fr_360px_320px]">
        <section className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-md border border-line bg-panel p-3">
          {/* The bandmate's picture of the session: the active song. Ableton shows Ableton's. */}
          <div className="flex items-baseline justify-between">
            <h2 className="text-[10px] uppercase tracking-wider text-muted">session</h2>
            {song ? (
              <span className="font-mono text-[10px] text-muted/70">
                {song.plan.tracks.length} tracks · composed {new Date(song.createdAt).toLocaleTimeString()}
              </span>
            ) : null}
          </div>
          {!state ? (
            <EmptyState error={lastError} />
          ) : activity?.kind === "compose" ? (
            <ComposingState activity={activity} />
          ) : song ? (
            <SongView
              key={song.id}
              song={song}
              session={session}
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
        </section>

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

/**
 * The session column while a song is being composed: the lanes it will fill,
 * pulsing, under where the compose has got to. Only the step it is on — the
 * conversation pane keeps the full trail of what the bandmate decided.
 */
function ComposingState({ activity }: { activity: Activity }) {
  const fraction = activity.fraction ?? 0.05;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" role="status" aria-live="polite">
      <div className="flex flex-col gap-2 rounded-sm border border-line bg-panel-2 p-2.5">
        <div className="h-1 overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
        <p className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
          <span className="w-16 shrink-0 uppercase tracking-wider text-muted/70">{activity.kind}</span>
          <span className="truncate text-foreground" title={activity.message}>
            {activity.message}
          </span>
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid animate-pulse grid-cols-[200px_1fr] gap-2" style={{ animationDelay: `${i * 120}ms` }}>
            <div className="h-12 rounded-sm border border-line bg-panel-2" />
            <div className="h-12 rounded-sm border border-dashed border-line/70" />
          </div>
        ))}
      </div>
      <p className="text-center text-xs text-muted">Composing… then Splice is searched for every slot.</p>
    </div>
  );
}
