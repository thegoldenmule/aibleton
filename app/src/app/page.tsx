"use client";

import { useSyncExternalStore } from "react";
import { CommandBar } from "../components/CommandBar";
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
  const { state, connection, lastError, send, compose, clearSong } = useMateState();
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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
        <section className="flex min-h-0 flex-col gap-2 rounded-md border border-line bg-panel p-3">
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
          ) : song ? (
            <SongView song={song} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-xs text-muted">
              <p>No song yet.</p>
              <p>Tell mate what you want to play and it will pick a template and a band and lay out a song.</p>
            </div>
          )}
        </section>

        <MailboxPanel commands={state?.recentCommands ?? []} lastMessage={state?.lastMessage ?? null} now={now} />
      </div>

      <CommandBar
        phase={state?.phase ?? "idle"}
        disabled={!state}
        song={state?.song ?? null}
        send={send}
        compose={compose}
        clearSong={clearSong}
      />
      {lastError && state ? (
        <p className="truncate font-mono text-[11px] text-audio" title={lastError}>
          {lastError}
        </p>
      ) : null}
    </main>
  );
}
