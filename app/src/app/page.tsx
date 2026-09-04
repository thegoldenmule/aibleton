"use client";

import { useSyncExternalStore } from "react";
import { CommandBar } from "../components/CommandBar";
import { EmptyState } from "../components/EmptyState";
import { MailboxPanel } from "../components/MailboxPanel";
import { TrackLane } from "../components/TrackLane";
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
  const { state, connection, lastError, send } = useMateState();
  // Relative timestamps in the mailbox; ticks once a minute, not per frame.
  const now = useNow(15_000);

  const session = state?.session ?? null;

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
          <div className="flex items-baseline justify-between">
            <h2 className="text-[10px] uppercase tracking-wider text-muted">session</h2>
            {session ? (
              <span className="font-mono text-[10px] text-muted/70">
                {session.tracks.length} tracks · captured {new Date(session.capturedAt).toLocaleTimeString()}
              </span>
            ) : null}
          </div>
          {!state ? (
            <EmptyState error={lastError} />
          ) : !session ? (
            <div className="flex flex-1 items-center justify-center text-xs text-muted">
              Connected. No session snapshot yet.
            </div>
          ) : session.tracks.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-xs text-muted">No tracks in the set.</div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto">
              {session.tracks.map((track) => (
                <TrackLane key={track.index} track={track} />
              ))}
            </div>
          )}
        </section>

        <MailboxPanel commands={state?.recentCommands ?? []} lastMessage={state?.lastMessage ?? null} now={now} />
      </div>

      <CommandBar phase={state?.phase ?? "idle"} disabled={!state} send={send} />
      {lastError && state ? (
        <p className="truncate font-mono text-[11px] text-audio" title={lastError}>
          {lastError}
        </p>
      ) : null}
    </main>
  );
}
