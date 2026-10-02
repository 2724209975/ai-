/** Real child processes + a new isolated PG cluster; all platform/model traffic is synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLocalStackDriver, readLocalStackConfig, pgExecutable, type LocalStackConfig } from '../../scripts/local-stack-driver.mts';
import { superviseLocalStack, rotatingStackLog } from '../../scripts/local-supervisor.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { createPgPersistentFakeIntelligence } from '../../packages/ai/index.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';

const enabled = process.env.TEST_DATABASE_URL || process.env.CI;
const settings = { skip: !enabled && 'set TEST_DATABASE_URL and LOCAL_TEST_PG_BIN for isolated process rehearsal', timeout: 90_000 };
const passwordHash = 'scrypt$N=32768,r=8,p=1$Y29yZS1ydW50aW1lLXRlc3Q=$Y29yZS1ydW50aW1lLXRlc3QtaGFzaC12YWx1ZQ==';
function alive(child: ChildProcess) { return child.pid !== undefined && child.exitCode === null && child.signalCode === null; }
async function until(check: () => boolean | Promise<boolean>, code: string, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(40); }
  throw new Error(code);
}
async function port() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(done => server.close(() => done())); return address.port;
}
async function environment() {
  const bin = process.env.LOCAL_TEST_PG_BIN || (process.env.PG_DUMP_BIN && /pg_dump(?:\.exe)?$/.test(process.env.PG_DUMP_BIN) ? dirname(resolve(process.env.PG_DUMP_BIN)) : '');
  if (!bin) throw new Error('LOCAL_TEST_PG_BIN_REQUIRED');
  await access(pgExecutable(bin, 'initdb'));
  const root = await mkdtemp(join(tmpdir(), 'chat-agent-stack-')), data = join(root, 'data');
  const init = spawnSync(pgExecutable(bin, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C'], { windowsHide: true, encoding: 'utf8' });
  if (init.error || init.status !== 0) throw new Error('ISOLATED_INITDB_FAILED');
  const ports = new Set<number>(); while (ports.size < 3) ports.add(await port());
  const [pgPort, corePort, bridgePort] = [...ports];
  const env = { ...process.env, NODE_ENV: 'test', LOCAL_STACK_FIXTURE: '1', LOCAL_PG_BIN: resolve(bin), LOCAL_PG_DATA: data,
    DATABASE_URL: `postgres://postgres@127.0.0.1:${pgPort}/postgres`, PUBLIC_ORIGIN: `http://127.0.0.1:${corePort}`,
    LOCAL_BRIDGE_PORT: String(bridgePort), OWNER_ID: randomUUID(), OWNER_PASSWORD_HASH: passwordHash,
    WECHAT_ACCOUNT_ID: randomUUID(), WECHAT_SELF_REF: 'fixture_self', WECHAT_INGRESS_TOKEN: randomBytes(32).toString('hex'), WECHAT_PROCESS_ID: String(process.pid),
    INTELLIGENCE_PROVIDER: 'persistent-fake', WECHAT_INTELLIGENCE: 'persistent-fake', WECHAT_ENABLE_OUTBOUND: '0', START_PAUSED: '0',
    SESSION_DIR: join(root, 'sessions'), RAW_EVENT_DIR: join(root, 'raw'), WEB_BUILD_DIR: resolve('apps/web/build'),
    FIXTURE_CONTROL_TOKEN: randomBytes(32).toString('hex'), FIXTURE_ENABLE_OUTBOUND: '1', FIXTURE_WORKER_ENABLED: '0',
    WORKER_INTERVAL_MS: '100', OUTBOX_INTERVAL_MS: '100', SKILL_OUTBOX_INTERVAL_MS: '100', FIXTURE_TIMEOUT_MS: '1000' };
  for (const key of Object.keys(env)) if (key.startsWith('DEEPSEEK_') || key.startsWith('PG')) delete (env as Record<string, string | undefined>)[key];
  return { root, env };
}
async function cleanupRoot(root: string) {
  if (!resolve(root).startsWith(resolve(join(tmpdir(), 'chat-agent-stack-')))) throw new Error('UNEXPECTED_REHEARSAL_PATH');
  await rm(root, { recursive: true, force: true });
}
async function helper(env: Record<string, string | undefined>) {
  const child = fork(resolve('tests/fixtures/local-stack-helper.mts'), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...env, PORT: '0' } });
  let address: { port: number; pid: number } | undefined;
  child.on('message', message => { const value = message as { type?: string; port: number; pid: number }; if (value.type === 'fixture-ready') address = value; });
  try { await until(() => Boolean(address), 'HELPER_START_FAILED', 8000); }
  catch (error) { child.kill('SIGTERM'); throw error; }
  return { child, url: `http://127.0.0.1:${address!.port}/`, pid: address!.pid };
}
async function stopHelper(child: ChildProcess) {
  if (alive(child)) child.send({ type: 'fixture-stop' });
  await until(() => !alive(child), 'HELPER_STOP_FAILED', 5000);
}
async function state(url: string, token: string) {
  const response = await fetch(new URL('fixture/state', url), { headers: { 'x-fixture-token': token }, signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200); return await response.json() as { sendCalls: number; checkLoginCalls: number };
}
function service(pool: any, accountId: string) {
  const data = new PgDataProvider(), authority = {}, platform = new MockPlatformAdapter({ platform: 'wechat', accountId, authority });
  platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
  return new PgConfirmedService({ pool, data, intelligence: createPgPersistentFakeIntelligence({ pool, data }), platform, authority });
}
async function poolFor(config: LocalStackConfig) {
  const { Pool } = await import('pg'); const pool = new Pool({ connectionString: config.databaseUrl, max: 3 });
  pool.on('error', () => {}); return pool;
}
async function noProcesses(children: ChildProcess[]) { await until(() => children.every(child => !alive(child)), 'CHILD_LEAK', 5000); }
function pidExists(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }

test('native stack: ordered boot, killed core/bridge and immediate PG shutdown restart paused without send replay', settings, async () => {
  const setup = await environment(), simulator = await helper(setup.env);
  const config = await readLocalStackConfig({ ...setup.env, FIXTURE_HELPER_URL: simulator.url, FIXTURE_PROCESS_ID: String(simulator.pid) });
  const controller = new AbortController(), trace: { event: string; name?: string }[] = [], children: { name: string; child: ChildProcess }[] = [];
  const sink = rotatingStackLog(join(setup.root, 'logs'));
  const log = async (event: string, name?: string, measurement?: Record<string, unknown>) => { trace.push({ event, name }); await sink(event, name, measurement); };
  const driver = createLocalStackDriver({ config, signal: controller.signal, log,
    entries: { bridge: resolve('tests/fixtures/local-stack-bridge.mts') }, onSpawn: (name, child) => children.push({ name, child }) });
  let running: Promise<void> | undefined, pool: Awaited<ReturnType<typeof poolFor>> | undefined;
  const databaseProcesses = new Set<number>();
  const rememberDatabaseProcesses = async () => { for (const row of (await pool!.query('SELECT pid FROM pg_stat_activity')).rows) databaseProcesses.add(row.pid); };
  const contactId = randomUUID(), conversationId = randomUUID(), externalContactRef = 'fixture_peer';
  try {
    // Seed an enrolled contact before boot, using the same owned PostgreSQL driver.
    const seed = await driver.start('postgres'); await seed.ready(); pool = await poolFor(config);
    await withTransaction(pool, async tx => { await setContactScope(tx, contactId);
      await new PgDataProvider().createContact(tx, { id: contactId, conversationId, platformAccountId: config.env.WECHAT_ACCOUNT_ID!, externalContactRef, displayName: '合成联系人', enrollmentStatus: 'enrolled' }); });
    await service(pool, config.env.WECHAT_ACCOUNT_ID!).enrollContact({ contactId, conversationId, accountId: config.env.WECHAT_ACCOUNT_ID!, externalContactRef, timezone: 'Asia/Shanghai', goal: '普通聊天' });
    await pool.end(); pool = undefined; await seed.stop();
    running = superviseLocalStack({ names: ['postgres', 'core', 'bridge'], start: async name => {
      try { return await driver.start(name); }
      catch (error) {
        const code = (error as Error).message;
        trace.push({ event: ['LOCAL_CLUSTER_IN_USE', 'LOCAL_PORT_IN_USE', 'LOCAL_STOPPED'].includes(code) ? code : 'LOCAL_START_ERROR', name });
        throw error;
      }
    }, signal: controller.signal, log, backoffMs: 100, maxBackoffMs: 500 });
    void running.catch(() => {});
    const readyCount = () => trace.filter(item => item.event === 'stack_ready').length;
    await until(() => readyCount() >= 1, 'STACK_NOT_READY');
    assert.deepEqual(trace.filter(item => item.event === 'service_ready').map(item => item.name), ['postgres', 'core', 'bridge']);
    pool = await poolFor(config); let control = service(pool, config.env.WECHAT_ACCOUNT_ID!);
    await rememberDatabaseProcesses();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 12);
    assert.equal((await control.ownerOverview()).globalPaused, true, 'driver overrides START_PAUSED=0');
    assert.ok((await control.getConversation(conversationId)).control.pauseReasons.includes('ACCOUNT_FAULT'));
    assert.equal((await fetch(`${config.env.PUBLIC_ORIGIN}/api/v1/overview`)).status, 401);
    const resume = async () => {
      await control.resumeAll({ expectedVersion: (await control.ownerOverview()).version, idempotencyKey: randomUUID() });
      await control.resumeContact(contactId, { expectedVersion: (await control.ownerContacts()).items.find(item => item.id === contactId)!.version, reason: 'ACCOUNT_FAULT', idempotencyKey: randomUUID() });
    };
    const inbound = async () => {
      const messageId = String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));
      const response = await fetch(`http://127.0.0.1:${config.bridgePort}/wxhelper/event?token=${config.env.WECHAT_INGRESS_TOKEN}`, { method: 'POST',
        body: JSON.stringify({ fromUser: externalContactRef, toUser: config.env.WECHAT_SELF_REF, msgId: messageId, msgSequence: 1, createTime: Math.floor(Date.now() / 1000), type: 1, content: '合成演练来信' }) });
      assert.equal(response.status, 200);
      await until(async () => (await control.ownerTasks()).items.some(item => item.allowedActions.includes('confirmPlan')), 'NO_CANDIDATE');
      const task = (await control.ownerTasks()).items.find(item => item.allowedActions.includes('confirmPlan'))!, alternative = task.alternatives[0]!;
      const editedParts = alternative.parts.map(part => ({ type: 'text' as const, content: part.content }));
      await control.confirmTask(task.taskId, { taskVersion: task.taskVersion, planVersion: task.planVersion, alternativeId: alternative.alternativeId,
        editedParts, contentHash: contentHash(editedParts), idempotencyKey: randomUUID() });
      return task.planId;
    };
    await resume(); const queuedPlan = await inbound();
    assert.equal((await pool.query('SELECT status FROM orch_send_tasks WHERE plan_id=$1', [queuedPlan])).rows[0].status, 'CREATED');
    assert.equal((await state(simulator.url, setup.env.FIXTURE_CONTROL_TOKEN)).sendCalls, 0);
    config.env.FIXTURE_WORKER_ENABLED = '1';
    const crash = async (name: string, expectedReady: number) => {
      await pool!.end(); pool = undefined;
      const current = children.filter(item => item.name === name).at(-1)!.child; assert.ok(alive(current));
      if (name === 'postgres') {
        // PostgreSQL's immediate shutdown terminates its backend tree and leaves WAL for crash recovery.
        // Killing just the postmaster on Windows can leave connection cleanup unresolved; that path is not certified here.
        const pid = Number((await readFile(join(config.data, 'postmaster.pid'), 'utf8')).split(/\r?\n/)[0]); assert.equal(pid, current.pid);
        const stopped = spawnSync(pgExecutable(config.bin, 'pg_ctl'), ['-D', config.data, 'stop', '-m', 'immediate', '-w'], { windowsHide: true });
        assert.equal(stopped.status, 0);
      } else current.kill('SIGKILL');
      await until(() => readyCount() >= expectedReady, `STACK_RESTART_FAILED:${name}`)
        .catch(() => { throw new Error(`STACK_RESTART_FAILED:${name}:${JSON.stringify(trace.slice(-20))}`); });
      pool = await poolFor(config); control = service(pool, config.env.WECHAT_ACCOUNT_ID!);
      await rememberDatabaseProcesses();
      assert.equal((await control.ownerOverview()).globalPaused, true);
      assert.ok((await control.getConversation(conversationId)).control.pauseReasons.includes('ACCOUNT_FAULT'));
    };
    await crash('bridge', 2);
    assert.equal((await pool!.query('SELECT status FROM orch_send_tasks WHERE plan_id=$1', [queuedPlan])).rows[0].status, 'CANCELLED_PRE_SUBMIT');
    assert.equal((await state(simulator.url, setup.env.FIXTURE_CONTROL_TOKEN)).sendCalls, 0);
    await resume(); await sleep(250); assert.equal((await state(simulator.url, setup.env.FIXTURE_CONTROL_TOKEN)).sendCalls, 0);
    const unknownPlan = await inbound();
    await until(async () => (await state(simulator.url, setup.env.FIXTURE_CONTROL_TOKEN)).sendCalls === 1, 'NO_FIXTURE_SUBMIT');
    await until(async () => (await pool!.query('SELECT status FROM orch_send_tasks WHERE plan_id=$1', [unknownPlan])).rows.some(row => row.status === 'RESULT_UNKNOWN'), 'NO_UNKNOWN_LEDGER');
    await crash('core', 3); await crash('postgres', 4);
    assert.equal((await pool!.query('SELECT status FROM orch_send_tasks WHERE plan_id=$1', [unknownPlan])).rows[0].status, 'RESULT_UNKNOWN');
    assert.equal((await state(simulator.url, setup.env.FIXTURE_CONTROL_TOKEN)).sendCalls, 1, 'unknown sends are never retried after process crashes');
    await assert.rejects(control.resumeContact(contactId, { expectedVersion: (await control.ownerContacts()).items.find(item => item.id === contactId)!.version,
      reason: 'ACCOUNT_FAULT', idempotencyKey: randomUUID() }), { message: 'SEND_RESULT_UNKNOWN' });
    await pool!.end(); pool = undefined; controller.abort(); await running;
    await noProcesses(children.map(item => item.child));
    await until(() => [...databaseProcesses].every(pid => !pidExists(pid)), 'DATABASE_DESCENDANT_LEAK', 5000);
    assert.deepEqual(trace.filter(item => item.event === 'service_stopped').slice(-3).map(item => item.name), ['bridge', 'core', 'postgres']);
    const length = children.length; await sleep(200); assert.equal(children.length, length, 'manual stop does not restart');
    const privateLog = await readFile(join(setup.root, 'logs/stack.jsonl'), 'utf8');
    for (const secret of [setup.env.WECHAT_INGRESS_TOKEN, setup.env.FIXTURE_CONTROL_TOKEN, setup.env.WECHAT_SELF_REF, externalContactRef, '合成演练来信', setup.root]) assert.ok(!privateLog.includes(secret));
  } finally {
    controller.abort(); await pool?.end(); await running?.catch(() => {});
    for (const { child } of children) if (alive(child)) child.kill('SIGTERM');
    await noProcesses(children.map(item => item.child)); await stopHelper(simulator.child); await cleanupRoot(setup.root);
  }
});

test('native driver refuses occupied ports and an external cluster on a different port without stopping either', settings, async () => {
  const setup = await environment(), config = await readLocalStackConfig(setup.env), controller = new AbortController();
  const foreignServer = createServer(); await new Promise<void>(done => foreignServer.listen(config.corePort, '127.0.0.1', done));
  const children: ChildProcess[] = [], stopped: string[] = [];
  const log = async (event: string, name?: string) => { if (event === 'stack_fault') controller.abort(); if (event === 'service_stopped') stopped.push(name!); };
  const driver = createLocalStackDriver({ config, signal: controller.signal, log, onSpawn: (_, child) => children.push(child) });
  let foreignPostgres: ChildProcess | undefined;
  try {
    await superviseLocalStack({ names: ['postgres', 'core', 'bridge'], start: driver.start, signal: controller.signal, log });
    assert.equal(children.length, 1); assert.deepEqual(stopped, ['postgres']); assert.ok(foreignServer.listening);
    await noProcesses(children);
    const foreignPort = await port();
    foreignPostgres = spawn(pgExecutable(config.bin, 'postgres'), ['-D', config.data, '-p', String(foreignPort), '-c', 'listen_addresses=127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
    const { Client } = await import('pg');
    const ping = async () => { const client = new Client({ connectionString: `postgres://postgres@127.0.0.1:${foreignPort}/postgres`, connectionTimeoutMillis: 500 });
      client.on('error', () => {}); try { await client.connect(); await client.query('SELECT 1'); return true; } catch { return false; } finally { await client.end().catch(() => {}); } };
    await until(ping, 'EXTERNAL_PG_NOT_READY');
    await assert.rejects(readLocalStackConfig(setup.env), { message: 'LOCAL_CLUSTER_IN_USE' });
    const fresh = createLocalStackDriver({ config, signal: new AbortController().signal, log: async () => {} });
    await assert.rejects(fresh.start('postgres'), { message: 'LOCAL_CLUSTER_IN_USE' });
    assert.ok(alive(foreignPostgres)); assert.equal(await ping(), true, 'no pg_ctl command targets the foreign postmaster');
  } finally {
    await new Promise<void>(done => foreignServer.close(() => done()));
    if (foreignPostgres && alive(foreignPostgres)) {
      const pid = Number((await readFile(join(config.data, 'postmaster.pid'), 'utf8')).split(/\r?\n/)[0]);
      assert.equal(pid, foreignPostgres.pid);
      const result = spawnSync(pgExecutable(config.bin, 'pg_ctl'), ['-D', config.data, 'stop', '-m', 'fast', '-w'], { windowsHide: true }); assert.equal(result.status, 0);
      await noProcesses([foreignPostgres]);
    }
    await cleanupRoot(setup.root);
  }
});

test('native driver cancels and reaps a pending migration before stopping its database', settings, async () => {
  const setup = await environment(), config = await readLocalStackConfig(setup.env), commands: ChildProcess[] = [], children: ChildProcess[] = [];
  const driver = createLocalStackDriver({ config, signal: new AbortController().signal, log: async () => {}, startupMs: 5000,
    entries: { migrate: resolve('tests/fixtures/local-stack-wait.mts') }, onCommandSpawn: child => commands.push(child), onSpawn: (_, child) => children.push(child) });
  let owned: Awaited<ReturnType<typeof driver.start>> | undefined;
  try {
    owned = await driver.start('postgres'); const pending = owned.ready(); void pending.catch(() => {});
    await until(() => commands.length >= 1 && alive(commands[0]!), 'MIGRATION_NOT_STARTED', 5000);
    await owned.stop(); await assert.rejects(pending); await noProcesses([...children, ...commands]);
    assert.ok(commands.length >= 1, 'this was a real startup subprocess');
  } finally { await owned?.stop(); await noProcesses([...children, ...commands]); await cleanupRoot(setup.root); }
});

test('native watchdog: helper login loss, timeout and process exit pause the account until manual recovery', settings, async () => {
  const setup = await environment();
  setup.env.FIXTURE_ENABLE_OUTBOUND = '0'; setup.env.FIXTURE_WORKER_ENABLED = '0';
  const env = { ...setup.env, FIXTURE_QUIET_MS: '200', FIXTURE_TIMEOUT_MS: '150', FIXTURE_WATCHDOG_INTERVAL_MS: '40' };
  const simulator = await helper(env);
  const config = await readLocalStackConfig({ ...env, FIXTURE_HELPER_URL: simulator.url, FIXTURE_PROCESS_ID: String(simulator.pid) });
  const controller = new AbortController(), children: ChildProcess[] = [], trace: { event: string; name?: string }[] = [];
  const log = async (event: string, name?: string) => { trace.push({ event, name }); };
  const driver = createLocalStackDriver({ config, signal: controller.signal, log,
    entries: { bridge: resolve('tests/fixtures/local-stack-bridge.mts') }, onSpawn: (_, child) => children.push(child) });
  let running: Promise<void> | undefined, pool: Awaited<ReturnType<typeof poolFor>> | undefined;
  const contactId = randomUUID(), conversationId = randomUUID(), accountId = config.env.WECHAT_ACCOUNT_ID!, externalContactRef = 'fixture_watchdog_peer';
  try {
    running = superviseLocalStack({ names: ['postgres', 'core', 'bridge'], start: driver.start, signal: controller.signal, log, backoffMs: 100, maxBackoffMs: 500 });
    void running.catch(() => {});
    await until(() => trace.some(item => item.event === 'stack_ready'), 'WATCHDOG_STACK_NOT_READY');
    assert.equal(children.length, 3, 'PostgreSQL, production core and fixture bridge are actual native children');
    pool = await poolFor(config); const control = service(pool, accountId);
    await withTransaction(pool, async tx => { await setContactScope(tx, contactId);
      await new PgDataProvider().createContact(tx, { id: contactId, conversationId, platformAccountId: accountId, externalContactRef,
        displayName: '合成看门狗联系人', enrollmentStatus: 'enrolled' }); });
    await control.enrollContact({ contactId, conversationId, accountId, externalContactRef, timezone: 'Asia/Shanghai', goal: '普通聊天' });
    const health = async () => (await pool!.query('SELECT healthy,fault_code FROM orch_account_health WHERE account_id=$1', [accountId])).rows[0] as { healthy: boolean; fault_code: string };
    const isHeld = async () => (await control.getConversation(conversationId)).control.pauseReasons.includes('ACCOUNT_FAULT');
    const bridgeHealth = async () => {
      const response = await fetch(`http://127.0.0.1:${config.bridgePort}/healthz`, { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      const result = await response.json() as { mode: string; worker: string; watchdog: { status: string; code?: string } };
      assert.equal(result.mode, 'receive-only'); assert.equal(result.worker, 'disabled'); return result;
    };
    const setMode = async (mode: 'healthy' | 'login-abnormal' | 'unresponsive') => {
      const response = await fetch(new URL('fixture/control', simulator.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-token': env.FIXTURE_CONTROL_TOKEN },
        body: JSON.stringify({ mode }), signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200); await response.body?.cancel();
    };
    const manuallyResumeAccount = async () => {
      await control.resumeContact(contactId, { expectedVersion: (await control.ownerContacts()).items.find(item => item.id === contactId)!.version,
        reason: 'ACCOUNT_FAULT', idempotencyKey: randomUUID() });
      assert.equal(await isHeld(), false);
    };
    const expectFault = async (code: 'HOOK_LOGIN_ABNORMAL' | 'HELPER_UNRESPONSIVE' | 'PROCESS_EXITED') => {
      await until(async () => { const value = await health(); return value?.healthy === false && value.fault_code === code && await isHeld(); }, `WATCHDOG_NO_${code}`);
      assert.equal((await bridgeHealth()).watchdog.code, code);
      const overview = await control.ownerOverview();
      assert.equal(overview.faultQueryStatus, 'ready'); assert.equal(overview.faults[0]?.status, 'ACTIVE');
      assert.equal(overview.globalPaused, false, 'an account fault holds the account through its own pause reason');
      await assert.rejects(control.resumeContact(contactId, { expectedVersion: (await control.ownerContacts()).items.find(item => item.id === contactId)!.version,
        reason: 'ACCOUNT_FAULT', idempotencyKey: randomUUID() }), { message: 'POLICY_BLOCKED' });
      assert.equal(await isHeld(), true);
    };
    const recoverProbeOnly = async () => {
      await setMode('healthy');
      await until(async () => (await health())?.healthy === true && (await bridgeHealth()).watchdog.status === 'healthy', 'WATCHDOG_NO_HEALTHY_RECOVERY');
      await sleep(120);
      assert.equal(await isHeld(), true, 'successful native probes never clear ACCOUNT_FAULT');
      assert.equal((await control.ownerOverview()).faults[0]?.status, 'RECOVERED_AWAITING_OWNER');
      assert.equal((await state(simulator.url, env.FIXTURE_CONTROL_TOKEN)).sendCalls, 0);
      await manuallyResumeAccount();
    };
    await until(async () => (await health())?.healthy === true, 'WATCHDOG_START_NOT_HEALTHY');
    assert.equal((await control.ownerOverview()).globalPaused, true);
    await control.resumeAll({ expectedVersion: (await control.ownerOverview()).version, idempotencyKey: randomUUID() });
    // A contact enrolled after the first healthy startup probe may have no account hold to clear.
    if (await isHeld()) await manuallyResumeAccount();
    assert.equal(await isHeld(), false); assert.equal((await bridgeHealth()).watchdog.status, 'healthy');
    await setMode('login-abnormal'); await expectFault('HOOK_LOGIN_ABNORMAL'); await recoverProbeOnly();
    await setMode('unresponsive'); await expectFault('HELPER_UNRESPONSIVE'); await recoverProbeOnly();
    assert.equal((await state(simulator.url, env.FIXTURE_CONTROL_TOKEN)).sendCalls, 0);
    await stopHelper(simulator.child); await expectFault('PROCESS_EXITED');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orch_send_tasks')).rows[0].n, 0);
    assert.equal(children.length, 3, 'account health faults do not restart healthy core or bridge children');
    await pool.end(); pool = undefined; controller.abort(); await running;
    await noProcesses([...children, simulator.child]);
    assert.deepEqual(trace.filter(item => item.event === 'service_stopped').slice(-3).map(item => item.name), ['bridge', 'core', 'postgres']);
    const count = children.length; await sleep(100); assert.equal(children.length, count, 'owner stop does not spawn replacements');
  } finally {
    controller.abort(); await pool?.end(); await running?.catch(() => {});
    for (const child of children) if (alive(child)) child.kill('SIGTERM');
    await noProcesses(children); await stopHelper(simulator.child); await noProcesses([simulator.child]); await cleanupRoot(setup.root);
  }
});
