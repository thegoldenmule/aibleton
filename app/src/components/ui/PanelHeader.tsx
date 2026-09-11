import type { ReactNode } from "react";

interface Props {
  /** What the panel or section is called. Always the same size, weight and colour. */
  title: string;
  /** A count that belongs to the title — "3/50" — set beside it, never off in the right-hand slot. */
  count?: ReactNode;
  /** Facts about what is being shown. Styled by this component, so every panel's facts read alike. */
  meta?: ReactNode;
  /** Controls that act on the panel. Rendered as given, after `meta`. */
  actions?: ReactNode;
  /** A panel's own header is an `h2`; a section inside one is an `h3`. */
  level?: 2 | 3;
}

/** Full class strings only — Tailwind cannot see interpolated names. */
const TITLE_CLASS = "shrink-0 text-[10px] uppercase tracking-wider text-muted";
/** The one idiom for a count or a fact in a header: mono, small, quieter than the title. */
const META_CLASS = "min-w-0 font-mono text-[10px] text-muted/70";

/**
 * The one header row every panel wears: the name on the left, and on the right
 * whatever that panel has to say or offer — facts, a count, a control.
 *
 * It exists because the three columns each grew their own: a heading beside a
 * filled pill, a heading beside a button group, a heading beside a line of
 * mono facts. They are the same row and now they are the same component, so a
 * count in one panel and a toggle in another sit at the same height, in the
 * same type, in the same colours.
 *
 * `min-h-6` is what keeps that promise across columns: a header with a button
 * in it is no taller than one with only a word.
 */
export function PanelHeader({ title, count, meta, actions, level = 2 }: Props) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <div className="flex min-h-6 items-center justify-between gap-3">
      <Heading className={TITLE_CLASS}>
        {title}
        {count !== undefined && count !== null ? <span className="ml-1.5 font-mono normal-case text-muted/60">{count}</span> : null}
      </Heading>
      {meta || actions ? (
        <div className="flex min-w-0 items-center justify-end gap-2">
          {meta ? <div className={META_CLASS}>{meta}</div> : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}
