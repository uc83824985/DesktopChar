export type TtsLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TtsLogEntry {
  timestamp: string;
  level: TtsLogLevel;
  event: string;
  provider: string;
  requestId?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface TtsLogger {
  write(entry: TtsLogEntry): void;
}

export class InMemoryTtsLogger implements TtsLogger {
  readonly entries: TtsLogEntry[] = [];
  write(entry: TtsLogEntry): void { this.entries.push(entry); }
}

export class JsonConsoleTtsLogger implements TtsLogger {
  write(entry: TtsLogEntry): void { console.log(JSON.stringify(entry)); }
}

export const silentTtsLogger: TtsLogger = { write: () => undefined };

export function logEntry(
  logger: TtsLogger,
  level: TtsLogLevel,
  event: string,
  provider: string,
  extra: Omit<TtsLogEntry, 'timestamp' | 'level' | 'event' | 'provider'> = {},
): void {
  logger.write({ timestamp: new Date().toISOString(), level, event, provider, ...extra });
}
