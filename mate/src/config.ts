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
  /** Where the Splice OAuth client registration and tokens live (written by `bun run splice:login`, mode 0600). */
  spliceOauthFile: z.string().min(1).default(".mate/splice-oauth.json"),
  /** Localhost port the login command listens on for the OAuth redirect (`http://localhost:<port>/callback`). */
  spliceOauthCallbackPort: z.coerce.number().int().positive().default(4546),
  abletonMcpCommand: z.string().default("uvx"),
  abletonMcpArgs: z.array(z.string()).default(["ableton-mcp"]),
  maxBrainRetries: z.coerce.number().int().min(0).default(3),
  templatesDir: z.string().min(1).default(".mate/templates"),
  bandsDir: z.string().min(1).default(".mate/bands"),
  songsDir: z.string().min(1).default(".mate/songs"),
  /** Where saved sessions live: one subdirectory per session, plus `current.json`. */
  sessionsDir: z.string().min(1).default(".mate/sessions"),
  /**
   * Where the library logs live: `bands.jsonl` and `templates.jsonl`. These are
   * the **truth** for those aggregates; `bandsDir`/`templatesDir` hold the
   * rebuildable projection. Deliberately outside both, so reading a record
   * directory means reading records and nothing else.
   */
  libraryDir: z.string().min(1).default(".mate/library"),
  /**
   * Compact a session journal once it passes this many bytes; `0` never
   * compacts, which is the default and today the only behaviour. Compaction is
   * deliberately deferred — the fold caps the transcript at 200 entries and
   * commands at 50, so an oversized journal costs disk and a linear pass on
   * replay, never correctness. The knob is here so the decision can be made
   * from `SessionJournal.bytesWritten()` rather than from a guess.
   */
  journalCompactBytes: z.coerce.number().int().min(0).default(0),
  recipesDir: z.string().min(1).default(".mate/recipes"),
  /** Where downloaded Splice files land. Resolved to an absolute path per file, which is what Ableton gets. */
  downloadsDir: z.string().min(1).default(".mate/downloads"),
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
    spliceOauthFile: env.SPLICE_OAUTH_FILE,
    spliceOauthCallbackPort: env.SPLICE_OAUTH_CALLBACK_PORT,
    abletonMcpCommand: env.ABLETON_MCP_COMMAND,
    abletonMcpArgs: env.ABLETON_MCP_ARGS ? env.ABLETON_MCP_ARGS.split(" ") : undefined,
    maxBrainRetries: env.MATE_MAX_BRAIN_RETRIES,
    templatesDir: env.MATE_TEMPLATES_DIR,
    bandsDir: env.MATE_BANDS_DIR,
    songsDir: env.MATE_SONGS_DIR,
    sessionsDir: env.MATE_SESSIONS_DIR,
    libraryDir: env.MATE_LIBRARY_DIR,
    journalCompactBytes: env.MATE_JOURNAL_COMPACT_BYTES,
    recipesDir: env.MATE_RECIPES_DIR,
    downloadsDir: env.MATE_DOWNLOADS_DIR,
  });
}
