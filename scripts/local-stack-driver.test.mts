import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStackDriver, readLocalStackConfig, pgExecutable, type LocalStackConfig } from './local-stack-driver.mts';

test('local launcher validates LAN opt-in while keeping DB local and selecting wildcard core bind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lan-config-'));
  try {
    const bin = join(root, 'bin'), data = join(root, 'data');
    await mkdir(bin); await mkdir(data);
    await writeFile(pgExecutable(bin, 'postgres'), 'fixture'); await writeFile(pgExecutable(bin, 'pg_ctl'), 'fixture');
    await writeFile(join(data, 'PG_VERSION'), '17');
    const env = { LOCAL_PG_BIN: bin, LOCAL_PG_DATA: data, DATABASE_URL: 'postgres://owner@127.0.0.1:55418/chat_agent',
      OWNER_ID: 'fixture-owner', OWNER_PASSWORD_HASH: 'scrypt$N=32768,r=8,p=1$c2FsdHNhbHRzYWx0c2E=$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==',
      PUBLIC_ORIGIN: 'http://127.0.0.1:8787', WECHAT_ACCOUNT_ID: 'fixture-account', WECHAT_SELF_REF: 'self',
      WECHAT_INGRESS_TOKEN: 'fixture-token', WECHAT_PROCESS_ID: '1' };
    assert.equal((await readLocalStackConfig(env)).env.HOST, '127.0.0.1');
    const lan = { ...env, PUBLIC_ORIGIN: 'http://192.168.31.17:8787' };
    await assert.rejects(readLocalStackConfig(lan), /INSECURE_ORIGIN/);
    await assert.rejects(readLocalStackConfig({ ...lan, ALLOW_LAN_HTTP: '1' }), /NON_LOOPBACK_BIND_REFUSED/);
    const config = await readLocalStackConfig({ ...lan, ALLOW_LAN_HTTP: '1', ALLOW_NON_LOOPBACK_BIND: '1' });
    assert.equal(config.env.HOST, '0.0.0.0'); assert.equal(config.env.START_PAUSED, '0');
    assert.equal(config.corePort, 8787); assert.equal(config.bridgePort, 19099);
    const dual=await readLocalStackConfig({ ...env,LOCAL_STACK_PLATFORMS:'qq,wechat',QQ_ACCOUNT_ID:'another-account',QQ_SELF_ID:'qq-self',QQ_BRIDGE_TOKEN:'qq-token' });
    assert.deepEqual(dual.bridges?.map(b=>[b.name,b.port]),[['bridge-qq',19099],['bridge-wechat',19100]]);
    assert.equal((await readLocalStackConfig({...env,START_PAUSED:'1'})).env.START_PAUSED,'1');
    await assert.rejects(readLocalStackConfig({...env,LOCAL_STACK_PLATFORMS:'qq,wechat',QQ_ACCOUNT_ID:'another-account',QQ_SELF_ID:'qq-self',QQ_BRIDGE_TOKEN:'qq-token',LOCAL_QQ_BRIDGE_PORT:'19100',LOCAL_WECHAT_BRIDGE_PORT:'19100'}),/LOCAL_PORTS_INVALID/);
    await assert.rejects(readLocalStackConfig({...env,LOCAL_STACK_PLATFORMS:'qq,qq'}),/LOCAL_STACK_PLATFORMS_INVALID/);
    await assert.rejects(readLocalStackConfig({ ...env, DATABASE_URL: 'postgres://owner@192.168.1.2:55418/chat_agent' }), /LOCAL_DATABASE_REQUIRED/);
    await assert.rejects(readLocalStackConfig({ ...env, PUBLIC_ORIGIN: 'http://8.8.8.8:8787', ALLOW_LAN_HTTP: '1' }), /LOCAL_ORIGIN_REQUIRED/);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(join(tmpdir(), 'lan-config-'))));
    await rm(root, { recursive: true, force: true });
  }
});

test('actual child media observations are forwarded to the local log sink', async () => {
  let observed!: () => void;
  const received = new Promise<void>(resolve => { observed = resolve; });
  const trace: { event: string; service?: string; measurement?: Record<string, unknown> }[] = [];
  const config: LocalStackConfig = { platform: 'qq', bridgeEntry: '', bin: '', data: '', databaseUrl: '',
    pgPort: 1, corePort: 2, bridgePort: 3, env: { ...process.env } };
  const driver = createLocalStackDriver({ config, signal: new AbortController().signal,
    entries: { bridge: resolve('tests/fixtures/qq-audit-log-child.mts') },
    log: async (event, service, measurement) => { trace.push({ event, service, measurement }); if (event === 'media_model_call') observed(); } });
  const owned = await driver.start('bridge');
  try {
    await Promise.race([received, sleep(5000, undefined, { ref: false }).then(() => { throw new Error('MEDIA_LOG_MISSING'); })]);
    const rows = trace.filter(row => row.event === 'media_model_call');
    assert.equal(rows.length, 1); assert.equal(rows[0]!.service, 'bridge');
    assert.equal(rows[0]!.measurement!.inputTokens, 12);
  } finally { await owned.stop(); }
});

test('LAN driver binds core on wildcard and bridge on loopback; health checks stay local', async () => {
  async function availablePort() {
    const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await new Promise<void>(done => server.close(() => done())); return address.port;
  }
  const config: LocalStackConfig = { platform: 'wechat', bridgeEntry: '', bin: '', data: '', databaseUrl: '',
    pgPort: 1, corePort: await availablePort(), bridgePort: await availablePort(),
    env: { ...process.env, HOST: '0.0.0.0', NODE_ENV: 'test', LOCAL_STACK_FIXTURE: '1' } };
  const fixture = resolve('tests/fixtures/local-stack-bind.mts');
  const driver = createLocalStackDriver({ config, signal: new AbortController().signal, log: async () => {}, entries: { core: fixture, bridge: fixture } });
  for (const name of ['core', 'bridge']) {
    const owned = await driver.start(name);
    try {
      await owned.ready();
      const port = name === 'core' ? config.corePort : config.bridgePort;
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.deepEqual(await response.json(), { host: name === 'core' ? '0.0.0.0' : '127.0.0.1' });
    } finally { await owned.stop(); }
  }
});

test('a process error with an owned PID cannot stand in for an actual child exit', async () => {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(done => server.close(() => done()));
  const config: LocalStackConfig = { bin: '', data: '', databaseUrl: '', pgPort: 1, corePort: address.port, bridgePort: 2,
    env: { ...process.env, NODE_ENV: 'test', LOCAL_STACK_FIXTURE: '1' } };
  let child: ChildProcess | undefined;
  const driver = createLocalStackDriver({ config, signal: new AbortController().signal, log: async () => {},
    entries: { core: resolve('tests/fixtures/local-stack-wait.mts') }, onSpawn: (_, owned) => { child = owned; } });
  const owned = await driver.start('core'); let exited = false; void owned.exited.then(() => { exited = true; });
  try {
    await new Promise<void>(done => child!.once('spawn', done));
    child!.emit('error', new Error('synthetic process operation failure')); await sleep(30);
    assert.equal(exited, false); assert.equal(child!.exitCode, null); assert.equal(child!.signalCode, null);
    await owned.stop(); assert.equal(exited, true);
    assert.ok(child!.exitCode !== null || child!.signalCode !== null);
  } finally {
    await owned.stop();
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); await new Promise<void>(done => child!.once('exit', done));
    }
  }
});
