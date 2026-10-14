import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {LinkService} from './service.mts';
import {MemoryLinkStore} from './store.mts';
import {linkHttp} from './http.mts';
import {LinkBudget} from './budget.mts';
test('memory evidence is owner-only, contact scoped and read-only',async()=>{
 const service=new LinkService(new MemoryLinkStore()),paired=await service.pair(await service.invite(),'SyntheticPhone');
 const profile={name:'Synthetic',platform:'qq',relationship:'',style:'',preferences:[],memory:{consent:false,paused:false,profile:'',entries:[]}};
 const group=await service.bind(paired.deviceId,'allowed',profile,'allowed'),forbidden=await service.bind(paired.deviceId,'other',profile,'other');
 const memory={id:'m',version:1,ownerId:'owner',contactId:'allowed',conversationId:'conv',accountId:'account',memoryType:'fact' as const,subject:'contact',predicate:'likes',object:'饺子',content:'喜欢饺子',evidenceType:'user_confirmed' as const,evidenceRefs:[],confidence:1,importance:.5,status:'active' as const,observedAt:new Date().toISOString(),supersedesId:null,evidenceValid:true};
 for(const g of [group,forbidden])await service.desktopUpdate(g.id,[{id:'desktop:memory:m',kind:'memory_v2',body:memory,deleted:false,expectedVersion:0}]);
 let reads=0;const auth:any={authenticateRequest:async(req:any)=>req.headers.cookie==='owner'?{}:null,verifyWrite:()=>false};
 const handle=linkHttp(service,auth,{endpoint:'https://127.0.0.1:8791',fingerprint:'0'.repeat(64),contacts:async()=>({items:[{id:'allowed',name:'Synthetic'}]}),evidence:async()=>{reads++;return {memoryId:'m',memoryVersion:1,sources:[{id:'source',version:1,status:'current',text:'合成证据',speaker:'OTHER',timestamp:null,origin:'phone'}]};}});
 const server=createServer((req,res)=>{void handle(req,res,req.url!.startsWith('/api/'));});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as any,base=`http://127.0.0.1:${address.port}`;
 const endpoint=(id:string,recordId='desktop:memory:m')=>base+'/api/v1/mobile-link/evidence?'+new URLSearchParams({groupId:id,recordId});
 try{const before=await service.store.read();assert.equal((await fetch(endpoint(group.id))).status,401);
  assert.equal((await fetch(endpoint(group.id),{headers:{Authorization:`Bearer ${paired.token}`}})).status,401);
  assert.equal((await fetch(endpoint(forbidden.id),{headers:{Cookie:'owner'}})).status,403);assert.equal((await fetch(endpoint(group.id,'profile'),{headers:{Cookie:'owner'}})).status,404);assert.equal(reads,0);
  const response=await fetch(endpoint(group.id),{headers:{Cookie:'owner'}});assert.equal(response.status,200);assert.equal((await response.json() as any).sources[0].text,'合成证据');assert.equal(reads,1);assert.deepEqual(await service.store.read(),before);
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
test('HTTP pairing, auth, CSRF and message sync use distinct owner/device routes',async()=>{
 const service=new LinkService(new MemoryLinkStore());const auth:any={authenticateRequest:async(req:any)=>req.headers.cookie==='owner'?{}:null,verifyWrite:(req:any)=>req.headers['x-csrf-token']==='synthetic'};
 const budget=new LinkBudget(service.store,'synthetic-scope',()=>({limitCny:1,accountedCny:.1,halted:false}));await budget.initialize();
 const handle=linkHttp(service,auth,{budget,endpoint:'https://192.168.1.2:8790',fingerprint:'0'.repeat(64),contacts:async()=>({items:[{id:'contact',name:'Synthetic',platform:'qq'}]})});
 const server=createServer((req,res)=>{void handle(req,res,req.url!.startsWith('/api/')).catch(()=>{res.writeHead(500);res.end();});});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as any;const base=`http://127.0.0.1:${address.port}`;
 const post=(path:string,body:any,owner=false)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(owner?{Cookie:'owner','X-CSRF-Token':'synthetic'}:{})},body:JSON.stringify(body)});
 try {
  assert.equal((await fetch(base+'/api/v1/mobile-link')).status,401);
  assert.equal((await fetch(base+'/api/v1/mobile-link/invite',{method:'POST',headers:{Cookie:'owner'}})).status,403);
  const invite:any=await(await post('/api/v1/mobile-link/invite',{},true)).json();assert.ok(invite.qr.startsWith('data:image/png;base64,'));const code=JSON.parse(invite.payload);
  const p:any=await(await post('/link/v1/pair',{code:code.code,name:'SyntheticPhone'})).json();assert.ok(p.token);
  assert.equal((await fetch(base+'/api/v1/mobile-link/allowance',{method:'POST',headers:{Cookie:'owner'},body:JSON.stringify({deviceId:p.deviceId,limitMicroCny:100000})})).status,403);
  assert.equal((await post('/api/v1/mobile-link/allowance',{deviceId:p.deviceId,limitMicroCny:100000},true)).status,200);
  assert.equal((await fetch(base+'/link/v1/budget')).status,401);
  const phoneBudget:any=await(await fetch(base+'/link/v1/budget',{headers:{Authorization:`Bearer ${p.token}`}})).json();assert.equal(phoneBudget.phones.length,1);assert.equal(phoneBudget.phones[0].deviceId,p.deviceId);
  const usage=await fetch(base+'/link/v1/usage',{method:'POST',headers:{Authorization:`Bearer ${p.token}`,'Content-Type':'application/json'},body:JSON.stringify({budgetId:'synthetic-scope',spentMicroCny:10000,calls:1,tokens:100})});assert.equal(usage.status,200);
  const contacts=await fetch(base+'/link/v1/contacts',{headers:{Authorization:`Bearer ${p.token}`}});assert.equal(contacts.status,200);
  assert.equal((await fetch(base+'/link/v1/contacts')).status,401);
  const status:any=await(await fetch(base+'/api/v1/mobile-link',{headers:{Cookie:'owner'}})).json();assert.equal(status.devices[0].name,'SyntheticPhone');assert.equal(status.devices[0].tokenHash,undefined);
  assert.deepEqual(status.contacts,[{id:'contact',name:'Synthetic',platform:'qq'}]);assert.ok(status.budget.phones[0].lastReportedAt>0);
  const profile={name:'Synthetic',platform:'qq',relationship:'朋友',style:'原风格',preferences:[],memory:{consent:false,paused:false,profile:'',entries:[]}};
  const group=await service.bind(p.deviceId,'archive',profile,null);
  await service.desktopUpdate(group.id,[{id:'profile',kind:'profile',expectedVersion:1,deleted:false,body:{...profile,style:'电脑风格'}}]);
  await service.sync(p.deviceId,group.id,[{id:'profile',kind:'profile',expectedVersion:1,deleted:false,body:{...profile,style:'手机风格'}}],0);
  assert.equal((await post('/api/v1/mobile-link/resolve',{groupId:group.id,recordId:'profile',side:'incoming',expectedVersion:1},true)).status,409);
  await service.deleteGroup(p.deviceId,group.id);
  const deleted:any=await(await fetch(base+'/api/v1/mobile-link',{headers:{Cookie:'owner'}})).json();assert.equal(deleted.groups.length,0);
  await post('/api/v1/mobile-link/revoke',{deviceId:p.deviceId},true);assert.equal((await fetch(base+'/link/v1/contacts',{headers:{Authorization:`Bearer ${p.token}`}})).status,401);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
