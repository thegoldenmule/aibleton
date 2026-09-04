"use client";

import { useState, type FormEvent } from "react";
import type { ExternalCommand, Phase } from "@aibleton/protocol";

interface Props {
  phase: Phase;
  disabled: boolean;
  send: (command: ExternalCommand) => Promise<void>;
}

export function CommandBar({ phase, disabled, send }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

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
    await fire({ type: "userRequest", text: trimmed });
    setText("");
  };

  const locked = disabled || busy;

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel px-3 py-2">
      <input
        className="min-w-[240px] flex-1 rounded-sm border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/70 focus:border-accent"
        placeholder="Tell your bandmate something… e.g. “give me a 4-bar rock groove at 110”"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={locked}
      />
      <button type="submit" disabled={locked || !text.trim()} className={btn("bg-accent text-black")}>
        send
      </button>
      <span className="mx-1 h-5 w-px bg-line" />
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
