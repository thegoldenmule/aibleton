import type { BandPart } from "@aibleton/protocol";

interface Props {
  /** Ordered parts — takes the array rather than a Band so an unsaved draft renders too. */
  parts: BandPart[];
  /** Card content: two lines per part and no fixed columns, for a lane a third of the page wide. */
  compact?: boolean;
  /**
   * Pad out to this many lanes with empty ones. For a roster that is re-rolled
   * in place: a recipe can staff anywhere from its core to its full roster, and
   * a panel that resized by seven lanes every time you rolled again would throw
   * away whatever you were reading underneath it.
   */
  minRows?: number;
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

/**
 * The same ten roles again, as bare text colour — for a role used as a heading
 * rather than a chip, where a background would make it read as one more item in
 * the list it is labelling.
 *
 * Written out rather than derived because Tailwind reads source text: a
 * `text-${tone}` built at runtime compiles to nothing. Keep the two maps in
 * step; a role missing here falls back to the same muted grey.
 */
const ROLE_TEXT_CLASS: Record<string, string> = {
  drums: "text-accent",
  percussion: "text-accent",
  bass: "text-midi",
  guitar: "text-audio",
  strings: "text-audio",
  keys: "text-accent-2",
  synth: "text-accent-2",
  horns: "text-foreground",
  vocals: "text-muted",
  fx: "text-midi",
};

/** The colour a role carries everywhere in the UI. Full class string, ready to interpolate. */
export function roleClass(role: string): string {
  return ROLE_CLASS[role] ?? FALLBACK_CLASS;
}

/** The same colour as bare text, for a role that is a label and not a chip. */
export function roleTextClass(role: string): string {
  return ROLE_TEXT_CLASS[role] ?? "text-muted";
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
export function BandRoster({ parts, compact = false, minRows = 0 }: Props) {
  if (parts.length === 0) return <p className="text-xs text-muted">no parts</p>;
  const empty = Math.max(0, minRows - parts.length);

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
        {emptyLanes(empty, true)}
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
      {emptyLanes(empty, false)}
    </ul>
  );
}

/**
 * Lanes a band could have had and does not. Purely to hold the height.
 *
 * Each one mirrors a real lane element for element — same wrappers, same type
 * sizes, borders turned transparent and the text a non-breaking space. That is
 * fussier than a spacer of a guessed height, and it has to be: a lane is as
 * tall as its tallest child, so an empty lane missing the `text-xs` name would
 * come out a pixel short and the panel would still creep as the split between
 * real and empty lanes moved. Hidden from assistive tech — there is nothing here.
 */
function emptyLanes(count: number, compact: boolean) {
  return Array.from({ length: count }, (_, i) => (
    <li
      key={`empty-${i}`}
      aria-hidden="true"
      className={
        compact
          ? "flex items-stretch gap-2 rounded-sm border border-dashed border-line/50 py-1 pl-0 pr-2"
          : "flex items-stretch gap-2 rounded-sm border border-dashed border-line/50 py-1.5 pl-0 pr-2"
      }
    >
      <span className="w-1.5 shrink-0 self-stretch rounded-l-sm border-r border-line/40" />
      {compact ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 rounded-sm border border-transparent px-1 py-px font-mono text-[9px]">&nbsp;</span>
            <span className="min-w-0 truncate text-xs">&nbsp;</span>
          </span>
          <span className="truncate text-[10px] leading-snug">&nbsp;</span>
        </span>
      ) : (
        <>
          <span className="w-5 shrink-0 self-center font-mono text-[10px]">&nbsp;</span>
          <span className="w-20 shrink-0 self-center rounded-sm border border-transparent px-1 py-0.5 text-center font-mono text-[10px]">
            &nbsp;
          </span>
          <span className="w-40 shrink-0 self-center truncate text-xs">&nbsp;</span>
          <span className="min-w-0 flex-1 self-center text-[11px] leading-snug">&nbsp;</span>
        </>
      )}
    </li>
  ));
}
