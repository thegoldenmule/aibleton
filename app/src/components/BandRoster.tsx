import type { BandPart } from "@aibleton/protocol";

interface Props {
  /** Ordered parts — takes the array rather than a Band so an unsaved draft renders too. */
  parts: BandPart[];
  /** Card content: two lines per part and no fixed columns, for a lane a third of the page wide. */
  compact?: boolean;
}

/**
 * Full class strings only — Tailwind cannot see interpolated names, so a
 * `bg-${role}` style lookup would build to nothing. Ten roles onto the six
 * theme tokens: related roles share a hue and separate on intensity, so the
 * ensemble shape stays readable and a role is the same colour in every band.
 */
const ROLE_CLASS: Record<string, string> = {
  drums: "bg-accent/30 border-accent/60 text-accent",
  percussion: "bg-accent/15 border-accent/40 text-accent",
  bass: "bg-midi/30 border-midi/60 text-midi",
  guitar: "bg-audio/30 border-audio/60 text-audio",
  strings: "bg-audio/15 border-audio/40 text-audio",
  keys: "bg-accent-2/30 border-accent-2/60 text-accent-2",
  synth: "bg-accent-2/15 border-accent-2/40 text-accent-2",
  horns: "bg-foreground/20 border-foreground/50 text-foreground",
  vocals: "bg-muted/30 border-muted/60 text-muted",
  fx: "border-dashed bg-midi/10 border-midi/50 text-midi",
};
const FALLBACK_CLASS = "bg-panel-2 border-line text-muted";

/** The colour a role carries everywhere in the UI. Full class string, ready to interpolate. */
export function roleClass(role: string): string {
  return ROLE_CLASS[role] ?? FALLBACK_CLASS;
}

/**
 * A band rendered as the track stack it will become: one lane per part in
 * order, colour keyed to the role, so two keys players or a missing bass read
 * at a glance.
 *
 * Every part is always rendered. This used to cap `compact` at a scrolling
 * 11rem, which put a scroller inside the workspace column's scroller; a band
 * card is as tall as its band, and the grid around it flows.
 */
export function BandRoster({ parts, compact = false }: Props) {
  if (parts.length === 0) return <p className="text-xs text-muted">no parts</p>;

  if (compact) {
    return (
      <ul className="flex flex-col gap-px">
        {parts.map((part) => (
          <li
            key={part.id}
            className="flex items-stretch gap-2 rounded-sm border border-line bg-panel-2 py-1 pl-0 pr-2"
          >
            <span
              className={`w-1.5 shrink-0 self-stretch rounded-l-sm border-r ${roleClass(part.role)}`}
              aria-hidden="true"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={`shrink-0 rounded-sm border px-1 py-px font-mono text-[9px] ${roleClass(part.role)}`}
                  title={part.role}
                >
                  {part.role}
                </span>
                <span className="min-w-0 truncate text-xs" title={part.name}>
                  {part.name}
                </span>
              </span>
              <span className="truncate text-[10px] leading-snug text-muted" title={part.brief}>
                {part.brief}
              </span>
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="flex flex-col gap-px">
      {parts.map((part, i) => (
        <li
          key={part.id}
          className="flex items-stretch gap-2 rounded-sm border border-line bg-panel-2 py-1.5 pl-0 pr-2"
        >
          <span
            className={`w-1.5 shrink-0 self-stretch rounded-l-sm border-r ${roleClass(part.role)}`}
            aria-hidden="true"
          />
          <span className="w-5 shrink-0 self-center font-mono text-[10px] text-muted/60">{i + 1}</span>
          <span
            className={`w-20 shrink-0 self-center truncate rounded-sm border px-1 py-0.5 text-center font-mono text-[10px] ${roleClass(
              part.role,
            )}`}
            title={part.role}
          >
            {part.role}
          </span>
          <span className="w-40 shrink-0 self-center truncate text-xs" title={part.name}>
            {part.name}
          </span>
          <span className="min-w-0 flex-1 self-center break-words text-[11px] leading-snug text-muted" title={part.brief}>
            {part.brief}
          </span>
        </li>
      ))}
    </ul>
  );
}
