"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MateEventSchema,
  StateResponseSchema,
  type ExternalCommand,
  type MateEvent,
  type StateResponse,
} from "@aibleton/protocol";
import { getState, mateUrl, postCommand } from "./mate";

export type Connection = "connecting" | "open" | "error";

export interface MateView {
  state: StateResponse | null;
  connection: Connection;
  lastError: string | null;
  send: (command: ExternalCommand) => Promise<void>;
}

const EVENT_TYPES: MateEvent["type"][] = [
  "state.changed",
  "phase.changed",
  "command.received",
  "message",
  "cancelled",
  "action.applied",
  "adapters",
  "goal.changed",
];

const RECENT_LIMIT = 50;

function applyEvent(prev: StateResponse | null, event: MateEvent): StateResponse | null {
  if (!prev) return prev;
  switch (event.type) {
    case "state.changed":
      return { ...prev, session: event.session };
    case "phase.changed":
      return { ...prev, phase: event.phase, error: event.error ?? null };
    case "command.received":
      return {
        ...prev,
        recentCommands: [event.command, ...prev.recentCommands.filter((c) => c.id !== event.command.id)].slice(
          0,
          RECENT_LIMIT,
        ),
      };
    case "message":
      return { ...prev, lastMessage: event.text };
    case "adapters":
      return { ...prev, adapters: event.status };
    case "goal.changed":
      return { ...prev, goal: event.goal };
    case "cancelled":
    case "action.applied":
      return prev;
  }
}

/**
 * Loads /state once, then follows /events over SSE. Re-renders only when an event arrives.
 * Reconnects with capped exponential backoff when the stream drops.
 */
export function useMateState(): MateView {
  const [state, setState] = useState<StateResponse | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const scheduleReconnect = () => {
      if (disposed || timer) return;
      const delay = Math.min(30_000, 1_000 * 2 ** retryRef.current);
      retryRef.current += 1;
      timer = setTimeout(() => {
        timer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed) return;
      setConnection("connecting");
      try {
        const initial = await getState();
        if (disposed) return;
        setState(initial);
        setLastError(null);
      } catch (err) {
        if (disposed) return;
        setConnection("error");
        setLastError(err instanceof Error ? err.message : String(err));
        scheduleReconnect();
        return;
      }

      source = new EventSource(mateUrl("/events"));
      source.onopen = () => {
        retryRef.current = 0;
        setConnection("open");
        setLastError(null);
      };
      source.onerror = () => {
        source?.close();
        source = null;
        setConnection("error");
        scheduleReconnect();
      };
      source.addEventListener("snapshot", (e: MessageEvent<string>) => {
        const parsed = StateResponseSchema.safeParse(JSON.parse(e.data));
        if (parsed.success) setState(parsed.data);
      });
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (e: MessageEvent<string>) => {
          const parsed = MateEventSchema.safeParse(JSON.parse(e.data));
          if (parsed.success) setState((prev) => applyEvent(prev, parsed.data));
        });
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, []);

  const send = useCallback(async (command: ExternalCommand) => {
    try {
      await postCommand(command);
      setLastError(null);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  return { state, connection, lastError, send };
}
