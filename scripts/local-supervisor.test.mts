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
    await log('model_call', 'bridge', { inputTokens: 12, outputTokens: 3, elapsedMs: 45, outcome: 'ok', prompt: 'private body', accountId: 'private identity', secret: 'private key' });
    const lines = (await readFile(join(directory, 'stack.jsonl'), 'utf8')).trim().split('\n');
    const metric = JSON.parse(lines.at(-1)!); assert.equal(metric.inputTokens, 12); assert.equal(metric.outcome, 'ok');
    assert.ok(!JSON.stringify(metric).includes('private'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
