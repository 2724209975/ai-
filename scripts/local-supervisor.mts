import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type ManagedProcess = { ready(): Promise<void>; exited: Promise<void>; stop(): Promise<void> };
// start must return the owned child promptly; all readiness waits belong in ready().
export async function superviseLocalStack(options: { names: string[]; start(name: string): Promise<ManagedProcess>;
  isolatedServices?: string[];
  signal: AbortSignal; log(event: string, service?: string): Promise<void>; delay?(ms: number): Promise<void>;
  backoffMs?: number; maxBackoffMs?: number }): Promise<void> {
  if (options.isolatedServices?.length) return superviseIndependentStack(options);
  const delay = options.delay ?? (ms => new Promise<void>(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); options.signal.removeEventListener('abort', done); resolve(); }
    options.signal.addEventListener('abort', done, { once: true });
    if (options.signal.aborted) done();
  }));
  let failures = 0;
  while (!options.signal.aborted) {
    const owned: { name: string; child: ManagedProcess }[] = []; const startedAt = Date.now();
    let exitSeen = false, signalExit!: () => void;
    const exited = new Promise<void>(resolve => { signalExit = () => { exitSeen = true; resolve(); }; });
    let removeAbort = () => {};
    const aborted = new Promise<void>(resolve => {
      const done = () => resolve(); options.signal.addEventListener('abort', done, { once: true });
      removeAbort = () => options.signal.removeEventListener('abort', done);
      if (options.signal.aborted) done();
    });
    try {
      for (const name of options.names) {
        if (options.signal.aborted) break;
        if (exitSeen) throw new Error('CHILD_EXITED');
        const child = await options.start(name); owned.push({ name, child });
        void child.exited.then(signalExit, signalExit);
        await Promise.race([child.ready(), exited.then(() => { throw new Error('CHILD_EXITED'); }),
          aborted.then(() => { throw new Error('STOPPED'); })]);
        if (exitSeen) throw new Error('CHILD_EXITED');
        await options.log('service_ready', name);
      }
      if (!options.signal.aborted) {
        if (exitSeen) throw new Error('CHILD_EXITED');
        await options.log('stack_ready');
        await Promise.race([exited.then(() => { throw new Error('CHILD_EXITED'); }), aborted]);
      }
    } catch { if (!options.signal.aborted) await options.log('stack_fault'); }
    finally {
      removeAbort();
      // Never start replacements while an owned dependency may still be alive.
      // A failed stop cannot prevent best-effort cleanup of the remaining dependencies.
      let stopFailed = false;
      for (const { name, child } of owned.reverse()) {
        try { await child.stop(); await options.log('service_stopped', name); }
        catch { stopFailed = true; }
      }
      if (stopFailed) throw new Error('STACK_STOP_FAILED');
    }
    if (!options.signal.aborted) {
      failures = Date.now() - startedAt >= 60_000 ? 1 : failures + 1;
      await options.log('stack_restart');
      await delay(Math.min(options.maxBackoffMs ?? 30_000, (options.backoffMs ?? 1000) * 2 ** Math.min(failures - 1, 10)));
    }
  }
  await options.log('stack_stopped');
}

