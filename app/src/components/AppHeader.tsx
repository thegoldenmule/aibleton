import type { AdapterStatus } from "@aibleton/protocol";
import type { Connection } from "../lib/useMateState";
import { SessionChip } from "./SessionChip";

export interface AppHeaderProps {
  adapters: AdapterStatus;
  connection: Connection;
}

const CONNECTION_CLASS: Record<Connection, string> = {
  connecting: "bg-accent animate-pulse",
  open: "bg-accent-2",
  error: "bg-audio",
};

export function AppHeader({ adapters, connection }: AppHeaderProps) {
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-line bg-panel px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${CONNECTION_CLASS[connection]}`} title={`bandmate: ${connection}`} />
        <span className="text-sm font-semibold tracking-tight">aibleton</span>
        <span className="text-xs text-muted">bandmate</span>
      </div>

      <SessionChip />

      <div className="ml-auto flex items-center gap-1.5">
        <Badge label="ableton" value={adapters.ableton} live={adapters.ableton === "mcp"} />
        <Badge label="splice" value={adapters.splice} live={adapters.splice === "mcp"} />
        <Badge label="brain" value={adapters.brain} live={adapters.brain === "anthropic"} />
      </div>
    </header>
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
