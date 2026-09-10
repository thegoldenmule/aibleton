"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import type { Activity, CommandSummary, ExternalCommand, Phase, Song, TranscriptEntry, TranscriptField } from "@aibleton/protocol";
import { ACTIVITY_LABEL } from "../lib/status";

interface Props {
  phase: Phase;
  disabled: boolean;
  /** The active song, or null. Only changes what the pane says; every message goes the same way. */
  song: Song | null;
  transcript: TranscriptEntry[];
  /** The one slow thing mate is doing, from the server, or null at rest. */
  activity: Activity | null;
  /** What arrived while mate was working and is waiting its turn, oldest first. */
  queued: CommandSummary[];
  now: number;
  send: (command: ExternalCommand) => Promise<void>;
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
 * middle, the input at the bottom. Every message is the same command — the
 * bandmate decides whether that means writing a song or changing one — so the
 * box stays live while it works and a second message queues behind the first.
 */
export function ConversationPane({ phase, disabled, song, transcript, activity, queued, now, send, clearSong }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const working = activity !== null || phase === "deciding" || phase === "acting";
  // Waiting messages are already in the transcript — `recordCommand` writes them the moment they
  // arrive, before the machine parks them — so they are marked in place rather than listed twice.
  const waiting = new Set(queued.map((c) => `${c.at}|${c.summary}`));

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [transcript.length, working]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    // The box empties on send and only refills if the POST itself failed, which now means the
    // message never reached mate — not that something it asked for went wrong a minute later.
    setText("");
    try {
      await send({ type: "userRequest", text: trimmed });
    } catch {
      setText(trimmed);
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

  return (
    <section className="flex min-h-0 flex-col rounded-md border border-line bg-panel">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="text-[10px] uppercase tracking-wider text-muted">conversation</h2>
        <span
          className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
            activity ? "bg-accent/20 text-accent" : "bg-accent-2/20 text-accent-2"
          }`}
        >
          {activity ? activity.kind : "bandmate"}
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
            <StepLine key={entry.id} text={entry.text} fields={entry.fields} live={working && i === transcript.length - 1} />
          ) : (
            <div
              key={entry.id}
              className={`flex max-w-[92%] flex-col gap-0.5 rounded-sm border px-2 py-1.5 ${KIND_CLASS[entry.kind]} ${
                entry.role === "user" ? "self-end" : "self-start"
              }`}
            >
              <span className="flex items-baseline justify-between gap-3 text-[10px] text-muted">
                <span className="font-mono">{entry.role === "user" ? (entry.kind === "compose" ? "you · compose" : "you") : "bandmate"}</span>
                <span className="flex items-baseline gap-1.5">
                  {waiting.has(`${entry.at}|${entry.text}`) ? (
                    <span className="rounded-sm bg-line px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted">waiting</span>
                  ) : null}
                  <span className="font-mono text-muted/70">{relative(entry.at, now)}</span>
                </span>
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
          <div className="flex flex-col gap-0.5 self-start rounded-sm border border-dashed border-line px-2 py-1.5 text-xs text-muted" role="status">
            <span className="flex items-center gap-2">
              <span className="flex gap-0.5" aria-hidden>
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </span>
              {activity ? `bandmate is ${ACTIVITY_LABEL[activity.kind]}…` : phase === "deciding" ? "bandmate is thinking…" : "bandmate is applying changes…"}
            </span>
            {activity ? <span className="pl-6 font-mono text-[11px] text-muted/70">{activity.message}</span> : null}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-2 border-t border-line px-3 py-2">
        <div className="flex items-stretch gap-2">
          {/* Live while mate works: a second message is queued and answered in turn, not refused. */}
          <textarea
            rows={2}
            className="min-w-0 flex-1 resize-none rounded-sm border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/70 focus:border-accent"
            placeholder={song ? "e.g. “make the breakdown sparser”" : "e.g. “something funky and upbeat”"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            disabled={disabled}
          />
          <button type="submit" disabled={disabled || !text.trim()} className={btn("h-full bg-accent text-black")} title={working ? "Mate is busy; this waits its turn" : undefined}>
            {working ? "queue" : "send"}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {song ? (
            <button
              type="button"
              disabled={disabled || busy || activity !== null}
              onClick={newSong}
              className={btn()}
              title="Put the active song away so the next thing you say starts a new one"
            >
              new song
            </button>
          ) : null}
        </div>
        {queued.length > 0 ? (
          <p className="text-[11px] leading-snug text-muted">
            {queued.length} message{queued.length === 1 ? "" : "s"} waiting; mate answers them in order.
          </p>
        ) : null}
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
