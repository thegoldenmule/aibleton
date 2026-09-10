"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MateEventSchema,
  StateResponseSchema,
  type Activity,
  type CommandSummary,
  type DownloadProgress,
  type ExternalCommand,
  type MateEvent,
  type Song,
  type StateResponse,
} from "@aibleton/protocol";
import { getState, mateUrl, postCommand } from "./mate";
import { arrangeSong, clearActiveSong, deleteTrack, downloadSong, pickSlot, resolveSong, setPlacement } from "./songs";

export type Connection = "connecting" | "open" | "error";

export interface MateView {
  state: StateResponse | null;
  connection: Connection;
  /**
   * Transport only: the request never reached mate, or an action it ran came back failed.
   * Anything the bandmate has an opinion about arrives as its spoken reply in the transcript.
   */
  lastError: string | null;
  /**
   * The one slow thing mate is doing, or null at rest. Owned by the server, so a reload
   * mid-compose still shows it, and so does a second tab.
   */
  activity: Activity | null;
  /** Requests that arrived while mate was working and are waiting their turn, oldest first. */
  queued: CommandSummary[];
  /** Where the current download stands, from mate's progress events; null when none is running. */
  downloadProgress: DownloadProgress | null;
  send: (command: ExternalCommand) => Promise<void>;
  /** Clears the active song so the next request composes a new one. */
  clearSong: () => Promise<void>;
  /** Searches Splice for every slot of a song. */
  resolveSounds: (songId: string) => Promise<void>;
  /** Chooses which candidate a slot downloads. */
  pickSound: (songId: string, slotId: string, soundUuid: string) => Promise<void>;
  /** Downloads every pending pick. The caller confirms the credit spend first. */
  downloadSounds: (songId: string) => Promise<void>;
  /** Drops a part and everything it plays from the song. */
  removeTrack: (songId: string, partId: string) => Promise<void>;
  /** Brings a part in for one occurrence, or rests it. */
  setPlaying: (songId: string, partId: string, occurrence: number, plays: boolean) => Promise<void>;
  /** Builds what the song has on disk into Live. Adds only; safe to repeat. */
  buildInLive: (songId: string) => Promise<void>;
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
  "song.changed",
  "transcript.appended",
  "download.progress",
  "activity.changed",
  "queue.changed",
];

const RECENT_LIMIT = 50;

function applyEvent(prev: StateResponse | null, event: MateEvent): StateResponse | null {
  if (!prev) return prev;
  switch (event.type) {
    case "state.changed":
      return { ...prev, daw: event.daw };
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
    case "song.changed":
      return { ...prev, song: event.song };
    case "transcript.appended":
      return prev.transcript.some((t) => t.id === event.entry.id) ? prev : { ...prev, transcript: [...prev.transcript, event.entry] };
    case "activity.changed":
      return { ...prev, activity: event.activity };
    case "queue.changed":
      return { ...prev, queued: event.queued };
    case "cancelled":
    case "action.applied":
    case "download.progress":
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
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
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
          if (!parsed.success) return;
          if (parsed.data.type === "download.progress") setDownloadProgress(parsed.data.progress);
          else {
            // A failed action is the one domain failure with no voice of its own; the rest of what
            // went wrong reaches the drummer as the bandmate's reply in the transcript.
            if (parsed.data.type === "action.applied" && !parsed.data.ok) setLastError(`${parsed.data.action}: ${parsed.data.detail ?? "failed"}`);
            if (parsed.data.type === "activity.changed" && parsed.data.activity === null) setDownloadProgress(null);
            setState((prev) => applyEvent(prev, parsed.data));
          }
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

  /** Replaces the active song from a response; the SSE event normally lands first, this covers a dropped stream. */
  const replaceSong = useCallback((song: Song) => {
    setState((prev) => (prev && (prev.song === null || prev.song.id === song.id) ? { ...prev, song } : prev));
  }, []);

  const resolveSounds = useCallback(
    async (songId: string) => {
      try {
        replaceSong((await resolveSong(songId)).song);
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [replaceSong],
  );

  const pickSound = useCallback(
    async (songId: string, slotId: string, soundUuid: string) => {
      try {
        replaceSong(await pickSlot(songId, { slotId, soundUuid }));
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [replaceSong],
  );

  const downloadSounds = useCallback(
    async (songId: string) => {
      try {
        const { song, failed } = await downloadSong(songId);
        replaceSong(song);
        // Partial failure is a 200 and mate says so in its own words; only name the ones that cost nothing.
        setLastError(failed.length ? `${failed.length} download${failed.length === 1 ? "" : "s"} failed` : null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setDownloadProgress(null);
      }
    },
    [replaceSong],
  );

  const clearSong = useCallback(async () => {
    try {
      await clearActiveSong();
      setState((prev) => (prev ? { ...prev, song: null } : prev));
      setLastError(null);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  const removeTrack = useCallback(
    async (songId: string, partId: string) => {
      try {
        replaceSong(await deleteTrack(songId, partId));
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [replaceSong],
  );

  const setPlaying = useCallback(
    async (songId: string, partId: string, occurrence: number, plays: boolean) => {
      try {
        replaceSong(await setPlacement(songId, { partId, occurrence, plays }));
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [replaceSong],
  );

  const buildInLive = useCallback(
    async (songId: string) => {
      try {
        // What was built, what Live could not do and what is still missing all come back as
        // mate's own line in the conversation; the page only reports a request that never landed.
        replaceSong((await arrangeSong(songId)).song);
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [replaceSong],
  );

  return {
    state,
    connection,
    lastError,
    activity: state?.activity ?? null,
    queued: state?.queued ?? [],
    downloadProgress,
    send,
    clearSong,
    resolveSounds,
    pickSound,
    downloadSounds,
    removeTrack,
    setPlaying,
    buildInLive,
  };
}
