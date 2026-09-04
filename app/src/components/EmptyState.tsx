import { mateUrl } from "../lib/mate";

export function EmptyState({ error }: { error: string | null }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-line bg-panel/40 p-10 text-center">
      <p className="text-sm font-medium">mate is unreachable</p>
      <p className="max-w-md text-xs text-muted">
        The UI expects the mate service at <code className="font-mono text-foreground">{mateUrl()}</code>. Start it
        with <code className="font-mono text-foreground">bun run dev:mate</code> from the repo root; this page
        reconnects on its own.
      </p>
      {error ? (
        <p className="max-w-lg truncate font-mono text-[11px] text-audio" title={error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
