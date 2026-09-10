"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import type { ExternalCommand, Phase, Song, TranscriptEntry, TranscriptField } from "@aibleton/protocol";

interface Props {
  phase: Phase;
  disabled: boolean;
  /** The active song, or null. With no song the pane composes; with one it talks to the bandmate. */
  song: Song | null;
  transcript: TranscriptEntry[];
  /** True while this page's compose request is waiting on the model. */
  composing: boolean;
  now: number;
  send: (command: ExternalCommand) => Promise<void>;
  compose: (text: string) => Promise<void>;
  clearSong: () => Promise<void>;
}

/** Full class strings only — Tailwind cannot see interpolated names. Steps are not bubbles; see StepLine. */
const KIND_CLASS: Record<Exclude<TranscriptEntry["kind"], "step">, string> = {
  compose: "border-accent/50 bg-accent/10",
  request: "border-accent-2/50 bg-accent-2/10",
  reply: "border-line bg-panel-2",
};

/**
 * The conversation with the bandmate: history on top, what it is doing in the
 * middle, the input at the bottom. Composes a song while none is active and
 * talks to the bandmate once one is.
 */
export function ConversationPane({ phase, disabled, song, transcript, composing, now, send, compose, clearSong }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // The loop's brain is at work while deciding; acting means actions are being applied.
  const thinking = composing || phase === "deciding";
  const working = thinking || phase === "acting";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [transcript.length, working]);

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
    try {
      await compose(trimmed);
      setText("");
    } catch {
      // surfaced through useMateState.lastError; keep the text so they can retry
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
    <section className="flex min-h-0 flex-col rounded-md border border-line bg-panel">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="text-[10px] uppercase tracking-wider text-muted">conversation</h2>
        <span
          className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
            song ? "bg-accent-2/20 text-accent-2" : "bg-accent/20 text-accent"
          }`}
        >
          {song ? "bandmate" : "compose"}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
        {transcript.length === 0 && !working ? (
          <p className="m-auto max-w-[220px] text-center text-xs text-muted">
            {song ? "Tell your bandmate what to change." : "Say what you want to play and mate will lay out a song."}
          </p>
        ) : null}
        {transcript.map((entry, i) =>
          entry.kind === "step" ? (
            <StepLine key={entry.id} text={entry.text} fields={entry.fields} live={composing && i === transcript.length - 1} />
          ) : (
            <div
              key={entry.id}
              className={`flex max-w-[92%] flex-col gap-0.5 rounded-sm border px-2 py-1.5 ${KIND_CLASS[entry.kind]} ${
                entry.role === "user" ? "self-end" : "self-start"
              }`}
            >
              <span className="flex items-baseline justify-between gap-3 text-[10px] text-muted">
                <span className="font-mono">{entry.role === "user" ? (entry.kind === "compose" ? "you · compose" : "you") : "bandmate"}</span>
                <span className="font-mono text-muted/70">{relative(entry.at, now)}</span>
              </span>
              <span className="whitespace-pre-wrap text-sm leading-snug">{entry.text}</span>
              {entry.fields.length > 0 ? (
                <div className="mt-1 border-t border-line/70 pt-1">
                  <Fields fields={entry.fields} />
                </div>
              ) : null}
            </div>
          ),
        )}
        {working ? (
          <div className="flex items-center gap-2 self-start rounded-sm border border-dashed border-line px-2 py-1.5 text-xs text-muted" role="status">
            <span className="flex gap-0.5" aria-hidden>
              <Dot delay="0ms" />
              <Dot delay="150ms" />
              <Dot delay="300ms" />
            </span>
            {composing ? "bandmate is composing a song…" : phase === "deciding" ? "bandmate is thinking…" : "bandmate is applying changes…"}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-2 border-t border-line px-3 py-2">
        <div className="flex items-stretch gap-2">
          <textarea
            rows={2}
            className="min-w-0 flex-1 resize-none rounded-sm border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/70 focus:border-accent"
            placeholder={song ? "e.g. “give me a 4-bar rock groove at 110”" : "e.g. “something funky and upbeat”"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            disabled={locked}
          />
          <button type="submit" disabled={locked || !text.trim()} className={btn("h-full bg-accent text-black")}>
            {composing ? "composing…" : "send"}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
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
        </div>
      </form>
    </section>
  );
}

/**
 * Labelled facts as a two-column list: the label column sizes to the longest
 * label so the values line up, and long values wrap under their own label.
 */
function Fields({ fields }: { fields: TranscriptField[] }) {
  if (fields.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 font-mono text-[11px] leading-snug">
      {fields.map((field, i) => (
        <Fragment key={`${field.label}-${i}`}>
          <dt className="whitespace-nowrap text-muted/70">{field.label}</dt>
          <dd className="min-w-0 break-words text-foreground/90">{field.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * One step of a compose: a headline for what mate did, then the facts behind
 * it. Not a bubble — the trail sits under the request that started it, and
 * reads as history once the song is done.
 */
function StepLine({ text, fields, live }: { text: string; fields: TranscriptField[]; live: boolean }) {
  return (
    <div className="flex w-full max-w-[92%] flex-col gap-0.5 self-start pl-1">
      <p className={`flex items-baseline gap-1.5 font-mono text-[11px] leading-snug ${live ? "text-foreground" : "text-muted"}`}>
        <span className={`h-1 w-1 shrink-0 translate-y-[-2px] rounded-full ${live ? "animate-pulse bg-accent" : "bg-line"}`} aria-hidden />
        <span>{text}</span>
      </p>
      <div className="pl-3.5">
        <Fields fields={fields} />
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: delay }} />;
}

function btn(extra = "border border-line bg-panel-2"): string {
  return `rounded-sm px-2.5 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${extra}`;
}

function relative(at: number, now: number): string {
  if (now === 0) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
