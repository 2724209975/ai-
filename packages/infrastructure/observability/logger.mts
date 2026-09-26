/** Structured JSON-line logger for the long-running runtime processes.
 *
 * Two rules keep platform content and credentials out of log files:
 *  - fields are flat scalars only; objects, arrays and errors are summarised, never serialised;
 *  - keys that name a credential, a body or a chat identifier are replaced with a marker, and
 *    oversized values are truncated.
 * The logger is deliberately total: a broken sink or an unserialisable line must never take a
 * runtime down, so every write is guarded.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;
export type LogSink = { write(chunk: string): unknown };
export type Logger = {
  readonly level: LogLevel;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
};
export type JsonLoggerOptions = {
  service: string;
  sink?: LogSink;
  now?: () => number;
  level?: LogLevel;
  bindings?: LogFields;
};

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
export const MAX_LOG_LINE_CHARS = 4096;
/** Values longer than this are replaced by their prefix and length, not by their full text. */
export const MAX_LOG_VALUE_CHARS = 400;
const REDACTED = '[redacted]';
const NOT_A_SCALAR = '[not-a-scalar]';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** Never log a credential, a session artefact or a platform identity. */
const SECRET_KEY = /(token|secret|password|passwd|credential|authorization|cookie|signature|api_?key|wxid|self_?ref|phone|email)/i;
/** Never log chat or model content, whatever the caller calls the field. */
const CONTENT_KEY = /^(content|body|text|message|messages|payload|raw|chat|prompt|reply|transcript|display_?name)$/i;
const RESERVED_KEYS = new Set(['ts', 'level', 'service', 'event']);

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

function sanitiseField(key: string, value: LogValue): LogValue {
  if (SECRET_KEY.test(key) || CONTENT_KEY.test(key)) return REDACTED;
  const type = typeof value;
  if (value === null || value === undefined) return value;
  if (type === 'number') return Number.isFinite(value as number) ? value : NOT_A_SCALAR;
  if (type === 'boolean') return value;
  const text = String(value);
  if (text.length > MAX_LOG_VALUE_CHARS) return `${text.slice(0, 40)}…(${text.length} chars)`;
  return text;
}

function sanitiseFields(fields: LogFields | undefined): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_KEYS.has(key)) continue;
    out[key] = sanitiseField(key, value);
  }
  return out;
}

export function createJsonLogger(options: JsonLoggerOptions): Logger {
  if (!options?.service) throw new Error('LOGGER_CONFIG_INVALID');
  const sink: LogSink = options.sink ?? process.stdout;
  const clock = options.now ?? Date.now;
  const level = options.level ?? 'info';
  if (!isLogLevel(level)) throw new Error('LOGGER_CONFIG_INVALID');
  const base = sanitiseFields(options.bindings);

  function emit(entryLevel: LogLevel, bindings: Record<string, LogValue>, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    if (!event || typeof event !== 'string') return;
    const line = { ts: new Date(clock()).toISOString(), level: entryLevel, service: options.service, event, ...bindings, ...sanitiseFields(fields) };
    let text: string;
    try {
      text = JSON.stringify(line);
    } catch {
      text = JSON.stringify({ ts: line.ts, level: entryLevel, service: options.service, event, serialisationFailed: true });
    }
    if (text.length > MAX_LOG_LINE_CHARS) {
      text = JSON.stringify({ ts: line.ts, level: entryLevel, service: options.service, event, truncated: true });
    }
    try { sink.write(`${text}\n`); } catch { /* logging must never break the caller */ }
  }

  return {
    level,
    debug: (event, fields) => emit('debug', base, event, fields),
    info: (event, fields) => emit('info', base, event, fields),
    warn: (event, fields) => emit('warn', base, event, fields),
    error: (event, fields) => emit('error', base, event, fields),
    child(bindings: LogFields) { return createJsonLogger({ ...options, level, sink, now: clock, bindings: { ...base, ...sanitiseFields(bindings) } }); },
  };
}

/** A sink that keeps lines in memory. Used by tests and by readiness diagnostics. */
export function createMemorySink(): LogSink & { lines(): string[]; entries(): Record<string, unknown>[] } {
  const lines: string[] = [];
  return {
    write(chunk: string) { lines.push(chunk); },
    lines: () => [...lines],
    entries: () => lines.flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } }),
  };
}
