/** Reconnect only the authenticated receive socket; never submit platform messages. */
export type TrialSocket={addEventListener(type:string,listener:(event:any)=>void):void;close():void};
export function createQqTrialReceiver(options:{connect():Promise<TrialSocket>;onMessage(data:unknown):void;onState(connected:boolean,attempts:number):void;
  schedule?:(fn:()=>void,ms:number)=>unknown;cancel?:(timer:any)=>void}){
  const schedule=options.schedule??((fn,ms)=>setTimeout(fn,ms)),cancel:(timer:any)=>void=options.cancel??clearTimeout;
  let stopped=false,epoch=0,attempts=0,socket:TrialSocket|undefined,timer:unknown;
  function retry(current:number){if(stopped||current!==epoch)return;epoch++;socket?.close();socket=undefined;options.onState(false,attempts);timer=schedule(()=>{timer=undefined;void connect();},Math.min(30000,1000*2**Math.min(attempts,5)));}
  async function connect(){if(stopped)return;const current=++epoch;attempts++;
    try{const candidate=await options.connect();if(stopped||current!==epoch){candidate.close();return;}socket=candidate;
      candidate.addEventListener('open',()=>{if(stopped||current!==epoch)return;attempts=0;options.onState(true,attempts);});
      candidate.addEventListener('message',event=>{if(!stopped&&current===epoch)options.onMessage(event.data);});
      candidate.addEventListener('close',()=>retry(current));candidate.addEventListener('error',()=>retry(current));
    }catch{retry(current);}
  }
  return {start:connect,stop(){stopped=true;epoch++;if(timer!==undefined)cancel(timer);socket?.close();options.onState(false,attempts);}};
}
