"use client";

import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@aibleton/protocol";
import { useSessions } from "../lib/useSessions";
import { ErrorNote } from "./ui/ErrorNote";

/**
 * Which session is open, and the only way to change it.
 *
 * A session is not a place you go — it is global state, the thing every other
 * view is a view *of* — so it sits in the header as a field showing a value you
 * can change, rather than in the rail beside the song and the libraries.
 *
 * Resuming needs no refetch of `/state`: mate emits `state.replaced`, which
 * `useMateState` folds, so the workspace follows on its own.
 */
export function SessionChip() {
  const { sessions, currentId, loading, busy, lastError, create, resume, remove } = useSessions();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // Closing is the one place the pending delete is forgotten, so a reopened
  // popover never shows a confirm the drummer did not just ask for.
  const close = () => {
    setOpen(false);
    setConfirmId(null);
  };

  // A popover has to be dismissible without choosing anything.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const current = sessions.find((s) => s.id === currentId);
  const label = loading && !current ? "loading…" : (current?.name ?? "no session");

  // Every action is surfaced through useSessions.lastError, so the catches are empty on purpose.
  const start = async () => {
    try {
      await create(name.trim() || undefined);
      setName("");
      close();
    } catch {
      /* shown in the popover */
    }
  };
  const go = async (id: string) => {
    try {
      await resume(id);
      close();
    } catch {
      /* shown in the popover */
    }
  };
  const destroy = async (id: string) => {
    setConfirmId(null);
    try {
      await remove(id);
    } catch {
      /* shown in the popover */
    }
  };

  return (
    <div ref={root} className="relative flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-muted">session</span>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : setOpen(true))}
        className="flex max-w-56 items-center gap-1.5 rounded-sm border border-line bg-panel-2 px-2 py-0.5 text-xs font-medium hover:border-accent/60"
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-[9px] text-muted">
          ▾
        </span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="sessions"
          className="absolute left-0 top-full z-50 mt-1.5 flex w-96 flex-col gap-2 rounded-md border border-line bg-panel p-2.5 shadow-lg shadow-black/40"
        >
          <ErrorNote message={lastError} />

          {loading ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : sessions.length === 0 ? (
            <p className="text-xs text-muted">
              {lastError ? "Could not load sessions — see above." : "Nothing saved yet."}
            </p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
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

          <div className="flex items-center gap-1.5 border-t border-line pt-2">
            <input
              aria-label="session name"
              value={name}
              placeholder="name — blank means the time it started"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void start();
              }}
              className="min-w-0 flex-1 rounded-sm border border-line bg-panel-2 px-2 py-1 text-xs outline-none placeholder:text-muted/50 focus:border-accent"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void start()}
              className="shrink-0 rounded-sm bg-accent px-2.5 py-1 text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              new session
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The current session is marked, not styled differently in kind — same row, one accent border. */
const ROW_CLASS: Record<"current" | "other", string> = {
  current: "flex flex-col gap-0.5 rounded-sm border border-accent/50 bg-panel-2 px-2 py-1.5",
  other: "flex flex-col gap-0.5 rounded-sm border border-line bg-panel-2 px-2 py-1.5",
};

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
      <div className="flex items-baseline gap-2">
        <span className="truncate text-xs font-medium">{session.name}</span>
        {current ? (
          <span className="shrink-0 rounded-sm bg-accent/20 px-1 py-0.5 font-mono text-[9px] text-accent">current</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {current ? (
            <span className="text-[10px] text-muted">you are here</span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onResume}
              className="rounded-sm border border-accent-2/60 px-1.5 py-0.5 text-[10px] font-medium text-accent-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              resume
            </button>
          )}
          {confirming ? (
            <>
              <span className="text-[10px] text-audio">delete?</span>
              <button
                type="button"
                disabled={busy}
                onClick={onDelete}
                className="rounded-sm border border-audio/60 px-1.5 py-0.5 text-[10px] font-medium text-audio disabled:cursor-not-allowed disabled:opacity-40"
              >
                confirm
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-muted"
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
              className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-audio disabled:cursor-not-allowed disabled:opacity-40"
            >
              delete
            </button>
          )}
        </span>
      </div>
      <p className="truncate text-[11px] text-muted" title={session.preview ?? undefined}>
        {session.preview ?? "nobody said anything in this one"}
      </p>
      <span className="font-mono text-[9px] text-muted/60">
        {session.events} {session.events === 1 ? "event" : "events"}
        {session.songId ? " · has a song" : ""} · {new Date(session.updatedAt).toLocaleString()}
      </span>
    </li>
  );
}
