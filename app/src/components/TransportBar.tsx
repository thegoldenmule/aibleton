import type { AdapterStatus, Phase, Transport } from "@aibleton/protocol";
import type { Connection } from "../lib/useMateState";

interface Props {
  transport: Transport | null;
  phase: Phase;
  error: string | null;
  adapters: AdapterStatus;
  connection: Connection;
  goal: string | null;
}

const PHASE_CLASS: Record<Phase, string> = {
  idle: "bg-line text-foreground",
  observing: "bg-accent-2/25 text-accent-2",
  deciding: "bg-accent/25 text-accent",
  acting: "bg-midi/25 text-midi",
  paused: "bg-muted/25 text-muted",
  error: "bg-audio/25 text-audio",
};

const CONNECTION_CLASS: Record<Connection, string> = {
  connecting: "bg-accent animate-pulse",
  open: "bg-accent-2",
  error: "bg-audio",
};

export function TransportBar({ transport, phase, error, adapters, connection, goal }: Props) {
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-line bg-panel px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${CONNECTION_CLASS[connection]}`} title={`mate: ${connection}`} />
        <span className="text-sm font-semibold tracking-tight">aibleton</span>
        <span className="text-xs text-muted">mate</span>
      </div>

      <Readout label="tempo" value={transport ? `${formatTempo(transport.tempo)} bpm` : "—"} />
      <Readout
        label="sig"
        value={transport ? `${transport.signatureNumerator}/${transport.signatureDenominator}` : "—"}
      />
      <Readout
        label="transport"
        value={transport ? (transport.isPlaying ? "▶ playing" : "■ stopped") : "—"}
        emphasis={transport?.isPlaying ?? false}
      />
      <Readout label="pos" value={transport ? `${transport.currentSongTime.toFixed(1)} b` : "—"} />

      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted">phase</span>
        <span className={`rounded-full px-2 py-0.5 font-mono text-xs ${PHASE_CLASS[phase]}`}>{phase}</span>
        {phase === "error" && error ? (
          <span className="max-w-xs truncate text-xs text-audio" title={error}>
            {error}
          </span>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Badge label="ableton" value={adapters.ableton} live={adapters.ableton === "mcp"} />
        <Badge label="splice" value={adapters.splice} live={adapters.splice === "mcp"} />
        <Badge label="brain" value={adapters.brain} live={adapters.brain === "anthropic"} />
      </div>

      {goal ? (
        <div className="basis-full text-xs text-muted">
          <span className="uppercase tracking-wider text-[10px] mr-2">goal</span>
          <span className="text-foreground">{goal}</span>
        </div>
      ) : null}
    </header>
  );
}

function Readout({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <span className={`font-mono text-sm ${emphasis ? "text-accent" : ""}`}>{value}</span>
    </div>
  );
}

function Badge({ label, value, live }: { label: string; value: string; live: boolean }) {
  return (
    <span
      className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${
        live ? "border-accent-2/60 text-accent-2" : "border-line text-muted"
      }`}
      title={`${label} adapter: ${value}`}
    >
      {label}:{value}
    </span>
  );
}

function formatTempo(t: number): string {
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}
