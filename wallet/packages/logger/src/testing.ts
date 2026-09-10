import { createLogger, type LogLevel, type Logger, type LogSink } from './logger.js';

export interface CapturedLogger {
  readonly logger: Logger;
  /** Each emitted line, parsed. */
  readonly entries: () => ReadonlyArray<Record<string, unknown>>;
  /** Everything written, concatenated — for `expect(text()).not.toContain(secret)`. */
  readonly text: () => string;
  readonly clear: () => void;
}

/**
 * Capture helper required by prompt_phase1.md rule 78, so redaction can be
 * asserted rather than assumed. Used by the rule 175 leak test.
 */
export function createCapturingLogger(level: LogLevel = 'trace'): CapturedLogger {
  const lines: string[] = [];
  const sink: LogSink = { write: (line) => void lines.push(line) };

  return {
    logger: createLogger({ level, sink }),
    entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    text: () => lines.join('\n'),
    clear: () => void (lines.length = 0),
  };
}
