import { formLabels, formTotalBars, parseForm, type FormEntry, type Section } from "@aibleton/protocol";

interface Props {
  /** Form string, e.g. `"a8 b8 a8 b8 c4"`. */
  form: string;
  /** Section briefs, keyed by label; drives the legend and the block tooltips. */
  sections?: Record<string, Section>;
  /** Hide the per-letter legend (the strip alone reads fine in a dense list). */
  showLegend?: boolean;
}

/**
 * Full class strings only — Tailwind cannot see interpolated names, so a
 * `bg-${letter}` style lookup would build to nothing.
 */
const LETTER_CLASS: Record<string, string> = {
  a: "bg-accent/25 border-accent/60 text-accent",
  b: "bg-accent-2/25 border-accent-2/60 text-accent-2",
  c: "bg-midi/25 border-midi/60 text-midi",
  d: "bg-audio/25 border-audio/60 text-audio",
  e: "bg-foreground/20 border-foreground/50 text-foreground",
  f: "bg-muted/25 border-muted/60 text-muted",
};
const FALLBACK_CLASS = "bg-panel-2 border-line text-muted";

/** The colour a letter carries everywhere in the UI. Full class string, ready to interpolate. */
export function letterClass(label: string): string {
  return LETTER_CLASS[label] ?? FALLBACK_CLASS;
}

/** Narrowest a block may get, so a 1-bar section still shows its letter. */
const MIN_BLOCK_PX = 26;
const PX_PER_BAR = 7;

/**
 * A form rendered as a roadmap: one block per occurrence, width proportional to
 * its bars and colour keyed to its letter, so repetition is visible at a glance.
 * Scrolls inside itself rather than widening the page.
 */
export function FormStrip({ form, sections, showLegend = true }: Props) {
  let entries: FormEntry[];
  try {
    entries = parseForm(form);
  } catch {
    return <p className="font-mono text-xs text-audio">unreadable form: {form}</p>;
  }

  const total = formTotalBars(entries);
  const labels = formLabels(entries);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-full gap-px">
          {entries.map((entry, i) => (
            <div
              key={`${entry.label}-${i}`}
              className={`flex h-11 flex-col items-center justify-center overflow-hidden rounded-sm border ${letterClass(
                entry.label,
              )}`}
              style={{ flexGrow: entry.bars, flexBasis: 0, minWidth: Math.max(MIN_BLOCK_PX, entry.bars * PX_PER_BAR) }}
              title={`${entry.label} · ${entry.bars} bars${
                sections?.[entry.label] ? ` · ${sections[entry.label].brief}` : ""
              }`}
            >
              <span className="font-mono text-sm font-semibold leading-none">{entry.label}</span>
              <span className="mt-0.5 font-mono text-[10px] leading-none opacity-70">{entry.bars}</span>
            </div>
          ))}
        </div>
      </div>

      {showLegend ? (
        <ul className="flex flex-col gap-0.5">
          {labels.map((label) => (
            <li key={label} className="flex items-baseline gap-2 text-[11px]">
              <span className={`h-2.5 w-2.5 shrink-0 translate-y-0.5 rounded-sm border ${letterClass(label)}`} />
              <span className="font-mono text-[11px]">{label}</span>
              <span className="min-w-0 flex-1 truncate text-muted" title={sections?.[label]?.brief ?? ""}>
                {sections?.[label]?.brief ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="sr-only">{`${entries.length} sections, ${total} bars`}</span>
    </div>
  );
}
