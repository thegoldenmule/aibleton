"use client";

import type { ReactNode } from "react";
import { MateProvider, useMate } from "../lib/useMate";
import { useNow } from "../lib/useNow";
import { FALLBACK_ADAPTERS } from "../lib/status";
import { AppHeader } from "./AppHeader";
import { ConversationPane } from "./ConversationPane";
import { MailboxPanel } from "./MailboxPanel";
import { NavRail } from "./NavRail";

/**
 * The instrument the app is played on: a header, the workspace column, and the
 * bandmate beside it.
 *
 * Only the workspace changes as you navigate — it is the router's `children`.
 * The header, the conversation and the mailbox are rendered here, above the
 * route, and an app-router layout is not re-rendered on navigation, so they keep
 * their state: one EventSource for the tab's whole life, the conversation's
 * scroll position, the mailbox's filters. That is what lets the drummer ask the
 * bandmate for a template while looking at the template library.
 *
 * The document never scrolls (see `<body>` in app/layout.tsx). This owns the one
 * `<main>` and the one grid; each column is a fixed-height flex box with exactly
 * one scrollable child of its own.
 *
 * Below `lg` that inverts: the three columns stack, and a third of the viewport
 * each with no page scroll would strand every one of them, so the grid itself
 * becomes the scroller and the rows take their natural height.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <MateProvider>
      <Shell>{children}</Shell>
    </MateProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { state, connection, lastError, activity, queued, send, clearSong } = useMate();
  // Relative timestamps in the mailbox; ticks once a minute, not per frame.
  const now = useNow(15_000);

  const song = state?.song ?? null;

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <AppHeader adapters={state?.adapters ?? FALLBACK_ADAPTERS} connection={connection} />

      <div className="flex min-h-0 flex-1 gap-3">
        <NavRail />

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 max-lg:auto-rows-auto max-lg:overflow-y-auto lg:auto-rows-[minmax(0,1fr)] lg:grid-cols-[1fr_360px_320px]">
          {children}

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
            goal={state?.goal ?? null}
            error={state?.error ?? null}
            now={now}
            answersOnly={state?.phase === "paused"}
            disabled={!state}
            setAnswersOnly={(answersOnly) => void send({ type: answersOnly ? "pause" : "resume" })}
          />
        </div>
      </div>

      {lastError && state ? (
        <p className="truncate font-mono text-[11px] text-audio" title={lastError}>
          {lastError}
        </p>
      ) : null}
    </main>
  );
}
