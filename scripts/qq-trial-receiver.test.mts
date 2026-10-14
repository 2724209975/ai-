import test from 'node:test';import assert from 'node:assert/strict';import {createQqTrialReceiver} from './qq-trial-receiver.mts';
class Socket{listeners=new Map<string,((e:any)=>void)[]>();closed=false;addEventListener(t:string,f:(e:any)=>void){this.listeners.set(t,[...(this.listeners.get(t)??[]),f]);}close(){this.closed=true;}emit(t:string,data?:unknown){for(const f of this.listeners.get(t)??[])f({data});}}
test('receive reconnect rejects late old events, avoids duplicate timers and stops future attempts',async()=>{
 const sockets:Socket[]=[],messages:unknown[]=[],scheduled:{fn:()=>void;ms:number}[]=[],states:boolean[]=[];let attempts=0;
 const receiver=createQqTrialReceiver({async connect(){attempts++;const s=new Socket();sockets.push(s);return s;},onMessage:d=>messages.push(d),onState:s=>states.push(s),schedule:(fn,ms)=>{scheduled.push({fn,ms});return scheduled.length;},cancel:()=>{}});
 await receiver.start();sockets[0]!.emit('open');sockets[0]!.emit('message','first');sockets[0]!.emit('error');sockets[0]!.emit('close');assert.equal(scheduled.length,1);
 scheduled[0]!.fn();await new Promise(r=>setImmediate(r));sockets[0]!.emit('message','stale');sockets[1]!.emit('open');sockets[1]!.emit('message','second');
 assert.deepEqual(messages,['first','second']);assert.equal(attempts,2);receiver.stop();sockets[1]!.emit('close');assert.equal(scheduled.length,1);assert.ok(sockets[1]!.closed);assert.deepEqual(states,[true,false,true,false]);
});
test('offline login retries with bounded backoff and stop fences an in-flight connection',async()=>{
 const timers:{fn:()=>void;ms:number}[]=[],socket=new Socket();let complete!:(s:Socket)=>void,calls=0;
 const receiver=createQqTrialReceiver({async connect(){if(++calls<3)throw Error('offline');return new Promise<Socket>(r=>complete=r);},onMessage:()=>assert.fail(),onState:()=>{},schedule:(fn,ms)=>{timers.push({fn,ms});return 1;},cancel:()=>{}});
 await receiver.start();timers[0]!.fn();await new Promise(r=>setImmediate(r));assert.ok(timers[1]!.ms>timers[0]!.ms);timers[1]!.fn();await new Promise(r=>setImmediate(r));receiver.stop();complete(socket);await new Promise(r=>setImmediate(r));assert.ok(socket.closed);
});
