import { getContext } from './context.js';
import { sanitizeFields, type LogFields } from './sanitize.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LogSink {
  write(line: string): void;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly sink?: LogSink;
  /** Merged into every line; sanitized like any other fields. */
  readonly base?: LogFields;
  readonly clock?: () => Date;
}

export interface Logger {
  readonly level: LogLevel;
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const stdoutSink: LogSink = {
  write: (line) => {
    process.stdout.write(line + '\n');
  },
};

/**
 * Structured JSON only — there is no pretty-print mode and no `console` path
 * (rule 68). Every line is one JSON object on one line.
 *
 * Written by hand rather than wrapping pino because the redaction guarantee in
 * ./sanitize.ts is the whole point of this package, and it is worth being able
 * to read the entire path from call site to output stream in one sitting
 * (master-prompt rules 198-199).
 */
export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? stdoutSink;
  const clock = options.clock ?? (() => new Date());
  const threshold = LEVEL_RANK[options.level];
  const base = sanitizeFields(options.base).fields;

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < threshold) return;

    const context = getContext();
    const { fields: safe, droppedFields } = sanitizeFields(fields);

    const line: Record<string, unknown> = {
      time: clock().toISOString(),
      level,
      msg: message,
      ...base,
      // Context wins over caller-supplied values: a call site cannot spoof the
      // correlation ID or claim to be a different user.
      ...safe,
      ...(context
        ? {
            correlationId: context.correlationId,
            ...(context.userId !== undefined ? { userId: context.userId } : {}),
            ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
            ...(context.method !== undefined ? { method: context.method } : {}),
            ...(context.route !== undefined ? { route: context.route } : {}),
          }
        : {}),
    };

    if (droppedFields > 0) line.droppedFields = droppedFields;

    sink.write(JSON.stringify(line));
  }

  const logger: Logger = {
    level: options.level,
    trace: (m, f) => emit('trace', m, f),
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    fatal: (m, f) => emit('fatal', m, f),
    child: (fields) =>
      createLogger({
        level: options.level,
        sink,
        base: { ...options.base, ...fields },
        clock,
      }),
  };

  return logger;
}
