import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import { createLocalStackDriver, type LocalStackConfig } from './local-stack-driver.mts';

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
