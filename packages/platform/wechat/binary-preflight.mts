/** Exact files used by the transplanted offsets. No processes, injection or helper requests. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const WX_OFFSET_BUILD = Object.freeze({
  version: 'wechat-3.9.11.25-diagnostics-w01',
  clientSha256: '2058A926258BAEAECF92B30668FF200382F4493B0A5323428781D0B993E19C51',
  helperSha256: 'B48BD850E4A3CBBF44022CFEEF82E11272958F3052C8BE8748904DEF3BCFCF12',
});
export type WxBinaryFingerprint = Readonly<{ offsetBuild: string; clientPrefix: string; helperPrefix: string }>;

export function verifyWxBinaryDigests(client: string, helper: string): WxBinaryFingerprint {
  if (!/^[a-f0-9]{64}$/i.test(client) || client.toUpperCase() !== WX_OFFSET_BUILD.clientSha256) throw new Error('WX_CLIENT_BINARY_MISMATCH');
  if (!/^[a-f0-9]{64}$/i.test(helper) || helper.toUpperCase() !== WX_OFFSET_BUILD.helperSha256) throw new Error('WX_HELPER_BINARY_MISMATCH');
  return Object.freeze({ offsetBuild: WX_OFFSET_BUILD.version,
    clientPrefix: WX_OFFSET_BUILD.clientSha256.slice(0, 8), helperPrefix: WX_OFFSET_BUILD.helperSha256.slice(0, 8) });
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex').toUpperCase();
}
export async function preflightWxBinaryFiles(env: Record<string, string | undefined>): Promise<WxBinaryFingerprint> {
  const clientPath = env.WECHAT_CLIENT_DLL_PATH?.trim(), helperPath = env.WECHAT_HELPER_DLL_PATH?.trim();
  if (!clientPath) throw new Error('MISSING_ENV:WECHAT_CLIENT_DLL_PATH');
  if (!helperPath) throw new Error('MISSING_ENV:WECHAT_HELPER_DLL_PATH');
  let client: string, helper: string;
  try { client = await digestFile(clientPath); } catch { throw new Error('WX_CLIENT_BINARY_UNREADABLE'); }
  // Reject a changed client before reading any helper or assembling a reception service.
  if (client !== WX_OFFSET_BUILD.clientSha256) throw new Error('WX_CLIENT_BINARY_MISMATCH');
  try { helper = await digestFile(helperPath); } catch { throw new Error('WX_HELPER_BINARY_UNREADABLE'); }
  return verifyWxBinaryDigests(client, helper);
}
