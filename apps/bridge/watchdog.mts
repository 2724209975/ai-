/** Portable probes; no injection, login, hook or sending capability. */
export type AccountFault = 'PROCESS_EXITED' | 'HOOK_LOGIN_ABNORMAL' | 'HELPER_UNRESPONSIVE';
export type HealthProbe = { processAlive(): Promise<boolean>; checkLogin(signal: AbortSignal): Promise<boolean> };
export function createAccountWatchdog(options: { probe: HealthProbe; quietMs?: number; timeoutMs?: number; intervalMs?: number;
  now?: () => number; record(healthy: boolean, code?: AccountFault): Promise<void>; onFatal?(): void }) {
  const now = options.now ?? Date.now, quietMs = options.quietMs ?? 300_000, timeoutMs = options.timeoutMs ?? 3000, intervalMs = options.intervalMs ?? 10_000;
  if (![quietMs, timeoutMs, intervalMs].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('WATCHDOG_CONFIG_INVALID');
  let lastEventAt = now(), status: 'pending' | 'healthy' | 'fault' | 'fatal' = 'pending', code: AccountFault | undefined;
  let timer: ReturnType<typeof setInterval> | undefined, running: Promise<void> | undefined;
  function tick(): Promise<void> {
    if (status === 'fatal') return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        let fault: AccountFault | undefined, healthy = false;
        if (!await options.probe.processAlive()) fault = 'PROCESS_EXITED';
        else {
          try {
            const signal = AbortSignal.timeout(timeoutMs);
            // Bound the probe wait; the production fetch observes cancellation.
            const login = await Promise.race([options.probe.checkLogin(signal), new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('PROBE_TIMEOUT')), { once: true }))]);
            if (login) healthy = true;
            else if (now() - lastEventAt >= quietMs) fault = 'HOOK_LOGIN_ABNORMAL';
          } catch { fault = 'HELPER_UNRESPONSIVE'; }
        }
        if (!fault && !healthy) return;
        await options.record(healthy, fault);
        status = fault ? 'fault' : 'healthy'; code = fault;
      } catch { status = 'fatal'; options.onFatal?.(); }
    })().finally(() => { running = undefined; });
    return running;
  }
  return { tick, received() { lastEventAt = now(); }, state() { return { status, ...(code ? { code } : {}) }; },
    start() { if (!timer) { timer = setInterval(() => void tick(), intervalMs); timer.unref(); } },
    async stop() { if (timer) clearInterval(timer); timer = undefined; await running; } };
}

export function localHelperProbe(options: { pid: number; baseUrl?: string; fetchImpl?: typeof fetch; alive?: (pid: number) => boolean }): HealthProbe {
  const url = new URL(options.baseUrl ?? 'http://127.0.0.1:19088/');
  if (!Number.isSafeInteger(options.pid) || options.pid < 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('WATCHDOG_CONFIG_INVALID');
  const call = options.fetchImpl ?? fetch;
  return { async processAlive() {
    if (options.alive) return options.alive(options.pid);
    try { process.kill(options.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }, async checkLogin(signal) {
    const response = await call(new URL('api/checkLogin', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal, redirect: 'manual', cache: 'no-store' });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/json')) throw new Error('PROBE_INVALID');
    const reader = response.body.getReader(); let text = '', size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > 4096) throw new Error('PROBE_INVALID'); text += Buffer.from(part.value).toString('utf8'); }
    } finally { await reader.cancel().catch(() => {}); }
    const value = JSON.parse(text); if (typeof value?.code !== 'number') throw new Error('PROBE_INVALID');
    return value.code === 1;
  } };
}
