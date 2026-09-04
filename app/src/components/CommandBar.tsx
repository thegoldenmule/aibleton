"use client";

import { useState, type FormEvent } from "react";
import type { ExternalCommand, Phase, Song } from "@aibleton/protocol";

interface Props {
  phase: Phase;
  disabled: boolean;
  /** The active song, or null. With no song the bar composes; with one it talks to the bandmate. */
  song: Song | null;
  send: (command: ExternalCommand) => Promise<void>;
  compose: (text: string) => Promise<void>;
  clearSong: () => Promise<void>;
}

export function CommandBar({ phase, disabled, song, send, compose, clearSong }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);

  const fire = async (command: ExternalCommand) => {
    setBusy(true);
    try {
      await send(command);
    } catch {
      // surfaced through useMateState.lastError
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (song) {
      await fire({ type: "userRequest", text: trimmed });
      setText("");
      return;
    }
    // No song yet: this request composes one. Slow — it waits on the model.
    setComposing(true);
    try {
      await compose(trimmed);
      setText("");
    } catch {
      // surfaced through useMateState.lastError; keep the text so they can retry
    } finally {
      setComposing(false);
    }
  };

  const newSong = async () => {
    setBusy(true);
    try {
      await clearSong();
    } catch {
      // surfaced through useMateState.lastError
    } finally {
      setBusy(false);
    }
  };

  const locked = disabled || busy || composing;

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel px-3 py-2">
      <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${song ? "bg-accent-2/20 text-accent-2" : "bg-accent/20 text-accent"}`}>
        {song ? "bandmate" : "compose"}
      </span>
      <input
        className="min-w-[240px] flex-1 rounded-sm border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/70 focus:border-accent"
        placeholder={
          song
            ? "Tell your bandmate something… e.g. “give me a 4-bar rock groove at 110”"
            : "What do you want to play? e.g. “something funky and upbeat”"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={locked}
      />
      <button type="submit" disabled={locked || !text.trim()} className={btn("bg-accent text-black")}>
        {composing ? "composing…" : song ? "send" : "compose"}
      </button>
      <span className="mx-1 h-5 w-px bg-line" />
      {song ? (
        <button type="button" disabled={locked} onClick={newSong} className={btn()} title="Clear the active song and compose another">
          new song
        </button>
      ) : null}
      {phase === "paused" ? (
        <button type="button" disabled={locked} onClick={() => fire({ type: "resume" })} className={btn()}>
          resume
        </button>
      ) : (
        <button type="button" disabled={locked} onClick={() => fire({ type: "pause" })} className={btn()}>
          pause
        </button>
      )}
      <button
        type="button"
        disabled={locked || (phase !== "deciding" && phase !== "acting")}
        onClick={() => fire({ type: "cancel" })}
        className={btn()}
      >
        cancel
      </button>
      <button type="button" disabled={locked} onClick={() => fire({ type: "abletonChanged" })} className={btn()}>
        refresh
      </button>
    </form>
  );
}

function btn(extra = "border border-line bg-panel-2"): string {
  return `rounded-sm px-2.5 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${extra}`;
}
