import { useSyncExternalStore } from "react";
import type { Activity, CommandSummary, Phase } from "@aibleton/protocol";
import { ACTIVITY_LABEL, PHASE_CLASS } from "../lib/status";
import { PanelHeader } from "./ui/PanelHeader";

interface Props {
  commands: CommandSummary[];
  /** Where the machine is. What the bandmate *said* belongs in the conversation, not here. */
  phase: Phase;
  /** The one thing mate is working on, or null at rest. */
  activity: Activity | null;
  /** Requests typed while it was busy, oldest first. */
  queued: CommandSummary[];
  /** What the bandmate is working towards, or null when it has no standing goal. */
  goal: string | null;
  /** What went wrong, when the phase is `error`. */
  error: string | null;
  now: number;
  /** True while mate is paused: it still answers, it just does not act between messages. */
  answersOnly: boolean;
  /** Disabled until mate is reachable. */
  disabled: boolean;
  setAnswersOnly: (answersOnly: boolean) => void;
}

type Source = CommandSummary["source"];

const SOURCES: Source[] = ["api", "timer", "midi", "loop", "ableton", "test"];

const SOURCE_CLASS: Record<Source, string> = {
  api: "text-accent-2",
  timer: "text-muted",
  midi: "text-audio",
  loop: "text-midi",
  ableton: "text-accent",
  test: "text-muted",
};

/** Chatty, low-signal sources; hidden by default so the mailbox reads as events worth noticing. */
const HIDDEN_BY_DEFAULT: readonly Source[] = ["timer", "loop"];
const STORAGE_KEY = "mailbox.hiddenSources";

// A tiny external store for the hidden-source preference, read via useSyncExternalStore.
// getServerSnapshot always returns the default, so the client's first (hydrating) render
// matches the server exactly; the stored preference (if any) only takes effect once the
// client reads localStorage for real, on the next, post-hydration render.
const SERVER_SNAPSHOT = new Set<Source>(HIDDEN_BY_DEFAULT);
let clientSnapshot: Set<Source> | null = null;
const listeners = new Set<() => void>();

function readStored(): Set<Source> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set(HIDDEN_BY_DEFAULT);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(HIDDEN_BY_DEFAULT);
    return new Set(parsed.filter((s): s is Source => SOURCES.includes(s as Source)));
  } catch {
    return new Set(HIDDEN_BY_DEFAULT);
  }
}

function getSnapshot(): Set<Source> {
  clientSnapshot ??= readStored();
  return clientSnapshot;
}

