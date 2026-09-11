import type { Activity } from "@aibleton/protocol";

/**
 * The session column while a song is being composed: the lanes it will fill,
 * pulsing, under where the compose has got to. Only the step it is on — the
 * conversation pane keeps the full trail of what the bandmate decided.
 */
export function ComposingState({ activity }: { activity: Activity }) {
  const fraction = activity.fraction ?? 0.05;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" role="status" aria-live="polite">
      <div className="flex flex-col gap-2 rounded-sm border border-line bg-panel-2 p-2.5">
        <div className="h-1 overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
        <p className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
          <span className="w-16 shrink-0 uppercase tracking-wider text-muted/70">{activity.kind}</span>
          <span className="truncate text-foreground" title={activity.message}>
            {activity.message}
          </span>
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid animate-pulse grid-cols-[200px_1fr] gap-2" style={{ animationDelay: `${i * 120}ms` }}>
            <div className="h-12 rounded-sm border border-line bg-panel-2" />
            <div className="h-12 rounded-sm border border-dashed border-line/70" />
          </div>
        ))}
      </div>
      <p className="text-center text-xs text-muted">Composing… then Splice is searched for every slot.</p>
    </div>
  );
}
