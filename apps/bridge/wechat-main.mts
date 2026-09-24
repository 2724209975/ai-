/** Receive-only wxhelper process. WECHAT_INGRESS_TOKEN is a private URL secret, never logged. */
import { resolve } from 'node:path';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { createWxBridge } from './wechat-bridge.mts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_ENV:${name}`);
  return value;
}
const host = process.env.HOST?.trim() || '127.0.0.1';
if (host !== '127.0.0.1') throw new Error('WX_LOOPBACK_ONLY');
const port = Number(process.env.PORT?.trim() || '19099');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_ENV:PORT');
const accountId = required('WECHAT_ACCOUNT_ID');
const selfRef = required('WECHAT_SELF_REF');
const ingressToken = required('WECHAT_INGRESS_TOKEN');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)
  || selfRef.length > 256 || /[\s\u0000-\u001f\u007f]/.test(selfRef)
  || !/^[a-f0-9]{64}$/.test(ingressToken)) throw new Error('WX_BRIDGE_CONFIG_INVALID');
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: required('DATABASE_URL'), max: 8 });
const bridge = createWxBridge({ pool, accountId,
  selfRef, ingressToken,
  rawStore: createFileRawEventStore(resolve(process.env.RAW_EVENT_DIR?.trim() || '.local-wechat-raw'), Date.now, 'wechat') });
try {
  await bridge.start();
  await new Promise<void>((ready, fail) => {
    bridge.server.once('error', fail);
    bridge.server.listen(port, host, () => { bridge.server.off('error', fail); ready(); });
  });
  process.stdout.write(`wechat bridge listening on http://${host}:${port} · receive-only\n`);
} catch (error) { await pool.end(); throw error; }
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await bridge.stop(); await pool.end();
}
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => {
  void shutdown().then(() => process.exit(0), () => process.exit(1));
});
