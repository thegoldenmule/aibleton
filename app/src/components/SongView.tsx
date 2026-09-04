import { formTotalBars, keyName, parseForm, songTracks, type Song } from "@aibleton/protocol";
import { FormStrip } from "./FormStrip";
import { TrackLane } from "./TrackLane";

/**
 * The active song as the session mate intends to build: the brief in a row of
 * chips, the form as a roadmap, then one lane per planned track with a clip
 * slot per section (a scene per section) and the placements on the
 * arrangement strip. This is mate's state, not Ableton's.
 */
export function SongView({ song }: { song: Song }) {
  const { brief, plan } = song;
  const totalBars = formTotalBars(parseForm(song.template.form));
  const tracks = songTracks(song);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-sm border border-line bg-panel-2 p-2.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-sm font-semibold">{song.name}</h3>
          <span className="truncate text-xs text-muted" title={song.request.text}>
            “{song.request.text}”
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone="accent">{plan.bpm} bpm</Chip>
          <Chip tone="accent-2">{keyName(plan.key)}</Chip>
          <Chip>
            {plan.timeSignature.numerator}/{plan.timeSignature.denominator}
          </Chip>
          <Chip>{totalBars} bars</Chip>
          {brief.genres.map((genre) => (
            <Chip key={`g-${genre}`} tone="midi">
              {genre}
            </Chip>
          ))}
          {brief.descriptors.map((word) => (
            <Chip key={`d-${word}`}>{word}</Chip>
          ))}
          {brief.swing !== null ? <Chip>swing {Math.round(brief.swing * 100)}%</Chip> : null}
        </div>
        <FormStrip form={song.template.form} sections={song.template.sections} showLegend={false} />
        <p className="text-[11px] text-muted">
          <span className="text-foreground/80">{song.template.name}</span> × <span className="text-foreground/80">{song.band.name}</span>
          {brief.templateFeedback.notes || brief.bandFeedback.notes ? (
            <span title={[brief.templateFeedback.notes, brief.bandFeedback.notes].filter(Boolean).join("\n")}> · notes</span>
          ) : null}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto">
        {tracks.map((track) => (
          <TrackLane key={track.index} track={track} />
        ))}
      </div>

      <p className="text-[10px] text-muted/70">
        {plan.slots.length} sample slots · {plan.placements.length} placements · nothing sent to Splice or Ableton yet
      </p>
    </div>
  );
}

/** Full class strings only — Tailwind cannot see interpolated names. */
const CHIP_CLASS: Record<string, string> = {
  accent: "border-accent/60 bg-accent/15 text-accent",
  "accent-2": "border-accent-2/60 bg-accent-2/15 text-accent-2",
  midi: "border-midi/60 bg-midi/15 text-midi",
  plain: "border-line bg-panel text-muted",
};

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: keyof typeof CHIP_CLASS }) {
  return <span className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${CHIP_CLASS[tone]}`}>{children}</span>;
}
