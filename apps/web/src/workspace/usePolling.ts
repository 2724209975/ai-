import { useEffect, useState } from 'react';

export function usePolling<T>(identity: string, fetcher: (signal: AbortSignal) => Promise<T>, interval: number, revision: number) {
  const [result, setResult] = useState<{ identity: string; value: T; at: number }>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    let active = true, loading = false;
    setError(undefined);
    async function load() {
      if (!identity || document.hidden || loading) return;
      loading = true;
      try {
        const value = await fetcher(controller.signal);
        if (active) { setResult({ identity, value, at: Date.now() }); setError(undefined); }
      } catch (cause) { if (active && !controller.signal.aborted) setError(cause); }
      finally { loading = false; }
    }
    void load();
    const timer = setInterval(() => void load(), interval);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [identity, fetcher, interval, revision]);
  return { data: result?.identity === identity ? result.value : undefined, at: result?.identity === identity ? result.at : undefined, error };
}