/** Bridges restart independently; a dependency failure stops all bridges before the database. */
async function superviseIndependentStack(options: Parameters<typeof superviseLocalStack>[0]): Promise<void> {
  const isolated=new Set(options.isolatedServices);
  if (options.isolatedServices!.some(name=>!options.names.includes(name))) throw new Error('LOCAL_SERVICE_INVALID');
  const delay=async (ms:number,signal:AbortSignal) => {
    if (signal.aborted) return;
    if (options.delay) return options.delay(ms);
    await new Promise<void>(resolve=>{
      const done=()=>{ clearTimeout(timer); signal.removeEventListener('abort',done); resolve(); };
      const timer=setTimeout(done,ms); signal.addEventListener('abort',done,{once:true});
      if (signal.aborted) done();
    });
  };
  const backoff=(failures:number)=>Math.min(options.maxBackoffMs ?? 30_000,(options.backoffMs ?? 1000)*2**Math.min(failures-1,10));
  let failures=0;
  while (!options.signal.aborted) {
    const round=new AbortController(), roots:{name:string;child:ManagedProcess}[]=[];
    const abort=()=>round.abort(); options.signal.addEventListener('abort',abort,{once:true});
    const aborted=new Promise<void>(resolve=>{ round.signal.addEventListener('abort',()=>resolve(),{once:true}); if(options.signal.aborted) round.abort(); });
    let dependencyExit!:()=>void;
    const dependencyFailed=new Promise<never>((_,reject)=>{ dependencyExit=()=>reject(new Error('CHILD_EXITED')); });
    // A handler is attached before any child can exit, including during startup.
    void dependencyFailed.catch(()=>{});
    const loops:Promise<void>[]=[];
    let stopFailed=false;
    try {
      for (const name of options.names.filter(name=>!isolated.has(name))) {
        if (round.signal.aborted) break;
        const child=await options.start(name); roots.push({name,child});
        void child.exited.then(dependencyExit,dependencyExit);
        await Promise.race([child.ready(),dependencyFailed,aborted.then(()=>{throw new Error('STOPPED');})]);
        await options.log('service_ready',name);
      }
      if (!round.signal.aborted) {
        const firstReady:Promise<void>[]=[];
        for (const name of options.names.filter(name=>isolated.has(name))) {
          let ready!:()=>void; firstReady.push(new Promise<void>(resolve=>{ready=resolve;}));
          const loop=(async()=>{
            let count=0;
            while(!round.signal.aborted) {
              let child:ManagedProcess|undefined; const startedAt=Date.now();
              try {
                child=await options.start(name);
                await Promise.race([child.ready(),child.exited.then(()=>{throw new Error('CHILD_EXITED');}),aborted.then(()=>{throw new Error('STOPPED');})]);
                await options.log('service_ready',name); ready();
                await Promise.race([child.exited,aborted]);
              } catch { if(!round.signal.aborted) await options.log('stack_fault',name); }
              finally {
                if(child) { try { await child.stop(); await options.log('service_stopped',name); } catch { stopFailed=true; round.abort(); throw new Error('STACK_STOP_FAILED'); } }
              }
              if(!round.signal.aborted) {
                count=Date.now()-startedAt>=60_000 ? 1 : count+1;
                await options.log('stack_restart',name); await delay(backoff(count),round.signal);
              }
            }
          })();
          void loop.catch(()=>round.abort()); loops.push(loop);
        }
        await Promise.race([Promise.all(firstReady),dependencyFailed,aborted]);
        if(!round.signal.aborted) { await options.log('stack_ready'); await Promise.race([dependencyFailed,aborted]); }
      }
    } catch { if(!options.signal.aborted) await options.log('stack_fault'); }
    finally {
      round.abort(); options.signal.removeEventListener('abort',abort);
      const results=await Promise.allSettled(loops); if(results.some(r=>r.status==='rejected')) stopFailed=true;
      for(const {name,child} of roots.reverse()) { try{ await child.stop(); await options.log('service_stopped',name); } catch { stopFailed=true; } }
    }
    if(stopFailed) throw new Error('STACK_STOP_FAILED');
    if(!options.signal.aborted) { failures++; await options.log('stack_restart'); await delay(backoff(failures),options.signal); }
  }
  await options.log('stack_stopped');
}

/** Only fixed supervisor events and service names enter logs; child output is never copied. */
export function rotatingStackLog(directory: string, maxBytes = 1_048_576, archives = 5) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || !Number.isSafeInteger(archives) || archives < 1 || archives > 20) throw new Error('LOG_CONFIG_INVALID');
  let chain = Promise.resolve();
  return (event: string, service?: string, measurement?: Record<string, unknown>): Promise<void> => {
    if (!['service_ready', 'service_stopped', 'stack_ready', 'stack_fault', 'stack_restart', 'stack_stopped', 'process_output', 'process_error', 'model_call', 'media_model_call'].includes(event)
      || (service !== undefined && !['postgres', 'core', 'bridge','bridge-qq','bridge-wechat'].includes(service))) return Promise.reject(new Error('LOG_EVENT_INVALID'));
    const metrics: Record<string, unknown> = {};
    if ((event === 'model_call' || event === 'media_model_call') && measurement) {
      for (const name of ['callId', 'contextSnapshotId']) if (typeof measurement[name] === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(measurement[name] as string)) metrics[name] = measurement[name];
      for (const name of ['inputTokens', 'outputTokens', 'elapsedMs']) if (typeof measurement[name] === 'number' && Number.isFinite(measurement[name]) && (measurement[name] as number) >= 0) metrics[name] = measurement[name];
      metrics.outcome = measurement.outcome === 'ok' ? 'ok' : event === 'media_model_call' && measurement.outcome === 'uncertain' ? 'uncertain' : 'error';
      if (event === 'media_model_call') {
        if (measurement.mediaType === 'image' || measurement.mediaType === 'voice') metrics.mediaType = measurement.mediaType;
      } else {
        if (['reply-candidates-1', 'reply-candidates-2', 'reply-candidates-3'].includes(String(measurement.promptVersion))) metrics.promptVersion = measurement.promptVersion;
        if (['deepseek-flash', 'deepseek-v4-pro'].includes(String(measurement.modelId))) metrics.modelId = measurement.modelId;
      }
    }
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...(service ? { service } : {}), ...metrics }) + '\n';
    if (Buffer.byteLength(line) > maxBytes) return Promise.reject(new Error('LOG_RECORD_TOO_LARGE'));
    chain = chain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'stack.jsonl');
      const size = await stat(path).then(s => s.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
      if (size + Buffer.byteLength(line) > maxBytes) {
        await rm(join(directory, `stack.jsonl.${archives}`), { force: true });
        for (let index = archives - 1; index >= 0; index--) {
          const source = join(directory, index ? `stack.jsonl.${index}` : 'stack.jsonl');
          await rename(source, join(directory, `stack.jsonl.${index + 1}`)).catch(e => { if (e.code !== 'ENOENT') throw e; });
        }
      }
      await appendFile(path, line, { mode: 0o600 });
    });
    return chain;
  };
}
