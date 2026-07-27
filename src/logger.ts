export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

let currentLevel = process.env.DEBUG ? LogLevel.DEBUG : LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Whether debug output is on. Lets a caller skip work whose only purpose is a
 * debug line (for example extra D-Bus property reads), which the per-message
 * level check inside the logger cannot avoid.
 */
export function isDebugEnabled(): boolean {
  return currentLevel <= LogLevel.DEBUG;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  const debugPrefix = `[${scope}:debug]`;
  const timestamp = (): string => new Date().toISOString().replace('T', ' ').replace('Z', '');
  const fmt = (pfx: string, msg: string): string => {
    const ts = timestamp();
    const nl = msg.match(/^(\n+)/);
    return nl ? `${nl[1]}${ts} ${pfx} ${msg.slice(nl[1].length)}` : `${ts} ${pfx} ${msg}`;
  };
  return {
    debug: (msg) => {
      if (currentLevel <= LogLevel.DEBUG) console.log(fmt(debugPrefix, msg));
    },
    info: (msg) => {
      if (currentLevel <= LogLevel.INFO) console.log(fmt(prefix, msg));
    },
    warn: (msg) => {
      if (currentLevel <= LogLevel.WARN) console.warn(fmt(prefix, msg));
    },
    error: (msg) => {
      if (currentLevel <= LogLevel.ERROR) console.error(fmt(prefix, msg));
    },
  };
}
