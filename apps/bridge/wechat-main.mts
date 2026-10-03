/** wxhelper bridge process. Receive-only unless WECHAT_ENABLE_OUTBOUND=1 is set explicitly.
 * WECHAT_INGRESS_TOKEN is a private URL secret and is never logged. */
import { isAbsolute, resolve } from 'node:path';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { WxhelperHttpTransport } from '../../packages/platform/wechat/wxhelper-http-transport.mts';
import { WxhelperLoopbackMediaTransport, WXHELPER_DEFAULT_BASE_URL } from '../../packages/platform/wechat/wxhelper-media-transport.mts';
import { createDeepSeekFromEnv, createTextModelIntelligence, describeDeepSeekEnv, readDeepSeekEnv, DEEPSEEK_DEFAULT_MODEL, readMediaEnv, createMediaUnderstandingFromEnv } from '../../packages/ai/index.mts';
import { createWxBridge } from './wechat-bridge.mts';
import { resolveWxBridgeRunMode } from './run-mode.mts';
import { preflightWxBinaryFiles, type WxBinaryFingerprint } from '../../packages/platform/wechat/binary-preflight.mts';
import { localHelperProbe } from './watchdog.mts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_ENV:${name}`);
  return value;
}
function optionalNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`INVALID_ENV:${name}`);
  return value;
}
/** Original-file fetch is opt-in and needs both absolute paths; nothing is derived or guessed. */
function readMediaOptions(): { dataPath: string; mediaRoot: string; baseUrl: string; maxBytes: number; pollMs: number; pollTimeoutMs: number } | undefined {
  const flag = process.env.WECHAT_MEDIA_FETCH?.trim();
  if (flag === undefined || flag === '' || flag === '0') return undefined;
  if (flag !== '1') throw new Error('INVALID_ENV:WECHAT_MEDIA_FETCH');
  const dataPath = required('WECHAT_DATA_PATH'), mediaRoot = required('WECHAT_MEDIA_DIR');
  if (!isAbsolute(dataPath) || !isAbsolute(mediaRoot)) throw new Error('WECHAT_MEDIA_ABSOLUTE_PATH_REQUIRED');
  return { dataPath, mediaRoot, baseUrl: process.env.WECHAT_WXHELPER_BASE_URL?.trim() || WXHELPER_DEFAULT_BASE_URL,
    maxBytes: optionalNumber('WECHAT_MEDIA_MAX_BYTES', 10 * 1024 * 1024, 1, 10 * 1024 * 1024),
    pollMs: optionalNumber('WECHAT_MEDIA_POLL_MS', 250, 1, 10_000),
    pollTimeoutMs: optionalNumber('WECHAT_MEDIA_POLL_TIMEOUT_MS', 8_000, 1, 120_000) };
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
const runMode = resolveWxBridgeRunMode(process.env);
// Before any model, database, reception, transport or worker is assembled, including receive-only.
let binaryFingerprint: WxBinaryFingerprint;
try { binaryFingerprint = await preflightWxBinaryFiles(process.env); }
catch (error) {
  process.stderr.write(`wechat binary preflight rejected: ${error instanceof Error ? error.message : 'WX_BINARY_PREFLIGHT_FAILED'}\n`);
  process.exit(1);
}
const wechatPid = Number(required('WECHAT_PROCESS_ID'));
const watchdogProbe = localHelperProbe({ pid: wechatPid });
const wxhelperBaseUrl = runMode.outboundEnabled ? required('WECHAT_WXHELPER_BASE_URL') : undefined;
const mediaOptions = readMediaOptions();
const mediaEnv = readMediaEnv(process.env);
if (mediaEnv.voiceEnabled) throw new Error('VOICE_RUNTIME_UNSUPPORTED');
if (mediaEnv.imageEnabled && !mediaOptions) throw new Error('IMAGE_UNDERSTANDING_REQUIRES_MEDIA_FETCH');
const imageUnderstanding = createMediaUnderstandingFromEnv(process.env);
// Candidates come from whichever provider the operator names; anything else is refused outright.
const intelligenceProvider = (process.env.WECHAT_INTELLIGENCE?.trim() || 'persistent-fake').toLowerCase();
if (!['persistent-fake', 'deepseek'].includes(intelligenceProvider)) throw new Error('UNSUPPORTED_INTELLIGENCE_PROVIDER');
const intelligence = intelligenceProvider === 'deepseek'
  ? (() => {
      process.stdout.write(`wechat bridge model provider: ${JSON.stringify(describeDeepSeekEnv(readDeepSeekEnv(process.env)))}\n`);
      // One JSON line per call: versions, latency and tokens only - never prompt or answer.
      return createTextModelIntelligence(createDeepSeekFromEnv(process.env),
        measurement => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'model_call', ...measurement })}\n`));
    })()
  : undefined;
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: required('DATABASE_URL'), max: 8 });
const bridge = createWxBridge({ pool, accountId, binaryFingerprint,
  startPaused: true, watchdog: { probe: watchdogProbe,
    quietMs: Number(process.env.WECHAT_QUIET_MS ?? '300000'), intervalMs: Number(process.env.WECHAT_WATCHDOG_INTERVAL_MS ?? '10000') },
  onWatchdogFatal: () => process.exit(1),
  selfRef, ingressToken,
  ...(intelligence ? { intelligence } : {}),
  ...(imageUnderstanding ? { imageUnderstanding: { provider: imageUnderstanding.provider, timeoutMs: mediaEnv.timeoutMs,
    observe: measurement => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'media_model_call', ...measurement })}\n`) } } : {}),
  rawStore: createFileRawEventStore(resolve(process.env.RAW_EVENT_DIR?.trim() || '.local-wechat-raw'), Date.now, 'wechat'),
  // Original-file fetch is opt-in; without it an image keeps going to a human exactly as before.
  ...(mediaOptions ? { media: { transport: new WxhelperLoopbackMediaTransport({ baseUrl: mediaOptions.baseUrl }),
    dataPath: mediaOptions.dataPath, mediaRoot: mediaOptions.mediaRoot, maxBytes: mediaOptions.maxBytes,
    pollMs: mediaOptions.pollMs, pollTimeoutMs: mediaOptions.pollTimeoutMs } } : {}),
  // The transport itself enforces the private loopback helper endpoint; this process holds no
  // WeChat credential and never talks to Tencent directly.
  dispatch: wxhelperBaseUrl
    ? { transport: new WxhelperHttpTransport({ baseUrl: wxhelperBaseUrl }),
        workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS?.trim() || '2000'),
        workerEnabled: runMode.workerEnabled }
    : undefined,
  outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS?.trim() || '2000') });
try {
  await bridge.start();
  await new Promise<void>((ready, fail) => {
    bridge.server.once('error', fail);
    bridge.server.listen(port, host, () => { bridge.server.off('error', fail); ready(); });
  });
  process.stdout.write(`wechat bridge listening on http://${host}:${port} · outbound ${runMode.outboundEnabled ? 'enabled' : 'disabled'}\n`);
  process.stdout.write(`candidate provider: ${intelligenceProvider}${intelligenceProvider === 'deepseek' ? ` (${readDeepSeekEnv(process.env).modelId || DEEPSEEK_DEFAULT_MODEL})` : ''}\n`);
  process.stdout.write('the helper endpoint stays loopback-only; a sent part is recorded as RESULT_UNKNOWN until an operator reconciles it\n');
  process.stdout.write(mediaOptions
    ? 'original-file fetch enabled for images; voice stays unsupported by this helper build\n'
    : 'original-file fetch disabled; images and voice keep going to a human\n');
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
