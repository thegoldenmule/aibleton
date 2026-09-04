import { z } from "zod";

export const PortModeSchema = z.enum(["auto", "mcp", "stub"]);
export type PortMode = z.infer<typeof PortModeSchema>;
export const BrainModeSchema = z.enum(["auto", "anthropic", "scripted"]);
export type BrainMode = z.infer<typeof BrainModeSchema>;

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(4545),
  corsOrigin: z.string().default("http://localhost:3000"),
  tickMs: z.coerce.number().int().positive().default(5000),
  ableton: PortModeSchema.default("auto"),
  splice: PortModeSchema.default("auto"),
  brain: BrainModeSchema.default("auto"),
  model: z.string().default("claude-opus-5"),
  spliceMcpUrl: z.string().url().default("https://mcp.splice.com/mcp"),
  spliceMcpToken: z.string().optional(),
  abletonMcpCommand: z.string().default("uvx"),
  abletonMcpArgs: z.array(z.string()).default(["ableton-mcp"]),
  maxBrainRetries: z.coerce.number().int().min(0).default(3),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return ConfigSchema.parse({
    port: env.MATE_PORT,
    corsOrigin: env.MATE_CORS_ORIGIN,
    tickMs: env.MATE_TICK_MS,
    ableton: env.MATE_ABLETON,
    splice: env.MATE_SPLICE,
    brain: env.MATE_BRAIN,
    model: env.MATE_MODEL,
    spliceMcpUrl: env.SPLICE_MCP_URL,
    spliceMcpToken: env.SPLICE_MCP_TOKEN,
    abletonMcpCommand: env.ABLETON_MCP_COMMAND,
    abletonMcpArgs: env.ABLETON_MCP_ARGS ? env.ABLETON_MCP_ARGS.split(" ") : undefined,
    maxBrainRetries: env.MATE_MAX_BRAIN_RETRIES,
  });
}
