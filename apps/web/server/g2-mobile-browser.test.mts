/** UI regression with synthetic HTTP responses. This is not platform or PG acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled = process.env.RUN_BROWSER_E2E === '1';
const build = resolve(dirname(fileURLToPath(import.meta.url)), '../build');
const evidence = resolve(dirname(fileURLToPath(import.meta.url)), '../evidence');

async function fixture(mode: 'stale' | 'unknown' | 'ready' | 'queue' | 'feedback') {
  let stale = false;
  let contact = { id: 'contact-1', version: 1, status: 'READY_CONFIRM', allowedActions: ['updatePolicy'],
    name: '测试联系人', platform: 'wechat', agentEnabled: true, sendMode: 'confirm', goal: '自然聊天',
    activeContactEnabled: false, activeConfessionEnabled: false, allowedWindows: [],
    restrictions: [] as string[], stylePreferences: [] as string[], pauseReasons: [] as string[], policyVersion: 1 };
  let savedPolicy: Record<string, unknown> | undefined;
  const resolutions: Record<string, unknown>[] = [];
  const candidateCommands: { action: string; body: Record<string, unknown> }[] = [];
  const task = () => ({ id: 'task-1', taskId: 'task-1', taskVersion: stale ? 2 : 1, version: stale ? 2 : 1,
    planId: 'plan-1', planVersion: stale ? 2 : 1, contactId: 'contact-1', contactName: '测试联系人',
    conversationId: 'conversation-1', status: stale ? 'INVALIDATED' : 'AWAITING_CONFIRMATION',
    allowedActions: stale ? [] : mode === 'feedback' ? ['confirmPlan', 'rejectPlan', 'regeneratePlan'] : ['confirmPlan'], reasonCodes: ['AUTO_REVIEW_UNAVAILABLE'],
    triggerMessages: [{ id: 'message-1', type: 'text', text: '你好', at: '2026-09-24T00:00:00Z' }],
    alternatives: [{ alternativeId: 'a-1', strategySummary: '回应', parts: [{ replyPartId: 'part-1', sequence: 1, type: 'text', content: '你好呀' }] }],
    sends: [], ...(stale ? { invalidationReason: 'NEW_MESSAGE' } : {}) });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const json = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (path === '/api/v1/session') return json(200, { ownerId: 'fixture-owner', csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' });
    if (path === '/api/v1/workspace/conversations') {
      const params=new URL(request.url!, 'http://localhost').searchParams;
      let items=[{id:'conversation-1',contactId:'contact-1',contactName:'测试联系人',platform:'wechat',pendingCount:stale?0:1,needsAttention:false,preview:'你好'}];
      if(mode==='queue') items.push({ ...items[0], id:'conversation-unknown',contactName:'需核对联系人',pendingCount:0,needsAttention:true },{ ...items[0], id:'conversation-past',contactName:'已处理联系人',pendingCount:0 });
      if(params.get('filter')==='attention') items=items.filter(i=>i.needsAttention);
      return json(200,{items,total:items.length,nextCursor:null});
    }
    if (/^\/api\/v1\/conversations\/[^/]+\/workspace$/.test(path)) {
      if(mode==='unknown')return json(503,{code:'MODEL_UNAVAILABLE',message:'故障',retryable:true,correlationId:'trace-503'});
      const id=path.split('/')[4];
      const past=id==='conversation-past',unknown=id==='conversation-unknown';
      const chosen={ ...task(),conversationId:id, ...(past ? {status:'REJECTED',allowedActions:[]} : unknown ? {status:'INVALIDATED',allowedActions:[]} : {}) };
      const sends=mode==='feedback' || mode==='queue' && !unknown ? [] : [{sendTaskId:'unknown-send',version:2,sequence:1,status:'RESULT_UNKNOWN',receiptLevel:'unknown',correlationId:'trace-send'}];
      return json(200,{contact:{...contact,name:past?'已处理联系人':unknown?'需核对联系人':contact.name},conversation:{id,contactId:contact.id,contactName:past?'已处理联系人':unknown?'需核对联系人':contact.name,version:2,status:'PAUSED_OWNER',allowedActions:[],revision:2,generation:2,pauseReasons:['OWNER_ORIGIN'],messages:[{id:'self-1',actor:'unknown',type:'text',text:'来源待核',at:'2026-09-24T00:00:00Z',originEvidenceRefs:['bridge:account-1:0123456789abcdef0123456789abcdef']}],sends},tasks:[chosen],nextCursor:null});
    }
    if (path === '/api/v1/contacts' && request.method === 'GET') return json(200, { items: [contact] });
    if (path === '/api/v1/contacts/contact-1/updatePolicy' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const command = JSON.parse(body) as { policy: Record<string, unknown> };
      savedPolicy = command.policy;
      contact = { ...contact, ...command.policy, version: contact.version + 1, policyVersion: contact.policyVersion + 1 } as typeof contact;
      return json(200, { resultVersion: contact.version, correlationId: 'policy-saved', status: 'UPDATED' });
    }
    if (path === '/api/v1/overview') return json(200, { version: 1, globalPaused: false, allowedActions: [],
      pendingCount: 1, unknownSendCount: 1,
      ...(mode === 'ready' ? { connectionQueryStatus: 'ready', faultQueryStatus: 'ready' } : {}),
      connections: mode === 'ready' ? [{ accountId: 'account-1', platform: 'qq', connectionState: 'reconciling',
        verificationStatus: 'unknown', lastReconciledAt: '未完成', limitations: ['历史范围待核'],
        recovery: { status: 'RECONCILING', historyComplete: false, gaps: ['history_gap'], unresolvedSendCount: 1 } }] : [],
      faults: mode==='ready' ? [{id:'synthetic-fault',status:'ACTIVE',summary:'合成账号故障'}] : [] });
    if (path === '/api/v1/tasks' && request.method === 'GET') return mode === 'unknown'
      ? json(503, { code: 'MODEL_UNAVAILABLE', message: '故障', retryable: true, correlationId: 'trace-503' })
      : json(200, { items: mode === 'queue' ? [task(),
        { ...task(), id: 'past', taskId: 'past', status: 'REJECTED', allowedActions: [], contactName: '已处理联系人' },
        { ...task(), id: 'unresolved', taskId: 'unresolved', status: 'INVALIDATED', allowedActions: [], contactName: '需核对联系人',
          sends: [{ sendTaskId: 'unknown-send', version: 2, sequence: 1, status: 'RESULT_UNKNOWN' }] },
      ] : [task()] });
    if (path === '/api/v1/tasks/task-1/confirm' && request.method === 'POST') {
      stale = true;
      return json(409, { code: 'STALE_PLAN', message: '候选已失效', retryable: false, correlationId: 'trace-409' });
    }
    if (/^\/api\/v1\/tasks\/task-1\/(present|reject)$/.test(path) && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const action = path.split('/').at(-1)!;
      candidateCommands.push({ action, body: JSON.parse(body) });
      if (mode === 'feedback' && action === 'reject' && candidateCommands.filter(c => c.action === 'reject').length === 1)
        return json(503, { code: 'MODEL_UNAVAILABLE', message: '合成临时故障', retryable: true, correlationId: 'feedback-retry' });
      if (action === 'reject') stale = true;
      return json(200, { resultVersion: stale ? 2 : 1, correlationId: 'candidate-recorded', status: 'RECORDED' });
    }
    if (path === '/api/v1/sends/unknown-send/resolve' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      resolutions.push(JSON.parse(body));
      return json(200, { resultVersion: 3, correlationId: 'resolved', clearedReason: 'UNKNOWN_SEND' });
    }
    if (path === '/api/v1/conversations') return json(200, { items: [{
      id: 'conversation-1', version: 2, status: 'PAUSED_OWNER', allowedActions: [],
      contactId: 'contact-1', contactName: '测试联系人', revision: 2, generation: 2, pauseReasons: ['OWNER_ORIGIN'],
      messages: [{ id: 'self-1', actor: 'unknown', originStatus: 'unknown', originEvidenceRefs: ['bridge:account-1:0123456789abcdef0123456789abcdef'], type: 'text', text: '来源待核', at: '2026-09-24T00:00:00Z' }],
      sends: [{ sendTaskId: 'send-1', sequence: 1, status: 'RESULT_UNKNOWN', approvalSource: 'mock_auto', receiptLevel: 'unknown', correlationId: 'trace-send' }],
    }] });
    if (path === '/api/v1/skills' || path === '/api/v1/imports' || path === '/api/v1/faults')
      return json(501, { code: 'NOT_IMPLEMENTED', message: '未接入', retryable: false, correlationId: 'trace-501' });
    if (path.startsWith('/api/v1/')) return json(404, { code: 'NOT_FOUND', message: '缺口', retryable: false, correlationId: 'trace-404' });
    try {
      const target = resolve(build, path === '/' ? 'index.html' : path.slice(1));
      if (target !== build && !target.startsWith(build + sep)) { response.writeHead(403); response.end(); return; }
      const bytes = await readFile(target);
      response.writeHead(200, { 'Content-Type': extname(target) === '.js' ? 'text/javascript' : extname(target) === '.css' ? 'text/css' : 'text/html' });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, savedPolicy: () => savedPolicy, resolutions, candidateCommands,
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())) };
}


const settings = {skip:!enabled && 'set RUN_BROWSER_E2E=1',timeout:20000};
async function browserCase(mode: Parameters<typeof fixture>[0], width: number, action: (page:any,api:Awaited<ReturnType<typeof fixture>>)=>Promise<void>) {
  const {chromium}=await import('playwright');const api=await fixture(mode);const browser=await chromium.launch({headless:true});
  try{const page=await browser.newPage({viewport:{width,height:844},isMobile:true,hasTouch:true});await action(page,api);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);}
  finally{await browser.close();await api.close();}
}
test('390px: candidate telemetry and rejection reason survive a temporary failure',settings,()=>browserCase('feedback',390,async(page,api)=>{
  await page.goto(api.url+'/#chat/conversation-1');await page.getByText('候选说明与反馈',{exact:true}).click();
  await page.getByLabel('不回复原因（可选）').selectOption('too_long');await page.getByRole('button',{name:'不回复',exact:true}).click();
  await page.getByText(/feedback-retry/).first().waitFor();assert.equal(await page.getByLabel('不回复原因（可选）').inputValue(),'too_long');
  await page.getByRole('button',{name:'不回复',exact:true}).click();await page.getByText('当前没有待确认的回复').waitFor();
  const commands=api.candidateCommands.filter(c=>c.action==='reject');assert.equal(commands.length,2);assert.equal(commands[1].body.rejectionReason,'too_long');assert.deepEqual(commands[0].body.shownAlternativeIds,['a-1']);
  assert.ok(api.candidateCommands.some(c=>c.action==='present'));
}));
test('390px: contact settings save expression preferences and restrictions in the current chat',settings,()=>browserCase('ready',390,async(page,api)=>{
  await page.goto(api.url+'/#chat/conversation-1');await page.getByRole('button',{name:'聊天设置',exact:true}).click();
  await page.getByLabel('表达偏好（每行一条）').fill('简短\n口语化');await page.getByLabel('避免内容（每行一条）').fill('不提钱');
  await page.getByRole('button',{name:'保存聊天设置'}).click();await page.getByText('设置已保存',{exact:true}).waitFor();
  assert.deepEqual(api.savedPolicy()?.stylePreferences,['简短','口语化']);assert.deepEqual(api.savedPolicy()?.restrictions,['不提钱']);
}));
test('390px: delivery and resume is explicit, while record-only omits resume',settings,()=>browserCase('ready',390,async(page,api)=>{
  await page.goto(api.url+'/#chat/conversation-1');await page.getByRole('button',{name:'已收到，恢复聊天',exact:true}).click();
  await page.getByText('操作已完成',{exact:true}).waitFor();assert.equal(api.resolutions[0].resume,true);assert.equal(api.resolutions[0].expectedVersion,2);
  await page.getByText('其他核对选项',{exact:true}).click();await page.getByRole('button',{name:'只记已送达',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.notice')?.textContent==='操作已完成');assert.equal(api.resolutions[1]?.resume,undefined);
}));
test('320px: unknown connection coverage, stale confirmation and source evidence remain truthful',settings,()=>browserCase('stale',320,async(page,api)=>{
  await page.goto(api.url+'/#overview');await page.getByText(/连接与恢复查询尚未接入/).waitFor();await page.getByText(/故障汇总查询尚未接入/).waitFor();
  await page.goto(api.url+'/#chat/conversation-1');await page.getByRole('button',{name:'确认并发送'}).click();await page.getByText(/旧版本未发送/).first().waitFor();
  assert.equal(await page.getByRole('button',{name:'确认并发送'}).count(),0);await page.getByText('来源详情',{exact:true}).click();await page.getByText(/bridge:account-1/).waitFor();
}));
test('390px: query failures block actions, and unfinished pages are absent from primary navigation',settings,()=>browserCase('unknown',390,async(page,api)=>{
  await page.goto(api.url+'/#chat/conversation-1');await page.getByText(/trace-503/).waitFor();assert.equal(await page.getByRole('button',{name:'确认并发送'}).count(),0);
  assert.deepEqual(await page.locator('nav a').allTextContents(),['聊天','人物与导入','模型配置','运行状态','更多']);
  for(const name of ['skills','imports','faults']){await page.goto(api.url+'/#'+name);await page.getByText(/持久化接口尚未提供/).waitFor();}
}));
test('390px: unresolved sends remain visible on their conversation, and past candidates are readable',settings,()=>browserCase('queue',390,async(page,api)=>{
  await page.goto(api.url+'/#chat/conversation-unknown');await page.getByRole('button',{name:'已收到，恢复聊天'}).waitFor();assert.equal(await page.getByRole('button',{name:'确认并发送'}).count(),0);
  await page.goto(api.url+'/#chat/conversation-past');await page.getByText('历史候选',{exact:true}).click();await page.getByText('已选择不回复',{exact:true}).waitFor();
}));
test('390px: recovery coverage gaps are shown without claiming connection readiness',settings,()=>browserCase('ready',390,async(page,api)=>{
  await page.goto(api.url+'/#overview');await page.getByText(/history_gap/).waitFor();await page.getByText(/未证实连续/).waitFor();
  await page.getByText('合成账号故障 · 仍需处理',{exact:true}).waitFor();
}));
