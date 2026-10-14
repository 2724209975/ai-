import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseLocalStack, rotatingStackLog } from './local-supervisor.mts';

test('a bridge restart leaves its sibling and dependencies running', async () => {
  const controller=new AbortController(), starts:string[]=[], stops:string[]=[];
  let qqStarts=0, exitQq!:()=>void, wechatReady!:()=>void;
  const qqExit=new Promise<void>(resolve=>{exitQq=resolve;});
  const wechatStarted=new Promise<void>(resolve=>{wechatReady=resolve;});
  const run=superviseLocalStack({ names:['postgres','core','bridge-qq','bridge-wechat'],isolatedServices:['bridge-qq','bridge-wechat'],signal:controller.signal,
    log:async()=>{},delay:async()=>{},start:async name=>{
      starts.push(name); if(name==='bridge-qq') qqStarts++;
      return { ready:async()=>{if(name==='bridge-wechat') wechatReady();if(name==='bridge-qq' && qqStarts===2) controller.abort();},
        exited:name==='bridge-qq' && qqStarts===1 ? qqExit : new Promise<void>(()=>{}),stop:async()=>{stops.push(name);} };
    } });
  await wechatStarted; exitQq(); await run;
  assert.equal(starts.filter(n=>n==='postgres').length,1);
  assert.equal(starts.filter(n=>n==='core').length,1);
  assert.equal(starts.filter(n=>n==='bridge-wechat').length,1);
  assert.equal(qqStarts,2);
  assert.equal(stops[0],'bridge-qq');
  assert.deepEqual(stops.slice(-2),['core','postgres']);
});

test('dependency exit cancels a stalled independent bridge before restarting roots', async () => {
  const controller=new AbortController(),stops:string[]=[];let exitCore!:()=>void,waiting!:()=>void;
  const coreExit=new Promise<void>(resolve=>{exitCore=resolve;}),bridgeWaiting=new Promise<void>(resolve=>{waiting=resolve;});
  const running=superviseLocalStack({names:['postgres','core','bridge-qq'],isolatedServices:['bridge-qq'],signal:controller.signal,log:async()=>{},
    start:async name=>({ready:async()=>{if(name==='bridge-qq'){waiting();await new Promise<void>(()=>{});}},exited:name==='core' ? coreExit : new Promise<void>(()=>{}),
      stop:async()=>{stops.push(name);if(name==='postgres')controller.abort();}}) });
  await bridgeWaiting;exitCore();await running;assert.deepEqual(stops,['bridge-qq','core','postgres']);
});

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

test('media model observations survive the local stack log without identity, body or provider metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stack-media-log-'));
  try {
    const log = rotatingStackLog(directory);
    await log('media_model_call', 'bridge', { callId: '00000000-0000-4000-8000-000000000001',
      contextSnapshotId: '00000000-0000-4000-8000-000000000002', mediaType: 'image',
      outcome: 'uncertain', inputTokens: 12, outputTokens: null, elapsedMs: 23,
      providerId: 'PRIVATE_PROVIDER', modelId: 'PRIVATE_MODEL', text: 'PRIVATE_BODY', secret: 'PRIVATE_SECRET' });
    const row = JSON.parse((await readFile(join(directory, 'stack.jsonl'), 'utf8')).trim());
    assert.equal(row.event, 'media_model_call'); assert.equal(row.mediaType, 'image');
    assert.equal(row.outcome, 'uncertain'); assert.equal(row.inputTokens, 12);
    assert.equal(row.callId, '00000000-0000-4000-8000-000000000001');
    assert.equal(row.outputTokens, undefined); assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  } finally { await rm(directory, { recursive: true, force: true }); }
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
