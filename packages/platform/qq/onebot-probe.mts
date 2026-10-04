/** Read-only OneBot liveness probe. This module has no send, login or injection capability.
 *
 * The bridge watchdog needs to answer one question: "is the OneBot endpoint still logged in as the
 * account this bridge speaks for?" That must not become a general OneBot action caller, so exactly
 * one action is permitted - `get_login_info` - and the answer is judged only by whether the returned
 * `user_id` equals the configured self id.
 */
import { WireError } from './onebot-codec.mts';

/**
 * Structurally identical to the watchdog's `HealthProbe`. It is declared here rather than imported so
 * that this platform module keeps no dependency on `apps/bridge`.
 */
export type OneBotHealthProbe = { processAlive(): Promise<boolean>; checkLogin(signal: AbortSignal): Promise<boolean> };

/** The only OneBot action this module will ever call. */
export const ONEBOT_PROBE_ACTION = 'get_login_info';

function assertConfiguration(options: { baseUrl: string; accessToken: string; selfId: string; maxResponseBytes: number }): URL {
  let url: URL;
  try { url = new URL(options.baseUrl); } catch { throw new WireError(); }
  // Same boundary as the transport: no credentials, query or fragment in the endpoint, root path.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new WireError();
  if (!options.accessToken || /[\r\n]/.test(options.accessToken)) throw new WireError();
  if (!/^\d{1,20}$/.test(options.selfId)) throw new WireError();
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1) throw new WireError();
  return url;
}

/**
 * @param pid when omitted the process check reports "alive"; the operator opts into process
 * monitoring with `QQ_PROCESS_ID` because a bridge may legitimately not own the NapCat process.
 */
export function createOneBotHealthProbe(options: {
  baseUrl: string;
  accessToken: string;
  selfId: string;
  pid?: number;
  fetchImpl?: typeof fetch;
  alive?: (pid: number) => boolean;
  maxResponseBytes?: number;
}): OneBotHealthProbe {
  const maxResponseBytes = options.maxResponseBytes ?? 65_536;
  const endpoint = new URL(ONEBOT_PROBE_ACTION, assertConfiguration({ ...options, maxResponseBytes })).toString();
  if (options.pid !== undefined && (!Number.isSafeInteger(options.pid) || options.pid < 1)) throw new WireError();
  const call = options.fetchImpl ?? fetch;

  return {
    async processAlive(): Promise<boolean> {
      if (options.pid === undefined) return true;
      if (options.alive) return options.alive(options.pid);
      try { process.kill(options.pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
    },
    async checkLogin(signal: AbortSignal): Promise<boolean> {
      const response = await call(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${options.accessToken}` },
        body: '{}', signal, redirect: 'manual', cache: 'no-store',
      });
      // Any non-OK, non-JSON or oversized reply is "cannot tell", which the watchdog turns into
      // HELPER_UNRESPONSIVE. It must never be read as "logged in".
      if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body)
        throw new WireError('PLATFORM_UNAVAILABLE');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > maxResponseBytes) { await reader.cancel(); throw new WireError(); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
      catch { throw new WireError(); }
      const value = body as { status?: unknown; retcode?: unknown; data?: { user_id?: unknown } } | null;
      if (!value || typeof value !== 'object' || value.status !== 'ok' || value.retcode !== 0) throw new WireError('PROBE_INVALID');
      const userId = value.data?.user_id;
      if (typeof userId !== 'string' && typeof userId !== 'number') throw new WireError('PROBE_INVALID');
      // A logged-in endpoint for a different account is a real answer, not an error: report
      // "not this account" and let the watchdog raise HOOK_LOGIN_ABNORMAL.
      return String(userId) === options.selfId;
    },
  };
}