function getServerSnapshot(): Set<Source> {
  return SERVER_SNAPSHOT;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/**
 * Where the loop is: the phase, what it is working on and what is waiting for
 * it. Not what it said — that is the conversation's job, and printing it twice
 * only made the same sentence look like two.
 */
function Status({ phase, activity, queued, goal, error, answersOnly }: { phase: Phase; activity: Activity | null; queued: CommandSummary[]; goal: string | null; error: string | null; answersOnly: boolean }) {
  const doing = activity ? ACTIVITY_LABEL[activity.kind] : phase === "deciding" ? "thinking" : phase === "acting" ? "applying changes" : null;
  return (
    <div className="flex flex-col gap-1.5 rounded-sm bg-panel-2 px-2 py-1.5">
      <p className="flex items-center gap-1.5 text-xs">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${doing ? "animate-pulse bg-accent" : "bg-line"}`} aria-hidden />
        <span className={`font-mono text-[10px] uppercase tracking-wider ${PHASE_CLASS[phase]}`}>{phase}</span>
        <span className="truncate">{doing ?? (answersOnly ? "waiting for you" : "watching the set")}</span>
      </p>
      {activity ? (
        <>
          <p className="truncate font-mono text-[10px] text-muted" title={activity.message}>
            {activity.message}
          </p>
          {activity.fraction !== null ? (
            <div className="h-0.5 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${Math.round(activity.fraction * 100)}%` }} />
            </div>
          ) : null}
        </>
      ) : null}
      {phase === "error" && error ? (
        <p className="truncate text-[11px] text-audio" title={error}>
          {error}
        </p>
      ) : null}
      {goal ? (
        <p className="flex gap-1.5 text-[11px]">
          <span className="shrink-0 uppercase tracking-wider text-[10px] text-muted">goal</span>
          <span className="truncate" title={goal}>
            {goal}
          </span>
        </p>
      ) : null}
      {queued.length > 0 ? (
        <ul className="flex flex-col gap-0.5 border-t border-line/60 pt-1 font-mono text-[10px] text-muted">
          {queued.map((c) => (
            <li key={c.id} className="truncate" title={c.summary}>
              waiting · {c.summary}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * How the bandmate behaves between messages. It always answers what you say;
 * this is only about whether it does anything on its own — the pause/resume
 * commands, said the way the drummer thinks about them.
 */
function Mode({ answersOnly, disabled, onChange }: { answersOnly: boolean; disabled: boolean; onChange: (answersOnly: boolean) => void }) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-sm border border-line" role="group" aria-label="bandmate mode">
      <ModeButton on={!answersOnly} disabled={disabled} onClick={() => onChange(false)} title="Mate watches the set and can act between your messages">
        acts on its own
      </ModeButton>
      <ModeButton on={answersOnly} disabled={disabled} onClick={() => onChange(true)} title="Mate answers what you say and nothing else">
        answers only
      </ModeButton>
    </div>
  );
}

/**
 * Full class strings only — Tailwind cannot see interpolated names. The same
 * mono ten-pixel type as a header's facts and as the source chips below, so a
 * control in a header and a count in one are not two design languages.
 */
const MODE_CLASS: Record<"on" | "off", string> = {
  on: "bg-accent-2/15 text-accent-2",
  off: "bg-panel-2 text-muted/70 hover:text-foreground",
};

function ModeButton({ on, disabled, onClick, title, children }: { on: boolean; disabled: boolean; onClick: () => void; title: string; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      title={title}
      className={`px-1.5 py-0.5 font-mono text-[10px] lowercase disabled:cursor-not-allowed disabled:opacity-40 ${MODE_CLASS[on ? "on" : "off"]}`}
    >
      {children}
    </button>
  );
}

function toggleSource(source: Source): void {
  const next = new Set(getSnapshot());
  if (next.has(source)) next.delete(source);
  else next.add(source);
  clientSnapshot = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // best-effort; a private window or blocked storage just skips persistence
  }
  for (const listener of listeners) listener();
}

export function MailboxPanel({ commands, phase, activity, queued, goal, error, now, answersOnly, disabled, setAnswersOnly }: Props) {
  const hidden = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const visible = commands.filter((c) => !hidden.has(c.source));

  return (
    <aside className="flex min-h-0 flex-col gap-3 rounded-md border border-line bg-panel p-3">
      <section className="flex flex-col gap-1">
        <PanelHeader title="bandmate" actions={<Mode answersOnly={answersOnly} disabled={disabled} onChange={setAnswersOnly} />} />
        <Status phase={phase} activity={activity} queued={queued} goal={goal} error={error} answersOnly={answersOnly} />
      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-1.5">
        <PanelHeader title="mailbox" level={3} count={`${visible.length}/${commands.length}`} />
        <div className="flex flex-wrap gap-1">
          {SOURCES.map((source) => {
            const on = !hidden.has(source);
            return (
              <button
                key={source}
                type="button"
                onClick={() => toggleSource(source)}
                aria-pressed={on}
                className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] transition-opacity ${
                  on ? `${SOURCE_CLASS[source]} bg-panel-2` : "text-muted/50 bg-panel-2/40 opacity-60"
                }`}
                title={on ? `Hide ${source} events` : `Show ${source} events`}
              >
                {source}
              </button>
            );
          })}
        </div>
        {commands.length === 0 ? (
          <p className="text-xs text-muted">No commands yet.</p>
        ) : visible.length === 0 ? (
          <p className="text-xs text-muted">All sources filtered out.</p>
        ) : (
          <ul className="flex flex-col gap-1 overflow-y-auto pr-1 text-xs">
            {visible.map((c) => (
              <li key={c.id} className="grid grid-cols-[52px_1fr_auto] items-baseline gap-2 border-b border-line/60 pb-1">
                <span className={`font-mono text-[10px] ${SOURCE_CLASS[c.source]}`}>{c.source}</span>
                <span className="min-w-0">
                  <span className="font-mono">{c.type}</span>
                  {c.summary ? <span className="ml-1.5 truncate text-muted">{c.summary}</span> : null}
                </span>
                <span className="font-mono text-[10px] text-muted/70">{relative(c.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
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
