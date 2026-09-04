"use client";

import { useSyncExternalStore } from "react";
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
  const { state, connection, lastError, composing, resolving, downloading, send, compose, clearSong, resolveSounds, pickSound, downloadSounds } = useMateState();
  // Relative timestamps in the mailbox; ticks once a minute, not per frame.
  const now = useNow(15_000);

  const session = state?.session ?? null;
  const song = state?.song ?? null;

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
          {/* Mate's picture of the session: the active song. Ableton shows Ableton's. */}
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
          ) : composing ? (
            <ComposingState />
          ) : song ? (
            <SongView
              key={song.id}
              song={song}
              spliceStub={(state.adapters ?? FALLBACK_ADAPTERS).splice === "stub"}
              resolving={resolving}
              downloading={downloading}
              onResolve={() => resolveSounds(song.id)}
              onPick={(slotId, soundUuid) => pickSound(song.id, slotId, soundUuid)}
              onDownload={() => downloadSounds(song.id)}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-xs text-muted">
              <p>No song yet.</p>
              <p>Tell mate what you want to play and it will pick a template and a band and lay out a song.</p>
            </div>
          )}
        </section>

        <ConversationPane
          phase={state?.phase ?? "idle"}
          disabled={!state}
          song={song}
          transcript={state?.transcript ?? []}
          composing={composing}
          now={now}
          send={send}
          compose={compose}
          clearSong={clearSong}
        />

        <MailboxPanel commands={state?.recentCommands ?? []} lastMessage={state?.lastMessage ?? null} now={now} />
      </div>
      {lastError && state ? (
        <p className="truncate font-mono text-[11px] text-audio" title={lastError}>
          {lastError}
        </p>
      ) : null}
    </main>
  );
}

/** The session column while a song is being composed: the lanes it will fill, pulsing. */
function ComposingState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" role="status" aria-live="polite">
      <div className="h-24 animate-pulse rounded-sm border border-line bg-panel-2" />
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid animate-pulse grid-cols-[200px_1fr] gap-2" style={{ animationDelay: `${i * 120}ms` }}>
            <div className="h-12 rounded-sm border border-line bg-panel-2" />
            <div className="h-12 rounded-sm border border-dashed border-line/70" />
          </div>
        ))}
      </div>
      <p className="text-center text-xs text-muted">Composing… picking a template and a band, then asking the model for a brief.</p>
    </div>
  );
}
