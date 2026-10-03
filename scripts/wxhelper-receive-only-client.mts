/** Only the owner runs this CLI against WeChat. Automated tests use synthetic HTTP. */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, x64Dll } from './wxhelper-receive-only-build.mts';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';
import { P4_RECEIVE_BUILD } from './wxhelper-receive-only/build-pin.mts';

const paths = new Set(['/api/p4ReceiveStatus', '/api/checkLogin', '/api/hookSyncMsg', '/api/unhookSyncMsg']);
export function privateSettings(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(WECHAT_CLIENT_DLL_PATH|WECHAT_HELPER_DLL_PATH|WECHAT_SPIKE_PEER)=(.*)$/.exec(line);
    if (!match) continue;
    if (Object.hasOwn(values, match[1])) throw Error('P4_CONFIG_INVALID');
    values[match[1]] = match[2].trim();
  }
  if (!values.WECHAT_CLIENT_DLL_PATH || !values.WECHAT_HELPER_DLL_PATH ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(values.WECHAT_SPIKE_PEER ?? '')) throw Error('P4_CONFIG_INVALID');
  return values;
}
function smallFile(path: string, maximum: number): Buffer {
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.size > maximum) throw Error('P4_FILE_INVALID');
  const bytes = readFileSync(path); if (bytes.length > maximum) throw Error('P4_FILE_INVALID'); return bytes;
}
export function verifyBundle(bundle: string, settings: Record<string, string>, expected = P4_RECEIVE_BUILD) {
  const manifest = JSON.parse(smallFile(join(bundle, 'manifest.json'), 4096).toString());
  const dll = smallFile(join(bundle, 'wxhelper.dll'), 2 * 1024 * 1024);
  if (manifest.protocol !== expected.protocol || manifest.artifact?.receiveOnly !== true || manifest.liveTested !== false ||
      manifest.voiceDatabaseReady !== false || manifest.preparedInventorySha256 !== expected.preparedInventorySha256 ||
      manifest.artifact.sha256 !== expected.helperSha256 || digest(dll) !== expected.helperSha256 || !x64Dll(dll))
    throw Error('P4_BUILD_MISMATCH');
  if (manifest.rollback?.bundledPath !== 'rollback/wxhelper.dll' ||
      digest(smallFile(join(bundle, 'rollback', 'wxhelper.dll'), 2 * 1024 * 1024)).toUpperCase() !== WX_OFFSET_BUILD.helperSha256)
    throw Error('P4_ROLLBACK_MISMATCH');
  if (digest(smallFile(settings.WECHAT_CLIENT_DLL_PATH, 100 * 1024 * 1024)).toUpperCase() !== WX_OFFSET_BUILD.clientSha256 ||
      digest(smallFile(settings.WECHAT_HELPER_DLL_PATH, 2 * 1024 * 1024)).toUpperCase() !== WX_OFFSET_BUILD.helperSha256)
    throw Error('P4_BASELINE_MISMATCH');
  return manifest;
}
export type ReceiveStatus = { protocol: string; receiveOnly: true; voiceDatabaseReady: false;
  text: number; image: number; voice: number; other: number; expired: boolean; messageLimit: boolean; latestVoiceId: string };
