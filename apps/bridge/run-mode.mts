/** Real bridge startup is receive-only until outbound is explicitly enabled.
 *
 * A bridge with no outbound transport has nothing to dispatch, so asking for a worker in that mode
 * is a configuration mistake rather than something to tolerate silently.
 */
export type BridgeRunMode = { outboundEnabled: boolean; workerEnabled: boolean };

/** Same flag vocabulary/default as core, so all entries honor START_PAUSED consistently. */
export function readBridgeStartPaused(env: Record<string,string|undefined>): boolean {
  const raw=env.START_PAUSED;
  if (raw===undefined || raw==='') return true;
  const value=raw.trim().toLowerCase();
  if (['1','true','yes','on'].includes(value)) return true;
  if (['0','false','no','off'].includes(value)) return false;
  throw new Error('INVALID_ENV:START_PAUSED');
}

function resolveRunMode(env: Record<string, string | undefined>, outboundVar: string): BridgeRunMode {
  const outbound = env[outboundVar]?.trim();
  const worker = env.WORKER_ENABLED?.trim();
  if (outbound !== undefined && outbound !== '' && outbound !== '0' && outbound !== '1') throw new Error(`INVALID_ENV:${outboundVar}`);
  if (worker !== undefined && worker !== '' && worker !== '0' && worker !== '1') throw new Error('INVALID_ENV:WORKER_ENABLED');
  const outboundEnabled = outbound === '1';
  if (!outboundEnabled && worker === '1') throw new Error('OUTBOUND_DISABLED:WORKER_ENABLED');
  return { outboundEnabled, workerEnabled: outboundEnabled && worker !== '0' };
}

export function resolveBridgeRunMode(env: Record<string, string | undefined>): BridgeRunMode {
  return resolveRunMode(env, 'QQ_ENABLE_OUTBOUND');
}

export function resolveWxBridgeRunMode(env: Record<string, string | undefined>): BridgeRunMode {
  return resolveRunMode(env, 'WECHAT_ENABLE_OUTBOUND');
}
