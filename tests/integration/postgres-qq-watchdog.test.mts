/** Real PostgreSQL + a synthetic OneBot endpoint: the QQ watchdog path, no QQ account involved.
 *
 * Covers the card's watchdog requirement: the three fault codes produced by the read-only
 * `get_login_info` probe are persisted to `orch_account_health`, the account stays paused, and a
 * fatal watchdog (persistence failure) turns both `/healthz` and the ingress route into 503.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { createOneBotHealthProbe } from '../../packages/platform/qq/onebot-probe.mts';
import { createQqBridge } from '../../apps/bridge/bridge.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TOKEN = 'fixture-watchdog-token';
const SELF_ID = '10001';
const EXTERNAL_REF = '20002';

function listen(server: Server): Promise<number> {
  return new Promise((ready, failed) => {
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', failed);
      const address = server.address();
      ready(typeof address === 'object' && address ? address.port : 0);
    });
  });
}
async function close(server: Server): Promise<void> {
  await new Promise<void>(done => server.close(() => done()));
  server.closeAllConnections?.();
}

test('QQ watchdog persists each probe fault, keeps the account paused and fails closed when fatal',
  { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL_REQUIRED');
  const { Client, Pool } = await import('pg');
  const schema = `qq_watchdog_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  let onebot: Server | undefined, bridge: ReturnType<typeof createQqBridge> | undefined;
  const rawRoot = await mkdtemp(join(tmpdir(), 'qq-watchdog-raw-'));
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve('db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });

    const accountId = newId(), contactId = newId(), conversationId = newId();
    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,'合成联系人','enrolled',1,now(),now())`, [contactId, conversationId, accountId, EXTERNAL_REF]);
      await changeGlobalPause(tx, false);
    });
    // The synthetic endpoint answers exactly one action. The unresponsive case delays its reply past
    // the probe timeout, and a wrong user_id produces the login fault.
    let slow = false, alive = true, loginUserId: string | number = SELF_ID;
    // The unresponsive case answers too late rather than never: a reply that arrives after the
    // probe's timeout still ends the socket cleanly, so the next case is not affected by leftover
    // half-open requests keeping the bridge's connection pool busy.
    const pendingReplies: Promise<void>[] = [];
    const settleReplies = async () => { const outstanding = pendingReplies.splice(0); await Promise.all(outstanding); };
    onebot = createServer((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        const reply = () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: loginUserId } }));
        };
        if (slow) pendingReplies.push(new Promise<void>(done => setTimeout(() => { reply(); done(); }, 900)));
        else reply();
      });
    });
    const onebotPort = await listen(onebot);

    // The login fault is only raised once the endpoint has been quiet for `quietMs`, so the clock
    // has to advance; a frozen clock would leave the previous fault code in place and make the
    // assertion read a stale state.
    let clock = 1_000;
    const tickClock = () => (clock += 100);
    bridge = createQqBridge({
      pool, accountId, selfId: SELF_ID, bridgeToken: TOKEN,
      transport: { async submitOnce() { throw new Error('OUTBOUND_DISABLED'); } },
      rawStore: createFileRawEventStore(rawRoot),
      startPaused: true,
      watchdog: { probe: createOneBotHealthProbe({ baseUrl: `http://127.0.0.1:${onebotPort}/`, accessToken: TOKEN,
        selfId: SELF_ID, pid: 4242, alive: () => alive }),
        // A probe opens its own connection, so the timeout must leave room for connect + response;
        // too short a bound turns every case into HELPER_UNRESPONSIVE.
        intervalMs: 600_000, timeoutMs: 500, quietMs: 50, now: tickClock },
      outboxIntervalMs: 600_000, onError: () => {},
    });
    // Enroll while the account is healthy, so the conversation exists before any fault is raised.
    const enrolling = createQqBridge({
      pool, accountId, selfId: SELF_ID, bridgeToken: TOKEN,
      transport: { async submitOnce() { throw new Error('OUTBOUND_DISABLED'); } },
      rawStore: createFileRawEventStore(rawRoot), outboxIntervalMs: 600_000, onError: () => {},
    });
    await enrolling.service.enrollContact({ contactId, conversationId, accountId, externalContactRef: EXTERNAL_REF,
      timezone: 'Asia/Shanghai', goal: '普通聊天' });

    // The bridge server must be reachable before `start()` runs its first probe tick.
    const bridgePort = await listen(bridge.server);
    await bridge.start();
    const service = bridge.service;
    const pauseReasons = async () => (await pool!.query<{ pause_reasons: string[] }>(
      'SELECT pause_reasons FROM orch_conversations WHERE conversation_id=$1', [conversationId])).rows[0]!.pause_reasons;
    const faultCode = async () => (await pool!.query<{ fault_code: string | null }>(
      'SELECT fault_code FROM orch_account_health WHERE account_id=$1', [accountId])).rows[0]?.fault_code;

    // A restart latches the account even though the first probe already succeeded: only an operator
    // clears ACCOUNT_FAULT, so a restarted bridge can never resume sending on its own.
    assert.equal(await faultCode(), 'BRIDGE_RESTARTED');
    assert.ok((await pauseReasons()).includes('ACCOUNT_FAULT'), 'a restart keeps the account paused');
    assert.equal(await faultCode(), 'BRIDGE_RESTARTED');

    await settleReplies();
    for (const code of ['PROCESS_EXITED', 'HELPER_UNRESPONSIVE', 'HOOK_LOGIN_ABNORMAL'] as const) {
      alive = code !== 'PROCESS_EXITED';
      slow = code === 'HELPER_UNRESPONSIVE';
      loginUserId = code === 'HOOK_LOGIN_ABNORMAL' ? '99999' : SELF_ID;
      await bridge.watchdog!.tick();
      assert.equal(await faultCode(), code, `the persisted fault code must be ${code}`);
      assert.ok((await pauseReasons()).includes('ACCOUNT_FAULT'), `${code} must keep the account paused`);
      await settleReplies();
    }

    // Back to healthy: the row recovers but the account still waits for an operator.
    alive = true; slow = false; loginUserId = SELF_ID;
    await bridge.watchdog!.tick();
    assert.equal(bridge.watchdog!.state().status, 'healthy');
    assert.ok((await pauseReasons()).includes('ACCOUNT_FAULT'), 'only an operator resumes the account');

    const bridgePort2 = bridgePort;
    assert.equal((await fetch(`http://127.0.0.1:${bridgePort2}/healthz`)).status, 200);
    const health = await (await fetch(`http://127.0.0.1:${bridgePort2}/healthz`)).json() as Record<string, unknown>;
    assert.equal(health.adapter, 'qq-onebot');
    assert.equal(health.mode, 'receive-only');
    assert.equal(health.worker, 'disabled');
    assert.deepEqual(health.watchdog, { status: 'healthy' });
    assert.ok(!JSON.stringify(health).includes(SELF_ID) && !JSON.stringify(health).includes(TOKEN),
      '/healthz must not leak the QQ number or the token');

    // A watchdog that cannot persist its own state is fatal: refuse both routes.
    bridge.service.recordAccountHealth = async () => { throw new Error('fixture persistence failure'); };
    await bridge.watchdog!.tick();
    assert.equal(bridge.watchdog!.state().status, 'fatal');
    assert.equal((await fetch(`http://127.0.0.1:${bridgePort}/healthz`)).status, 503);
    assert.equal((await (await fetch(`http://127.0.0.1:${bridgePort}/healthz`)).json() as { status: string }).status, 'fatal');
    assert.equal((await fetch(`http://127.0.0.1:${bridgePort}/onebot/event`, { method: 'POST' })).status, 503);
  } finally {
    await bridge?.stop();
    if (bridge) await close(bridge.server);
    if (onebot) await close(onebot);
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
    await rm(rawRoot, { recursive: true, force: true });
  }
});
