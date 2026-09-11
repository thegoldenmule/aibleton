import type { SongPlan, Transport } from "@aibleton/protocol";

/**
 * What the song asks for, and what Live is actually doing.
 *
 * These are two different facts that used to be shown in two different places —
 * the plan's `bpm`/`timeSignature` as chips on the song, Live's transport as
 * readouts in the header — so nothing ever said whether they agreed. Here the
 * plan's value leads and Live is called out only when it differs.
 *
 * A mismatch is the *normal* state before a song is built: mate sets the set
 * tempo once, on the first arrange. So this is the readout that says the build
 * has not happened yet, not an error.
 */
export function SongTransport({ plan, transport }: { plan: SongPlan | null; transport: Transport | null }) {
  if (!plan && !transport) return null;

  const liveTempo = transport ? `${formatTempo(transport.tempo)} bpm` : null;
  const planTempo = plan ? `${formatTempo(plan.bpm)} bpm` : null;
  const liveSig = transport ? `${transport.signatureNumerator}/${transport.signatureDenominator}` : null;
  const planSig = plan ? `${plan.timeSignature.numerator}/${plan.timeSignature.denominator}` : null;

  return (
    <div className="flex flex-wrap items-baseline justify-end gap-x-2.5 gap-y-1">
      <Value
        value={planTempo ?? liveTempo}
        live={liveTempo}
        differs={!!plan && !!transport && !near(plan.bpm, transport.tempo)}
        planned={!!planTempo}
      />
      <Value value={planSig ?? liveSig} live={liveSig} differs={!!planSig && !!liveSig && planSig !== liveSig} planned={!!planSig} />
      {transport ? (
        <>
          <span className={transport.isPlaying ? "text-accent" : "text-muted/70"}>
            {transport.isPlaying ? "▶ playing" : "■ stopped"}
          </span>
          <span className="text-muted/70">{transport.currentSongTime.toFixed(1)} b</span>
        </>
      ) : (
        <span className="text-muted/50">Live not connected</span>
      )}
    </div>
  );
}

/** Full class strings only — Tailwind cannot see interpolated names. */
const VALUE_CLASS: Record<"agrees" | "differs" | "unknown", string> = {
  agrees: "text-accent-2",
  differs: "text-accent",
  unknown: "text-foreground",
};

function Value({ value, live, differs, planned }: { value: string | null; live: string | null; differs: boolean; planned: boolean }) {
  if (!value) return null;
  const state = !planned || !live ? "unknown" : differs ? "differs" : "agrees";
  return (
    <span className="flex items-baseline gap-1">
      <span className={VALUE_CLASS[state]} title={planned ? "what the song asks for" : "what Live reports"}>
        {value}
      </span>
      {differs ? (
        <span className="text-audio" title="Live has not been set to the song yet — build it in Live">
          ⚠ Live {live}
        </span>
      ) : null}
    </span>
  );
}

/** Live reports a float; the plan holds a round number. Compare loosely. */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.05;
}

function formatTempo(t: number): string {
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}
