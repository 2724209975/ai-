import test from 'node:test';
import assert from 'node:assert/strict';
import type {TrialQualitySettings} from '../../../packages/contracts/trial-model-settings.mts';
import { createServer,request as httpRequest } from 'node:http';
import { createOwnerHttpHandler, type OwnerPort } from './owner-http.mts';

test('history upload preserves Chinese across UTF8 chunk boundaries and requires Owner CSRF',async()=>{
 const seen:unknown[]=[];const port={historyPreview:async(ownerId:string,input:unknown)=>{seen.push({ownerId,input});return {id:'preview'};}} as unknown as OwnerPort;
 const server=createServer(createOwnerHttpHandler({ownerPort:port,authenticate:async r=>r.headers.cookie==='owner=test'?{ownerId:'trusted-owner'}:null,verifyWrite:r=>r.headers.origin==='http://allowed.invalid'&&r.headers['x-csrf-token']==='test'}));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/api/v2/history-imports/preview`,headers={cookie:'owner=test',origin:'http://allowed.invalid','x-csrf-token':'test','Content-Type':'application/json'};
 try{
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);assert.equal((await fetch(url,{method:'POST',headers:{cookie:'owner=test'},body:'{}'})).status,403);assert.equal(seen.length,0);
  const input={contactId:'selected',filename:'原文.json',format:'json',content:JSON.stringify([{speaker:'OTHER',text:'你好世界',timestamp:null}])},bytes=Buffer.from(JSON.stringify(input)),split=bytes.indexOf(Buffer.from('原'))+1;
  const status=await new Promise<number>((resolve,reject)=>{const req=httpRequest(url,{method:'POST',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.write(bytes.subarray(0,split));req.end(bytes.subarray(split));});assert.equal(status,200);assert.deepEqual(seen,[{ownerId:'trusted-owner',input}]);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

for(const role of ['quality','economy']) test('trial '+role+' settings require owner, Origin and CSRF; identity, send and budget injection never reaches the store',async()=>{
 const calls:string[]=[],state:TrialQualitySettings={version:0,phase:'unconfigured',hasApiKey:false,model:null,activeModelId:null,canApply:true};
 const port={async trialQualitySettings(ownerId:string){assert.equal(ownerId,'trusted-owner');calls.push('read');return state;},async saveTrialQualitySettings(ownerId:string){assert.equal(ownerId,'trusted-owner');calls.push('save');return {...state,version:1};},async applyTrialQualitySettings(ownerId:string){assert.equal(ownerId,'trusted-owner');calls.push('apply');return {...state,restarting:true};}} as unknown as OwnerPort;
 if(role==='economy'){port.trialEconomySettings=port.trialQualitySettings;port.saveTrialEconomySettings=port.saveTrialQualitySettings;port.applyTrialEconomySettings=port.applyTrialQualitySettings;}
 const server=createServer(createOwnerHttpHandler({ownerPort:port,authenticate:async r=>r.headers.cookie==='owner=test'?{ownerId:'trusted-owner'}:null,verifyWrite:r=>r.headers['x-csrf-token']==='test'&&r.headers.origin==='http://allowed.invalid'}));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api/v2/trial-${role}-settings`;
 const headers={cookie:'owner=test','x-csrf-token':'test',origin:'http://allowed.invalid'};const input={expectedVersion:0,idempotencyKey:'save-first',model:{modelId:'synthetic'}};
 const post=(body:unknown,path='',h:Record<string,string>=headers)=>fetch(base+path,{method:'POST',headers:h,body:JSON.stringify(body)});
 try{
  assert.equal((await fetch(base)).status,401);assert.equal((await post(input,'',{})).status,401);assert.equal((await post(input,'',{cookie:'owner=test'})).status,403);assert.equal((await post(input,'',{...headers,origin:'http://foreign.invalid'})).status,403);assert.equal(calls.length,0);
  for(const bad of [{...input,ownerId:'forged'},{...input,maxCny:10},{...input,sendMode:'auto'},{...input,model:null}])assert.equal((await post(bad)).status,400);
  assert.equal((await post({...input,model:undefined},'/apply')).status,200);
  assert.equal((await fetch(base,{headers})).status,200);assert.equal((await post(input)).status,200);assert.deepEqual(calls,['apply','read','save']);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('P4 model reads are authenticated and configuration rejects secret/identity/send fields',async()=>{
  const calls:unknown[]=[];const port={async modelConfig(ownerId){calls.push(ownerId);return {version:0,providers:[]};},async modelUsage(){return {totals:{calls:0}};},async updateModelConfig(ownerId,input){calls.push({ownerId,input});return {resultVersion:1};}} as OwnerPort;
  const server=createServer(createOwnerHttpHandler({ownerPort:port,authenticate:async r=>r.headers.cookie==='owner=test'?{ownerId:'trusted-owner'}:null,verifyWrite:r=>r.headers['x-csrf-token']==='test'}));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const post=(body:unknown,csrf=true)=>fetch(base+'/api/v2/model-config',{method:'POST',headers:{cookie:'owner=test',...(csrf?{'x-csrf-token':'test'}:{})},body:JSON.stringify(body)});
  try{
    assert.equal((await fetch(base+'/api/v2/model-config')).status,401);assert.equal((await fetch(base+'/api/v2/model-usage')).status,401);assert.equal(calls.length,0);
    assert.equal((await fetch(base+'/api/v2/model-config',{headers:{cookie:'owner=test'}})).status,200);assert.deepEqual(calls,['trusted-owner']);
    const command={expectedVersion:0,idempotencyKey:'synthetic-key',config:{}};assert.equal((await post(command,false)).status,403);
    for(const field of ['apiKey','ownerId','autoSend','baseUrl'])assert.equal((await post({...command,[field]:'injected'})).status,400);
    assert.equal((await post(command)).status,200);assert.deepEqual(calls[1],{ownerId:'trusted-owner',input:command});
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('v2 memory reads require Owner; mutations require CSRF and reject identity/action injection',async()=>{
  const calls:unknown[]=[];
  const port={async memories(ownerId,id){calls.push({ownerId,id});return {items:[]};},async contextPreview(){return {context:null,status:'not_built'};},
    async memoryCommand(ownerId,id,action,memoryId,input){calls.push({ownerId,id,action,memoryId,input});return {status:'pending'};},async memoryProfile(){return {version:1};},async memoryControls(){return {version:1};}} as OwnerPort;
  const server=createServer(createOwnerHttpHandler({ownerPort:port,authenticate:async r=>r.headers.cookie==='owner=test'?{ownerId:'trusted-owner'}:null,verifyWrite:r=>r.headers['x-csrf-token']==='test'}));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api/v2/conversations/one`;
  const post=(path:string,body:unknown,csrf=true)=>fetch(base+path,{method:'POST',headers:{cookie:'owner=test',...(csrf?{'x-csrf-token':'test'}:{})},body:JSON.stringify(body)});
  try{
    for(const path of ['/memories','/context-preview'])assert.equal((await fetch(base+path)).status,401);
    assert.equal((await fetch(base+'/memories',{headers:{cookie:'owner=test'}})).status,200);assert.deepEqual(calls[0],{ownerId:'trusted-owner',id:'one'});
    assert.equal((await post('/memories',{idempotencyKey:'abcdefgh'},false)).status,403);
    assert.equal((await post('/memories',{idempotencyKey:'abcdefgh',ownerId:'forged'})).status,400);
    assert.equal((await post('/relationship',{idempotencyKey:'abcdefgh',expectedVersion:0,stage:'dating',send:true})).status,400);
    assert.equal((await post('/style',{idempotencyKey:'abcdefgh',expectedVersion:0,settings:{tone:'自然'}})).status,200);
    assert.equal((await post('/memories/memory/confirm',{idempotencyKey:'abcdefgh',expectedVersion:1})).status,200);
    assert.equal((await post('/memory-controls',{idempotencyKey:'abcdefgh',expectedVersion:0,enabled:false,styleSamples:false,retentionDays:90})).status,200);
    assert.equal(calls.length,2);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('v2 job API reuses Owner session/CSRF, validates revision and never approves on a read',async()=>{
  const writes:unknown[]=[];
  const port={async replyJobs(){return {pipelineVersion:1,items:[]};},async replyJob(_owner:string,id:string,trace:boolean){return {id,status:'PENDING_APPROVAL',trace};},
    async setPipelineVersion(_owner:string,id:string,body:unknown){writes.push({id,body});return {status:'UPDATED'};},
    async approveReplyJob(_owner:string,id:string,body:unknown){writes.push({id,body});return {status:'SEND_QUEUED'};},
    async cancelReplyJob(_owner:string,id:string,body:unknown){writes.push({id,body});return {status:'CANCELLED'};}} satisfies Partial<OwnerPort> as unknown as OwnerPort;
  const server=createServer(createOwnerHttpHandler({ownerPort:port,authenticate:async req=>req.headers.cookie==='owner=fixture'?{ownerId:'trusted-owner'}:null,
    verifyWrite:req=>req.headers['x-csrf-token']==='fixture'}));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const headers={cookie:'owner=fixture','x-csrf-token':'fixture'};
  const post=(path:string,body:unknown,h:Record<string,string>=headers)=>fetch(base+path,{method:'POST',headers:h,body:JSON.stringify(body)});
  try {
    assert.equal((await fetch(base+'/api/v2/reply-jobs/job-1')).status,401);
    assert.equal((await fetch(base+'/api/v2/reply-jobs/job-1/trace',{headers})).status,200);assert.equal(writes.length,0);
    const config={version:2,expectedVersion:1,idempotencyKey:'pipeline-key'};
    assert.equal((await post('/api/v2/conversations/conv-1/pipeline',config,{cookie:'owner=fixture'})).status,403);
    assert.equal((await post('/api/v2/conversations/conv-1/pipeline',{...config,version:3})).status,400);
    assert.equal((await post('/api/v2/conversations/conv-1/pipeline',config)).status,200);
    const approve={taskVersion:1,planVersion:1,alternativeId:'alternative-1',editedParts:[{type:'text',content:'合成回复'}],contentHash:'a'.repeat(64),idempotencyKey:'approve-key'};
    assert.equal((await post('/api/v2/reply-jobs/job-1/approve',approve)).status,400);
    assert.equal((await post('/api/v2/reply-jobs/job-1/approve',{...approve,expectedConversationRevision:2})).status,200);
    assert.equal((await post('/api/v2/reply-jobs/job-1/cancel',{expectedVersion:3,idempotencyKey:'cancel-key'})).status,200);
    assert.equal(writes.length,3);
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('workspace HTTP keeps session/CSRF boundaries, scoped query parameters and truthful routine results',async()=>{
  const reads:unknown[]=[],writes:unknown[]=[];
  const port={async workspaceList(ownerId,query){reads.push({ownerId,query});return {items:[],nextCursor:null};},async workspaceDetail(ownerId,id,before){reads.push({ownerId,id,before});return {conversation:{id},nextCursor:null};},async resumeRoutine(ownerId,id,command){writes.push({ownerId,id,command});return {resultVersion:3,status:'PARTIAL_RESUME',remainingReasons:['UNKNOWN_SEND'],correlationId:'synthetic'};}} as OwnerPort;
  const server=createServer(createOwnerHttpHandler({ownerPort:port,authenticate:async request=>request.headers.cookie==='owner=fixture'?{ownerId:'trusted-owner'}:null,verifyWrite:request=>request.headers['x-csrf-token']==='fixture'}));
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for(const path of ['/api/v1/workspace/conversations','/api/v1/conversations/one/workspace'])assert.equal((await fetch(base+path)).status,401);
    assert.equal(reads.length,0);
    assert.equal((await fetch(base+'/api/v1/workspace/conversations?search=a%20b&platform=qq&filter=attention&limit=50&cursor=10',{headers:{cookie:'owner=fixture'}})).status,200);
    assert.deepEqual(reads[0],{ownerId:'trusted-owner',query:{search:'a b',platform:'qq',filter:'attention',limit:50,cursor:'10'}});
    assert.equal((await fetch(base+'/api/v1/conversations/one/workspace?before=cursor',{headers:{cookie:'owner=fixture'}})).status,200);assert.deepEqual(reads[1],{ownerId:'trusted-owner',id:'one',before:'cursor'});
    const body={expectedVersion:2,idempotencyKey:'abcdefgh'};
    assert.equal((await fetch(base+'/api/v1/contacts/one/resumeRoutine',{method:'POST',headers:{cookie:'owner=fixture'},body:JSON.stringify(body)})).status,403);assert.equal(writes.length,0);
    const result=await fetch(base+'/api/v1/contacts/one/resumeRoutine',{method:'POST',headers:{cookie:'owner=fixture','x-csrf-token':'fixture'},body:JSON.stringify(body)});
    assert.equal(result.status,200);assert.deepEqual((await result.json() as any).remainingReasons,['UNKNOWN_SEND']);assert.deepEqual(writes[0],{ownerId:'trusted-owner',id:'one',command:body});
  } finally {server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});

test('Owner HTTP protects candidate telemetry and validates bounded rejection reasons', async () => {
  const saved: { action: string; command: unknown }[] = [];
  const port = {
    async present(ownerId: string, taskId: string, command: unknown) {
      assert.equal(ownerId, 'trusted-owner'); assert.equal(taskId, 'task-1'); saved.push({ action: 'present', command }); return { resultVersion: 1, correlationId: 'recorded' };
    },
    async reject(_ownerId: string, _taskId: string, command: unknown) { saved.push({ action: 'reject', command }); return { resultVersion: 2, correlationId: 'rejected' }; },
  } as OwnerPort;
  const server = createServer(createOwnerHttpHandler({ ownerPort: port,
    authenticate: async request => request.headers.cookie === 'owner=fixture' ? { ownerId: 'trusted-owner' } : null,
    verifyWrite: request => request.headers['x-csrf-token'] === 'fixture' }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const command = { expectedVersion: 1, idempotencyKey: 'abcdefgh', shownAlternativeIds: ['alternative-1'] };
  const request = (action: string, body: unknown, headers: Record<string, string> = { cookie: 'owner=fixture', 'x-csrf-token': 'fixture' }) =>
    fetch(`http://127.0.0.1:${address.port}/api/v1/tasks/task-1/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await request('present', command, {})).status, 401);
    assert.equal((await request('present', command, { cookie: 'owner=fixture' })).status, 403);
    assert.equal((await request('present', { ...command, shownAlternativeIds: undefined })).status, 400);
    for (const rejectionReason of ['私密自由文本', null, 1, 'TOO_LONG']) assert.equal((await request('reject', { ...command, rejectionReason })).status, 400);
    assert.equal((await request('reject', { ...command, shownAlternativeIds: ['a', 'a'] })).status, 400);
    assert.equal(saved.length, 0);
    assert.equal((await request('present', command)).status, 200); assert.deepEqual(saved[0], { action: 'present', command });
    for (const rejectionReason of ['not_my_style', 'too_long', 'wrong_tone', 'wrong_fact', 'should_not_reply', undefined]) {
      assert.equal((await request('reject', { ...command, rejectionReason })).status, 200);
      assert.deepEqual(saved.at(-1)!.command, { ...command, ...(rejectionReason ? { rejectionReason } : {}) });
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Owner HTTP denies missing session and CSRF before reaching 02', async () => {
  let called = 0;
  const port: OwnerPort = {
    async overview() { called++; return { version: 1, globalPaused: false, allowedActions: [] }; },
    async tasks() { called++; return { items: [] }; },
    async contacts() { called++; return { items: [] }; },
    async confirm() { called++; return { resultVersion: 1, correlationId: 'command' }; },
    async pauseAll() { called++; return { resultVersion: 1, correlationId: 'command' }; },
    async pauseContact() { called++; return { resultVersion: 1, correlationId: 'command' }; },
  };
  const server = createServer(createOwnerHttpHandler({
    ownerPort: port,
    authenticate: async request => request.headers.cookie === 'owner=fixture' ? { ownerId: 'trusted-owner' } : null,
    verifyWrite: async request => request.headers.origin === 'http://127.0.0.1' && request.headers['x-csrf-token'] === 'fixture-csrf',
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const anonymous = await fetch(url + '/api/v1/tasks');
    assert.equal(anonymous.status, 401);
    const csrf = await fetch(url + '/api/v1/control/pause-all', { method: 'POST', headers: { cookie: 'owner=fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, idempotencyKey: 'abcdefgh' }) });
    assert.equal(csrf.status, 403);
    assert.equal(called, 0);
    const allowed = await fetch(url + '/api/v1/tasks', { headers: { cookie: 'owner=fixture' } });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { items: [] });
    assert.equal(called, 1);
    for (const path of ['/api/v1/skills', '/api/v1/imports', '/api/v1/faults']) {
      const missing = await fetch(url + path, { headers: { cookie: 'owner=fixture' } });
      assert.equal(missing.status, 501);
      assert.equal((await missing.json() as { code: string }).code, 'NOT_IMPLEMENTED');
    }
    assert.equal(called, 1);
    const malformed = await fetch(url + '/api/v1/tasks/task-1/confirm', { method: 'POST', headers: { cookie: 'owner=fixture', origin: 'http://127.0.0.1', 'x-csrf-token': 'fixture-csrf' }, body: '{}' });
    assert.equal(malformed.status, 400);
    assert.equal(called, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Owner HTTP requires a boolean resume and forwards only an explicit request to clear UNKNOWN_SEND', async () => {
  const saved: unknown[] = [];
  const port: OwnerPort = {
    async overview() { return {}; }, async tasks() { return { items: [] }; }, async contacts() { return { items: [] }; },
    async confirm() { throw new Error('UNUSED'); }, async pauseAll() { throw new Error('UNUSED'); },
    async pauseContact() { throw new Error('UNUSED'); },
    async resolveSend(_ownerId, _sendId, command) { saved.push(command); return { resultVersion: 2, correlationId: 'resolved' }; },
  };
  const server = createServer(createOwnerHttpHandler({ ownerPort: port,
    authenticate: async () => ({ ownerId: 'trusted-owner' }), verifyWrite: async () => true }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const command = { expectedVersion: 1, idempotencyKey: 'abcdefgh', status: 'DELIVERED', evidenceRef: 'fixture:friend-confirmed' };
  const request = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/v1/sends/send-1/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    for (const resume of ['true', 1, null, {}]) assert.equal((await request({ ...command, resume })).status, 400);
    assert.equal(saved.length, 0);
    assert.equal((await request({ ...command, resume: true })).status, 200);
    assert.deepEqual(saved[0], { ...command, resume: true });
    assert.equal((await request({ ...command, resume: false })).status, 200);
    assert.deepEqual(saved[1], command);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Owner HTTP preserves 409 and does not claim a send', async () => {
  const port: OwnerPort = {
    async overview() { return {}; }, async tasks() { return { items: [] }; }, async contacts() { return { items: [] }; },
    async confirm() { throw new Error('STALE_PLAN'); },
    async pauseAll() { throw new Error('PAUSED'); },
    async pauseContact() { throw new Error('PAUSED'); },
  };
  const server = createServer(createOwnerHttpHandler({ ownerPort: port, authenticate: async () => ({ ownerId: 'trusted-owner' }), verifyWrite: async () => true }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tasks/task-1/confirm`, {
      method: 'POST', body: JSON.stringify({ taskVersion: 1, planVersion: 1, alternativeId: 'alternative-1', editedParts: [{ type: 'text', content: '你好' }], contentHash: 'a'.repeat(64), idempotencyKey: 'abcdefgh' }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { code: string; correlationId: string };
    assert.equal(body.code, 'STALE_PLAN');
    assert.ok(body.correlationId);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Owner HTTP accepts bounded expression preferences in a contact policy edit', async () => {
  let saved: unknown;
  const port: OwnerPort = {
    async overview() { return {}; }, async tasks() { return { items: [] }; }, async contacts() { return { items: [] }; },
    async confirm() { throw new Error('UNUSED'); }, async pauseAll() { throw new Error('UNUSED'); },
    async pauseContact() { throw new Error('UNUSED'); },
    async updatePolicy(_ownerId, _contactId, command) { saved = command.policy; return { resultVersion: 2, correlationId: 'saved' }; },
  };
  const server = createServer(createOwnerHttpHandler({ ownerPort: port,
    authenticate: async () => ({ ownerId: 'trusted-owner' }), verifyWrite: async () => true }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/contacts/contact-1/updatePolicy`;
  try {
    const command = { expectedVersion: 1, idempotencyKey: 'abcdefgh',
      policy: { goal: '自然聊天', stylePreferences: ['简短', '口语化'], restrictions: ['不提钱'] } };
    const valid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    assert.equal(valid.status, 200);
    assert.deepEqual(saved, command.policy);
    const invalid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...command, policy: { stylePreferences: ['x'.repeat(121)] } }) });
    assert.equal(invalid.status, 400);
    assert.deepEqual(saved, command.policy);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
