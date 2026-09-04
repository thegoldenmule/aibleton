import { useSyncExternalStore } from "react";
import type { CommandSummary } from "@aibleton/protocol";

interface Props {
  commands: CommandSummary[];
  lastMessage: string | null;
  now: number;
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

export function MailboxPanel({ commands, lastMessage, now }: Props) {
  const hidden = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const visible = commands.filter((c) => !hidden.has(c.source));

  return (
    <aside className="flex min-h-0 flex-col gap-3 rounded-md border border-line bg-panel p-3">
      <section>
        <h2 className="mb-1 text-[10px] uppercase tracking-wider text-muted">bandmate</h2>
        <p className="min-h-10 rounded-sm bg-panel-2 px-2 py-1.5 text-sm leading-snug">
          {lastMessage ?? <span className="text-muted">Nothing said yet.</span>}
        </p>
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-[10px] uppercase tracking-wider text-muted">
            mailbox <span className="text-muted/60">({visible.length}/{commands.length})</span>
          </h2>
        </div>
        <div className="mb-1.5 flex flex-wrap gap-1">
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