export function receiveStatus(value: unknown): ReceiveStatus {
  const data = (value as { code?: number; data?: ReceiveStatus })?.data;
  if ((value as { code?: number })?.code !== 0 || !data || data.protocol !== P4_RECEIVE_BUILD.protocol ||
      data.receiveOnly !== true || data.voiceDatabaseReady !== false ||
      Object.keys(data).sort().join(',') !== 'expired,image,latestVoiceId,messageLimit,other,protocol,receiveOnly,text,voice,voiceDatabaseReady' ||
      typeof data.expired !== 'boolean' ||
      typeof data.messageLimit !== 'boolean' || !(['text', 'image', 'voice', 'other'] as const).every((key) =>
        Number.isInteger(data[key]) && data[key] >= 0 && data[key] <= 16) ||
      data.text + data.image + data.voice + data.other > 16 || typeof data.latestVoiceId !== 'string' ||
      (data.latestVoiceId !== '' && (!/^[1-9][0-9]{0,18}$/.test(data.latestVoiceId) ||
        BigInt(data.latestVoiceId) > 9223372036854775807n))) throw Error('P4_PROTOCOL_MISMATCH');
  return data;
}
export async function receiveRequest(base: string, token: string, path: string, timeoutMs = 2000): Promise<unknown> {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !paths.has(path) || !/^[a-f0-9]{64}$/.test(token))
    throw Error('P4_REQUEST_INVALID');
  const response = await fetch(new URL(path, url), { method: 'POST', body: '{}', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw Error('P4_REQUEST_FAILED');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break;
      total += next.value.length; if (total > 2048) throw Error('P4_RESPONSE_TOO_LARGE'); chunks.push(next.value); }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function stageSession(bundle: string, settings: Record<string, string>) {
  verifyBundle(bundle, settings);
  if (process.platform !== 'win32') throw Error('WINDOWS_LOCAL_SESSION_REQUIRED');
  const staged = join(process.env.LOCALAPPDATA!, 'ChatAgentTrial', `p45b-receive-only-${P4_RECEIVE_BUILD.helperSha256.slice(0, 8)}`);
  if (/[^\x20-\x7e]/.test(staged) || existsSync(staged)) throw Error('P4_STAGING_PATH_INVALID_OR_EXISTS');
  mkdirSync(staged, { recursive: true });
  const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = who.stdout?.match(/S-1-(?:\d+-)*\d+/)?.[0];
  if (who.status !== 0 || !sid) throw Error('P4_PRIVATE_DIRECTORY_FAILED');
  const acl = spawnSync('icacls.exe', [staged, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q'], { windowsHide: true, encoding: 'utf8' });
  if (acl.status !== 0) throw Error('P4_PRIVATE_DIRECTORY_FAILED');
  copyFileSync(join(bundle, 'wxhelper.dll'), join(staged, 'wxhelper.dll'));
  copyFileSync(join(bundle, 'manifest.json'), join(staged, 'manifest.json'));
  mkdirSync(join(staged, 'rollback')); copyFileSync(join(bundle, 'rollback', 'wxhelper.dll'), join(staged, 'rollback', 'wxhelper.dll'));
  writeFileSync(join(staged, 'receive-only.json'), JSON.stringify({ token: randomBytes(32).toString('hex'), peer: settings.WECHAT_SPIKE_PEER }),
    { flag: 'wx', mode: 0o600 });
  copyFileSync(resolve('scripts/wxhelper-receive-only/attach-by-owner.ps1'), join(staged, 'attach-by-owner.ps1'));
  return staged;
}
async function cli() {
  const [action, bundle, environment] = process.argv.slice(2);
  if (process.argv.length !== 5 || !['verify', 'prepare', 'status', 'hook', 'unhook'].includes(action)) throw Error('P4_ARGUMENTS_INVALID');
  const settings = privateSettings(smallFile(environment, 16 * 1024).toString()); verifyBundle(bundle, settings);
  if (action === 'verify') { console.log('P4_BUNDLE_VERIFIED receiveOnly=true voiceDatabaseReady=false'); return; }
  if (action === 'prepare') {
    const staged = stageSession(bundle, settings);
    writeFileSync(join(staged, 'owner-run.json'), JSON.stringify({ workspace: process.cwd(), environment: resolve(environment),
      client: settings.WECHAT_CLIENT_DLL_PATH, rollback: settings.WECHAT_HELPER_DLL_PATH,
      injector: resolve('.local-wxhelper/wxhelper-build-391125/app/injector/bin/Release/injector.exe') }), { flag: 'wx', mode: 0o600 });
    console.log(`P4_SESSION_PREPARED ${staged}`); return;
  }
  const config = JSON.parse(smallFile(join(bundle, 'receive-only.json'), 1024).toString());
  if (config.peer !== settings.WECHAT_SPIKE_PEER) throw Error('P4_BINDING_MISMATCH');
  const base = 'http://127.0.0.1:19188/';
  if (action === 'unhook') {
    const result = await receiveRequest(base, config.token, '/api/unhookSyncMsg') as { code?: number };
    if (result.code !== 0) throw Error('P4_UNHOOK_FAILED'); console.log('P4_UNHOOK_CONFIRMED'); return;
  }
  const status = receiveStatus(await receiveRequest(base, config.token, '/api/p4ReceiveStatus'));
  if (action === 'hook') {
    if (status.expired || status.messageLimit) throw Error('P4_SESSION_EXPIRED');
    const login = await receiveRequest(base, config.token, '/api/checkLogin') as { code?: number };
    if (login.code !== 1) throw Error('P4_LOGIN_NOT_READY');
    const hook = await receiveRequest(base, config.token, '/api/hookSyncMsg') as { code?: number };
    if (hook.code !== 0) throw Error('P4_HOOK_FAILED'); console.log('P4_RECEIVE_HOOK_CONFIRMED'); return;
  }
  writeFileSync(join(bundle, `evidence-${Date.now()}.json`), JSON.stringify({ capturedAt: new Date().toISOString(), status }),
    { flag: 'wx', mode: 0o600 });
  console.log(`P4_STATUS_SAVED text=${status.text} image=${status.image} voice=${status.voice} expired=${status.expired}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(() => { console.error('P4_RECEIVE_FAILED: stop this run; keep paused and retain private evidence'); process.exitCode = 1; });
}
