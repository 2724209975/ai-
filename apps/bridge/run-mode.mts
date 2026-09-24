/** Real bridge startup is receive-only until outbound is explicitly enabled. */
export function resolveBridgeRunMode(env: Record<string, string | undefined>): { outboundEnabled: boolean; workerEnabled: boolean } {
  const outbound = env.QQ_ENABLE_OUTBOUND?.trim();
  const worker = env.WORKER_ENABLED?.trim();
  if (outbound !== undefined && outbound !== '' && outbound !== '0' && outbound !== '1') throw new Error('INVALID_ENV:QQ_ENABLE_OUTBOUND');
  if (worker !== undefined && worker !== '' && worker !== '0' && worker !== '1') throw new Error('INVALID_ENV:WORKER_ENABLED');
  const outboundEnabled = outbound === '1';
  if (!outboundEnabled && worker === '1') throw new Error('OUTBOUND_DISABLED:WORKER_ENABLED');
  return { outboundEnabled, workerEnabled: outboundEnabled && worker !== '0' };
}
