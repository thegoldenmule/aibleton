"use client";

import Link from "next/link";
import { useState } from "react";
import type { SessionSummary } from "@aibleton/protocol";
import { useSessions } from "../../lib/useSessions";

/** The current session is marked, not styled differently in kind — same row, one accent border. */
const ROW_CLASS: Record<"current" | "other", string> = {
  current: "flex flex-col gap-2 rounded-sm border border-accent/50 bg-panel-2 p-2.5",
  other: "flex flex-col gap-2 rounded-sm border border-line bg-panel-2 p-2.5",
};

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function SessionsPage() {
  const { sessions, currentId, loading, busy, lastError, create, resume, remove } = useSessions();
  const [name, setName] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const start = async () => {
    const trimmed = name.trim();
    try {
      await create(trimmed || undefined);
      setName("");
    } catch {
      // surfaced through useSessions.lastError
    }
  };

  const go = async (id: string) => {
    try {
      await resume(id);
    } catch {
      // surfaced through useSessions.lastError
    }
  };

  const destroy = async (id: string) => {
    setConfirmId(null);
    try {
      await remove(id);
    } catch {
      // surfaced through useSessions.lastError
    }
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-line bg-panel px-4 py-2.5">
        <span className="text-sm font-semibold tracking-tight">aibleton</span>
        <span className="text-xs text-muted">sessions</span>
        <span className="font-mono text-[10px] text-muted/70">
          {loading ? "loading…" : count(sessions.length, "session", "sessions")}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Link
            href="/templates"
            className="rounded-sm border border-line bg-panel-2 px-2.5 py-1 text-xs font-medium text-muted hover:text-foreground"
          >
            templates →
          </Link>
          <Link
            href="/bands"
            className="rounded-sm border border-line bg-panel-2 px-2.5 py-1 text-xs font-medium text-muted hover:text-foreground"
          >
            bands →
          </Link>
          <Link
            href="/"
            className="rounded-sm border border-line bg-panel-2 px-2.5 py-1 text-xs font-medium text-muted hover:text-foreground"
          >
            ← bandmate
          </Link>
        </span>
      </header>

      {lastError ? (
        <p className="rounded-sm border border-audio/40 bg-audio/10 px-3 py-1.5 font-mono text-[11px] text-audio">
          {lastError}
        </p>
      ) : null}

      <section className="flex flex-col gap-2 rounded-md border border-line bg-panel p-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted">start a session</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="session-name"
            aria-label="session name"
            value={name}
            placeholder="name — blank means the time it started"
            onChange={(e) => setName(e.target.value)}
            className="w-72 rounded-sm border border-line bg-panel-2 px-2 py-1 text-sm outline-none placeholder:text-muted/50 focus:border-accent"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void start()}
            className="rounded-sm bg-accent px-4 py-1.5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            new session
          </button>
          <span className="text-[11px] text-muted">
            the one you are in keeps everything it has — come back to it whenever
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-md border border-line bg-panel p-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted">saved sessions</h2>
        {loading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-muted">
            {lastError ? "Could not load sessions — see the error above." : "Nothing saved yet."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sessions.map((session) => (
              <Row
                key={session.id}
                session={session}
                current={session.id === currentId}
                busy={busy}
                confirming={confirmId === session.id}
                onConfirm={() => setConfirmId(session.id)}
                onCancel={() => setConfirmId(null)}
                onResume={() => void go(session.id)}
                onDelete={() => void destroy(session.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

interface RowProps {
  session: SessionSummary;
  current: boolean;
  busy: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onResume: () => void;
  onDelete: () => void;
}

function Row({ session, current, busy, confirming, onConfirm, onCancel, onResume, onDelete }: RowProps) {
  return (
    <li className={ROW_CLASS[current ? "current" : "other"]}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{session.name}</span>
        {current ? (
          <span className="rounded-sm bg-accent/20 px-1.5 py-0.5 font-mono text-[10px] text-accent">current</span>
        ) : null}
        <span className="font-mono text-[10px] text-muted/70">
          {count(session.events, "event", "events")}
          {session.songId ? " · has a song" : ""} · {new Date(session.updatedAt).toLocaleString()}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {current ? (
            <span className="text-[11px] text-muted">you are here</span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onResume}
              className="rounded-sm border border-accent-2/60 bg-panel-2 px-2 py-0.5 text-[11px] font-medium text-accent-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              resume
            </button>
          )}
          {confirming ? (
            <>
              <span className="text-[11px] text-audio">delete?</span>
              <button
                type="button"
                disabled={busy}
                onClick={onDelete}
                className="rounded-sm border border-audio/60 px-2 py-0.5 text-[11px] font-medium text-audio disabled:cursor-not-allowed disabled:opacity-40"
              >
                confirm
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-muted"
              >
                cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || current}
              onClick={onConfirm}
              title={current ? "resume another session before deleting this one" : undefined}
              className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-muted hover:text-audio disabled:cursor-not-allowed disabled:opacity-40"
            >
              delete
            </button>
          )}
        </span>
      </div>
      <p className="truncate text-xs text-muted" title={session.preview ?? undefined}>
        {session.preview ?? "nobody said anything in this one"}
      </p>
      <span className="font-mono text-[10px] text-muted/60">{session.id}</span>
    </li>
  );
}
