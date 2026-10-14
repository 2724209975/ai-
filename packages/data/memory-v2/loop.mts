import type { MemoryWorker } from './worker.mts';
/** Separate maintenance loop: extraction/indexing never blocks reply collection or dispatch. */
export function createMemoryLoop(worker:MemoryWorker,intervalMs=10_000,onError:()=>void=()=>{}){
  let timer:ReturnType<typeof setInterval>|undefined,running:Promise<unknown>|undefined;
  return {
    async tick(){if(running)return;running=worker.runOnce();try{return await running;}finally{running=undefined;}},
    start(){if(timer)return;timer=setInterval(()=>void this.tick().catch(onError),intervalMs);timer.unref?.();},
    async stop(){if(timer)clearInterval(timer);timer=undefined;await running?.catch(onError);},
  };
}
