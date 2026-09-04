export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = (process.env.MATE_LOG_LEVEL as LogLevel) ?? "info";
export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export function createLogger(tag: string): Logger {
  const emit = (level: LogLevel, msg: string, meta?: unknown) => {
    if (ORDER[level] < ORDER[threshold]) return;
    const line = `${new Date().toISOString()} ${level.padEnd(5)} [${tag}] ${msg}`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    meta === undefined ? fn(line) : fn(line, meta);
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}

/** Logger that records nothing; handy in tests. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
