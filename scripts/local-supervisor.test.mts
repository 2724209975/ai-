import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseLocalStack, rotatingStackLog } from './local-supervisor.mts';

test('supervisor starts in dependency order and stops in reverse before backing off and restarting', async () => {
  const controller = new AbortController(), trace: string[] = [], delays: number[] = []; let round = 0;
  await superviseLocalStack({ names: ['postgres', 'core', 'bridge'], signal: controller.signal,
    log: async () => {}, delay: async ms => { delays.push(ms); }, start: async name => {
      trace.push(`start:${name}`); if (name === 'postgres') round++;
      return { async ready() { trace.push(`ready:${name}`); if (round === 2 && name === 'bridge') controller.abort(); },
        exited: round === 1 && name === 'bridge' ? Promise.resolve() : new Promise(() => {}),
        async stop() { trace.push(`stop:${name}`); } };
    } });
  assert.deepEqual(trace.slice(0, 9), ['start:postgres', 'ready:postgres', 'start:core', 'ready:core', 'start:bridge', 'ready:bridge', 'stop:bridge', 'stop:core', 'stop:postgres']);
  assert.equal(round, 2); assert.deepEqual(delays, [1000]);
  assert.deepEqual(trace.slice(-3), ['stop:bridge', 'stop:core', 'stop:postgres']);
});

test('failed startup does not start dependents; backoff caps; stop failure prevents replacements', async () => {
  const controller = new AbortController(), names: string[] = [], delays: number[] = [];
  await superviseLocalStack({ names: ['postgres', 'core', 'bridge'], signal: controller.signal, log: async () => {},
    maxBackoffMs: 2000, delay: async ms => { delays.push(ms); if (delays.length === 3) controller.abort(); },
    start: async name => { names.push(name); return { ready: async () => { throw new Error('fixture'); }, exited: new Promise(() => {}), stop: async () => {} }; } });
  assert.deepEqual(names, ['postgres', 'postgres', 'postgres']); assert.deepEqual(delays, [1000, 2000, 2000]);
  let starts = 0;
  await assert.rejects(superviseLocalStack({ names: ['core'], signal: new AbortController().signal, log: async () => {},
    start: async () => { starts++; return { ready: async () => {}, exited: Promise.resolve(), stop: async () => { throw new Error('still alive'); } }; } }));
  assert.equal(starts, 1);
});

test('an earlier dependency exiting while bridge startup waits stops the entire owned stack', async () => {
  const controller = new AbortController(), trace: string[] = [], events: string[] = [];
  let exitPostgres!: () => void, bridgeWaiting!: () => void;
  const postgresExited = new Promise<void>(resolve => { exitPostgres = resolve; });
  const bridgeIsWaiting = new Promise<void>(resolve => { bridgeWaiting = resolve; });
  const running = superviseLocalStack({ names: ['postgres', 'core', 'bridge'], signal: controller.signal,
    log: async (event, service) => { events.push(service ? `${event}:${service}` : event); },
    start: async name => {
      trace.push(`start:${name}`);
      return { ready: async () => { if (name === 'bridge') { bridgeWaiting(); await new Promise<void>(() => {}); } },
        exited: name === 'postgres' ? postgresExited : new Promise<void>(() => {}),
        stop: async () => { trace.push(`stop:${name}`); if (name === 'postgres') controller.abort(); } };
    } });
  try {
    await bridgeIsWaiting; exitPostgres();
    // Fixture readiness has no timers or I/O: a completed cleanup must settle before the next event-loop turn.
    const stoppedWithoutAbort = await Promise.race([running.then(() => true), new Promise<boolean>(resolve => setImmediate(() => resolve(false)))]);
    assert.equal(stoppedWithoutAbort, true);
    assert.deepEqual(trace, ['start:postgres', 'start:core', 'start:bridge', 'stop:bridge', 'stop:core', 'stop:postgres']);
    assert.deepEqual(events.filter(event => event.startsWith('service_stopped:')), ['service_stopped:bridge', 'service_stopped:core', 'service_stopped:postgres']);
    assert.ok(!events.includes('stack_ready'));
  } finally { controller.abort(); await running; }
});

test('one stop failure still stops other owned dependencies and prevents every replacement', async () => {
  const trace: string[] = [], events: string[] = [];
  await assert.rejects(superviseLocalStack({ names: ['postgres', 'core', 'bridge'], signal: new AbortController().signal,
    log: async (event, service) => { events.push(service ? `${event}:${service}` : event); },
    start: async name => {
      trace.push(`start:${name}`);
      return { ready: async () => {}, exited: name === 'bridge' ? Promise.resolve() : new Promise<void>(() => {}),
        stop: async () => { trace.push(`stop:${name}`); if (name === 'bridge') throw new Error('private process detail'); } };
    } }), { message: 'STACK_STOP_FAILED' });
  assert.deepEqual(trace, ['start:postgres', 'start:core', 'start:bridge', 'stop:bridge', 'stop:core', 'stop:postgres']);
  assert.deepEqual(events.filter(event => event.startsWith('service_stopped:')), ['service_stopped:core', 'service_stopped:postgres']);
  assert.ok(!events.includes('stack_restart'));
});

test('rotating logs stay bounded and reject arbitrary output or identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stack-log-'));
  try {
    const log = rotatingStackLog(directory, 256, 2);
    await Promise.all(Array.from({ length: 50 }, () => log('service_ready', 'core')));
    await assert.rejects(log('private body')); await assert.rejects(log('stack_ready', 'private account'));
    const files = await readdir(directory); assert.equal(files.length, 3);
    for (const file of files) {
      assert.ok((await stat(join(directory, file))).size <= 256);
      for (const line of (await readFile(join(directory, file), 'utf8')).trim().split('\n')) assert.equal(JSON.parse(line).event, 'service_ready');
    }
    await log('service_stopped', 'postgres');
    const stopped = JSON.parse((await readFile(join(directory, 'stack.jsonl'), 'utf8')).trim().split('\n').at(-1)!);
    assert.equal(stopped.event, 'service_stopped'); assert.equal(stopped.service, 'postgres');
    await log('model_call', 'bridge', { inputTokens: 12, outputTokens: 3, elapsedMs: 45, outcome: 'ok', prompt: 'private body', accountId: 'private identity', secret: 'private key' });
    const lines = (await readFile(join(directory, 'stack.jsonl'), 'utf8')).trim().split('\n');
    const metric = JSON.parse(lines.at(-1)!); assert.equal(metric.inputTokens, 12); assert.equal(metric.outcome, 'ok');
    assert.ok(!JSON.stringify(metric).includes('private'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
