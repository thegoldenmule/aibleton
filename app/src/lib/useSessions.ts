"use client";

import { useCallback, useEffect, useState } from "react";
import type { ResumeSessionResponse, SessionSummary } from "@aibleton/protocol";
import { createSession, deleteSession, listSessions, resumeSession } from "./sessions";
import { errorMessage } from "./errors";

export interface SessionsView {
  sessions: SessionSummary[];
  /** The session mate is in right now; "" until the first list load settles. */
  currentId: string;
  /** True until the first list load settles. */
  loading: boolean;
  /** True while a create/resume/delete request is in flight. */
  busy: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  create: (name?: string) => Promise<ResumeSessionResponse>;
  resume: (id: string) => Promise<ResumeSessionResponse>;
  remove: (id: string) => Promise<boolean>;
}

/**
 * Holds the session library plus the start/resume/delete actions.
 *
 * There are no SSE events for the *list*, so this is plain fetch + local state,
 * refetched after every switch and delete. The switch itself needs no refetch of
 * `/state`: mate emits `state.replaced`, which `useMateState` folds, so the home
 * page follows along on its own — in this tab and in every other one.
 */
export function useSessions(): SessionsView {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // Every setState lands after the first await, so the initial load can be kicked
  // off from an effect without a synchronous cascading render.
  const refresh = useCallback(async () => {
    try {
      const next = await listSessions();
      setSessions(next.sessions);
      setCurrentId(next.currentId);
      setLastError(null);
    } catch (err) {
      setLastError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load. Mirrors useTemplates: the async work lives in the effect and
  // stops touching state once the hook is torn down.
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const next = await listSessions();
        if (disposed) return;
        setSessions(next.sessions);
        setCurrentId(next.currentId);
        setLastError(null);
      } catch (err) {
        if (!disposed) setLastError(errorMessage(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);

  const create = useCallback(
    async (name?: string) => {
      setBusy(true);
      try {
        const started = await createSession(name === undefined ? {} : { name });
        setLastError(null);
        await refresh();
        return started;
      } catch (err) {
        setLastError(errorMessage(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const resume = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const switched = await resumeSession(id);
        setLastError(null);
        await refresh();
        return switched;
      } catch (err) {
        setLastError(errorMessage(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const deleted = await deleteSession(id);
        setLastError(null);
        await refresh();
        return deleted;
      } catch (err) {
        setLastError(errorMessage(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { sessions, currentId, loading, busy, lastError, refresh, create, resume, remove };
}
