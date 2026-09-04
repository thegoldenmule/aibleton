import type { CommandSummary } from "@aibleton/protocol";

interface Props {
  commands: CommandSummary[];
  lastMessage: string | null;
  now: number;
}

const SOURCE_CLASS: Record<CommandSummary["source"], string> = {
  api: "text-accent-2",
  timer: "text-muted",
  midi: "text-audio",
  loop: "text-midi",
  ableton: "text-accent",
  test: "text-muted",
};

export function MailboxPanel({ commands, lastMessage, now }: Props) {
  return (
    <aside className="flex min-h-0 flex-col gap-3 rounded-md border border-line bg-panel p-3">
      <section>
        <h2 className="mb-1 text-[10px] uppercase tracking-wider text-muted">bandmate</h2>
        <p className="min-h-10 rounded-sm bg-panel-2 px-2 py-1.5 text-sm leading-snug">
          {lastMessage ?? <span className="text-muted">Nothing said yet.</span>}
        </p>
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        <h2 className="mb-1 text-[10px] uppercase tracking-wider text-muted">
          mailbox <span className="text-muted/60">({commands.length})</span>
        </h2>
        {commands.length === 0 ? (
          <p className="text-xs text-muted">No commands yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 overflow-y-auto pr-1 text-xs">
            {commands.map((c) => (
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
