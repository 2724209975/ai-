/** Unit tests for the health/readiness endpoints against a scripted pool. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHealthHandler, createReadinessProbe, type ReadinessReport } from './health.mts';
import type { PgClient, PgPool } from '../../packages/infrastructure/postgres/transaction.mts';

const readyReport: ReadinessReport = { status: 'ready', checks: [{ name: 'database', status: 'ok' }] };

function poolThatRuns(handler: (sql: string) => void): PgPool {
  return {
    async connect(): Promise<PgClient> {
      return {
        async query(sql: string) {
          handler(sql);
          // The control check needs the singleton row; everything else only needs to succeed.
          return { rows: sql.includes('dispatch_global_control') ? [{ paused: true }] : [] };
        },
        release() {},
      };
    },
  };
}

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>) {
  const server = createServer((request, response) => {
    void handler(request, response).then(handled => {
      // The production runtime falls through to the owner app here; the test just ends the request
      // so a declined route cannot leave a socket hanging.
      if (!handled && !response.writableEnded) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    // fetch keeps its socket alive, so a plain close() would wait forever for the keep-alive peer.
    close: () => new Promise<void>(done => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

test('a healthy process answers liveness and readiness without a session', async () => {
  const health = createHealthHandler({ service: 'core', ready: async () => readyReport });
  const server = await serve(health);
  try {
    const live = await fetch(`${server.origin}/healthz`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok', service: 'core' });
    const ready = await fetch(`${server.origin}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), readyReport);
    const other = await fetch(`${server.origin}/api/v1/overview`);
    assert.equal(other.status, 404, 'the health handler ignores anything it does not own');
  } finally { await server.close(); }
});

test('an unready process keeps liveness at 200 and readiness at 503 with the failed check', async () => {
  const health = createHealthHandler({
    service: 'core',
    ready: async () => ({ status: 'not_ready', checks: [{ name: 'database', status: 'ok' }, { name: 'schema', status: 'failed' }] }),
  });
  const server = await serve(health);
  try {
    assert.equal((await fetch(`${server.origin}/healthz`)).status, 200);
    const ready = await fetch(`${server.origin}/readyz`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'not_ready', checks: [{ name: 'database', status: 'ok' }, { name: 'schema', status: 'failed' }] });
  } finally { await server.close(); }
});

test('the readiness probe reports fixed check names and never echoes a driver error', async () => {
  const statements: string[] = [];
  const probe = createReadinessProbe({ pool: poolThatRuns(sql => statements.push(sql)), recovered: () => true });
  const report = await probe();
  assert.deepEqual(report, { status: 'ready', checks: [
    { name: 'database', status: 'ok' }, { name: 'schema', status: 'ok' }, { name: 'control', status: 'ok' }, { name: 'recovery', status: 'ok' },
  ] });
  assert.deepEqual(statements, ['SELECT 1', 'SELECT 1 FROM orch_conversations LIMIT 0', 'SELECT paused FROM dispatch_global_control WHERE singleton=true']);

  const brokenPool: PgPool = {
    async connect(): Promise<PgClient> {
      return { async query() { throw new Error('password authentication failed for user "owner" at 10.0.0.4'); }, release() {} };
    },
  };
  const broken = await createReadinessProbe({ pool: brokenPool, recovered: () => false })();
  assert.equal(broken.status, 'not_ready');
  assert.deepEqual(broken.checks.map(check => check.status), ['failed', 'failed', 'failed', 'failed']);
  assert.ok(!JSON.stringify(broken).includes('password'), 'no driver message may reach the caller');
});

test('readiness fails when the control row or an injected recovery flag is missing', async () => {
  const missingRow: PgPool = {
    async connect(): Promise<PgClient> {
      return { async query() { return { rows: [] }; }, release() {} };
    },
  };
  const report = await createReadinessProbe({ pool: missingRow, recovered: () => false })();
  assert.deepEqual(report.checks.map(check => check.name), ['database', 'schema', 'control', 'recovery']);
  assert.equal(report.checks.find(check => check.name === 'control')?.status, 'failed');
  assert.equal(report.checks.at(-1)?.status, 'failed');
});
