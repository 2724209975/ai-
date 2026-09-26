/** Unit tests for the structured logger: shape, redaction and total-failure behaviour. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonLogger, createMemorySink, MAX_LOG_VALUE_CHARS } from './logger.mts';

const at = Date.parse('2026-09-26T10:00:00.000Z');
const fixedClock = () => at;

test('log lines are single-line JSON with the service, event and injected clock', () => {
  const sink = createMemorySink();
  const logger = createJsonLogger({ service: 'core', sink, now: fixedClock });
  logger.info('runtime_ready', { port: 8787, startPaused: true });
  logger.warn('worker_slow', { phase: 'collect' });
  assert.equal(sink.lines().length, 2);
  for (const line of sink.lines()) {
    assert.ok(line.endsWith('\n'), 'every entry is newline-terminated');
    assert.ok(!line.trimEnd().includes('\n'), 'one entry per line');
  }
  const [first, second] = sink.entries();
  assert.deepEqual(first, { ts: '2026-09-26T10:00:00.000Z', level: 'info', service: 'core', event: 'runtime_ready', port: 8787, startPaused: true });
  assert.equal(second?.['level'], 'warn');
  assert.equal(second?.['event'], 'worker_slow');
});

test('credential, body and chat-identity fields never reach the sink', () => {
  const sink = createMemorySink();
  const logger = createJsonLogger({ service: 'core', sink, now: fixedClock });
  const secret = ['shared', 'bridge', 'key'].join('-');
  logger.info('config_loaded', {
    databaseUrl: 'postgres://owner@127.0.0.1:55418/chat_agent',
    bridgeToken: secret,
    ownerPasswordHash: 'scrypt$fake',
    sessionCookie: 'cookie-value',
    content: '你好，今晚有空吗',
    message: 'sample inbound text',
    wxid: 'wxid_example',
    displayName: '张三',
  });
  const raw = sink.lines().join('');
  for (const forbidden of [secret, 'scrypt$fake', 'cookie-value', '你好，今晚有空吗', 'sample inbound text', 'wxid_example', '张三']) {
    assert.ok(!raw.includes(forbidden), `log leaked ${forbidden}`);
  }
  // A connection string is not a credential by itself, but the user name and host still must not
  // be paired with a password; the field name is what the redactor keys on, so `databaseUrl` stays.
  assert.equal(sink.entries()[0]?.['bridgeToken'], '[redacted]');
  assert.equal(sink.entries()[0]?.['content'], '[redacted]');
});

test('child bindings are inherited, redacted and cannot overwrite the reserved envelope', () => {
  const sink = createMemorySink();
  const logger = createJsonLogger({ service: 'core', sink, now: fixedClock, bindings: { instance: 'core-1' } });
  const child = logger.child({ requestId: 'req-12345678' });
  child.error('request_failed', { level: 'debug', event: 'forged', service: 'other', status: 503 });
  const entry = sink.entries()[0]!;
  assert.equal(entry['instance'], 'core-1');
  assert.equal(entry['requestId'], 'req-12345678');
  assert.equal(entry['level'], 'error');
  assert.equal(entry['event'], 'request_failed');
  assert.equal(entry['service'], 'core');
  assert.equal(entry['status'], 503);
});

test('the configured level suppresses quieter entries and rejects an unknown level', () => {
  const sink = createMemorySink();
  const logger = createJsonLogger({ service: 'core', sink, now: fixedClock, level: 'warn' });
  logger.debug('ignored');
  logger.info('ignored');
  logger.warn('kept');
  assert.deepEqual(sink.entries().map(entry => entry['event']), ['kept']);
  assert.throws(() => createJsonLogger({ service: 'core', sink, level: 'verbose' as never }), { message: 'LOGGER_CONFIG_INVALID' });
  assert.throws(() => createJsonLogger({ service: '' }), { message: 'LOGGER_CONFIG_INVALID' });
});

test('oversized values and oversized lines are summarised instead of written whole', () => {
  const sink = createMemorySink();
  const logger = createJsonLogger({ service: 'core', sink, now: fixedClock });
  const long = 'x'.repeat(MAX_LOG_VALUE_CHARS + 1);
  logger.info('value_summary', { note: long });
  assert.ok(!sink.lines()[0]!.includes(long));
  assert.match(String(sink.entries()[0]?.['note']), /\(401 chars\)$/);

  const bulky = createMemorySink();
  const bulkyLogger = createJsonLogger({ service: 'core', sink: bulky, now: fixedClock });
  const fields: Record<string, string> = {};
  for (let index = 0; index < 60; index++) fields[`field${index}`] = 'y'.repeat(300);
  bulkyLogger.info('line_summary', fields);
  assert.equal(bulky.entries()[0]?.['truncated'], true);
});

test('a throwing sink is contained and non-scalar values are marked', () => {
  const logger = createJsonLogger({ service: 'core', now: fixedClock, sink: { write() { throw new Error('EPIPE'); } } });
  assert.doesNotThrow(() => logger.error('sink_broken'));
  const sink = createMemorySink();
  createJsonLogger({ service: 'core', sink, now: fixedClock }).info('odd_value', { ratio: Number.NaN });
  assert.equal(sink.entries()[0]?.['ratio'], '[not-a-scalar]');
});
