/** Synthetic UI acceptance; never connects to running core or a real platform. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright';

const settings={skip:process.env.RUN_BROWSER_E2E!=='1' && 'set RUN_BROWSER_E2E=1',timeout:30000};
async function fixture(width=1440,candidateOnly=false) {
  const build=resolve(process.env.WEB_TEST_BUILD??'apps/web/build');
  const server=createServer(async(req,res)=>{
    try { const path=resolve(build,new URL(req.url!,'http://localhost').pathname.slice(1)||'index.html');
      if (!path.startsWith(build+sep)) {res.writeHead(403);res.end();return;}
      res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/html');res.end(await readFile(path));
    } catch {res.writeHead(404);res.end();}
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const {chromium}=await import('playwright'),browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width,height:900}});
  page.setDefaultTimeout(5000);
  const state={ version:1, failQuery:false, uncertain:false, sent:false, delayA:false, delayCommand:false, extra:false, hidden:false, globalPaused:false,
    requests:[] as {path:string;body:any}[], queries:0, historyQueries:0,pipelineVersion:1,memoryStatus:'pending',uncertainMemory:false,factScopes:[] as string[],modelVersion:0,jobStatus:'PENDING_APPROVAL',modelConfig:{decisionProvider:'local-rules',economyProvider:'local-fixture',qualityProvider:'local-fixture',fallbackProvider:null,cloudAllowed:false,timeoutMs:30000,dailyCallLimit:100,dailyTokenLimit:500000,maxReplyCharacters:200,contactOverrides:{}} };
  const message=(n:number)=>({id:`m-${n}`,actor:n%3?'contact':'owner',type:'text',text:`合成消息 ${n}：周末一起出去走走吧。`,at:new Date(Date.UTC(2026,9,6,8,n)).toISOString()});
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    const json=(data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(path.endsWith('/session')||path.endsWith('/session/login'))return json({csrfToken:'synthetic',ownerId:'synthetic-owner'});
    if(path.endsWith('/session/logout'))return json({status:'ok'});
    if(path.endsWith('/overview'))return json({globalPaused:false,pendingCount:0,unknownSendCount:0,allowedActions:[],connections:[],faults:[],connectionQueryStatus:'ready',faultQueryStatus:'ready'});
    if(path.includes('/workspace/conversations'))return json({candidateOnly,total:2,nextCursor:null,items:['a','b'].map((id,i)=>({id,contactId:`contact-${id}`,contactName:i?'小林':'小夏',platform:i?'qq':'wechat',pendingCount:1,preview:'周末一起出去走走吧。',needsAttention:false}))});
    if(path.endsWith('/workspace')) {
      state.queries++;
      if(state.failQuery)return json({code:'DB_UNAVAILABLE',message:'合成查询中断',correlationId:'synthetic-query'},503);
      const id=path.split('/')[4],history=url.searchParams.has('before');if(history)state.historyQueries++;
      if(id==='a'&&state.delayA)await sleep(300);
      const task={replyJob:state.pipelineVersion===2?{id:`job-${id}`,version:1,status:state.sent?'SEND_QUEUED':state.jobStatus,conversationRevision:1,reasonCode:null,decision:{strategy:'自然回应',risk_level:'low',action:'reply'},route:{reason:'SIMPLE_ECONOMY',decisionProvider:'local-rules',generationProvider:'local-fixture'},quality:[],sends:state.sent?[{id:'send-1',status:'CREATED'}]:[]}:undefined,id:`task-${id}`,taskId:`task-${id}`,conversationId:id,contactId:`contact-${id}`,contactName:id==='a'?'小夏':'小林',planId:`plan-${id}`,planVersion:state.version,taskVersion:state.version,version:state.version,
        status:state.sent?'APPROVED':'AWAITING_CONFIRMATION',allowedActions:state.sent||state.globalPaused?[]:['confirmPlan','regeneratePlan','rejectPlan'],reasonCodes:[],triggerMessages:[{id:'trigger',type:'text',text:'周末有空吗？'}],sends:state.sent?[{sendTaskId:'send-1',status:'CREATED'}]:[],
        alternatives:[{alternativeId:'alt-1',strategySummary:'自然回应邀约',parts:[{replyPartId:'part-1',type:'text',content:`${id==='a'?'有空呀，我们找个地方逛逛':'好呀，下午见'}${state.version>1?'，我刚看完消息':''}`}]}]};
      return json({candidateOnly,contact:{id:`contact-${id}`,name:id==='a'?'小夏':'小林',platform:id==='a'?'wechat':'qq',version:1,status:'READY_CONFIRM',allowedActions:['updatePolicy'],agentEnabled:true,sendMode:'confirm',goal:'自然聊天',policyVersion:1,stylePreferences:['简短','自然'],restrictions:[],allowedWindows:[]},
        conversation:{id,contactId:`contact-${id}`,contactName:task.contactName,version:1,status:'READY_CONFIRM',globalPaused:state.globalPaused,globalVersion:2,allowedActions:['pauseContact'],pauseReasons:[],revision:1,generation:1,messages:history?Array.from({length:10},(_,i)=>message(i)):Array.from({length:state.extra?51:50},(_,i)=>message(i+10)),sends:state.sent?[{sendTaskId:'send-1',version:1,sequence:1,status:'CREATED',content:state.requests.find(r=>r.path.endsWith('/confirm')||r.path.endsWith('/approve'))?.body.editedParts[0].content,at:'2026-10-06T09:30:00Z'}]:[]},
        tasks:[task],nextCursor:history?null:'history-cursor'});
    }
    if(req.method()==='POST') {
      const body=req.postDataJSON();state.requests.push({path,body});
      if(path.endsWith('/confirm')) {if(state.uncertain)return route.abort('failed');state.sent=true;}
      if(path.endsWith('/regenerate'))state.version++;
      if(path.endsWith('/policy')&&body.policy?.factScopes)state.factScopes=body.policy.factScopes;
      if(path.endsWith('/resume-all'))state.globalPaused=false;
      if(path.endsWith('/pauseContact') && state.delayCommand)await sleep(300);
      return json({status:'RECORDED',resultVersion:state.version});
    }
    return json({items:[]});
  });
  await page.route('**/api/v2/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    const json=(data:unknown)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    if(req.method()==='POST'){
      const body=req.postDataJSON();state.requests.push({path,body});assert.equal(req.headers()['x-csrf-token'],'synthetic');
      if(state.uncertainMemory)return route.abort('failed');
      if(path.endsWith('/pipeline'))state.pipelineVersion=body.version;
      if(path.endsWith('/model-config')){state.modelConfig=body.config;state.modelVersion++;}
      if(path.endsWith('/approve')){if(state.uncertain)return route.abort('failed');state.sent=true;}
      if(path.endsWith('/cancel'))state.jobStatus='CANCELLED';
      if(path.endsWith('/confirm'))state.memoryStatus='active';
      if(path.endsWith('/delete'))state.memoryStatus='deleted';
      return json({status:state.memoryStatus,version:2,resultVersion:state.modelVersion});
    }
    if(path.endsWith('/model-config'))return json({version:state.modelVersion,config:state.modelConfig,providers:[{key:'local-rules',task:'decision',modelId:'rules',cloud:false,dataRegion:'local',retentionPolicy:'local-only'},{key:'local-fixture',task:'generation',modelId:'fixture',cloud:false,dataRegion:'local',retentionPolicy:'local-only'}]});
    if(path.endsWith('/model-usage'))return json({totals:{calls:4,errors:1,running:0,p50Ms:20,p95Ms:50},costs:[{currency:null,knownCost:null,unknownCalls:4}],models:[{task:'generation',modelId:'synthetic-model',modelVersion:'p6',providerKey:'synthetic',currency:null,calls:4,errors:1,usageKnownCalls:0,unknownCostCalls:4,inputTokens:null,outputTokens:null,knownCost:null,p95Ms:50}]});
    const job={id:'job-a',version:1,status:state.sent?'SEND_QUEUED':state.jobStatus,conversationRevision:1,reasonCode:null,decision:{strategy:'自然回应',risk_level:'low',action:'reply'},route:{reason:'SIMPLE_ECONOMY',decisionProvider:'local-rules',generationProvider:'local-fixture'},quality:[{candidateKey:'a',style:'natural',status:'passed',reasons:[]}],sends:state.sent?[{id:'send-1',status:'CREATED'}]:[]};
    if(path.endsWith('/reply-jobs'))return json({pipelineVersion:state.pipelineVersion,conversationVersion:1,contactId:'contact-a',factScopes:state.factScopes,items:state.pipelineVersion===2?[job]:[]});
    if(path.includes('/reply-jobs/job-a'))return json({...job,transitions:[{to_status:'DECIDING'}],modelCalls:[{model_id:'fixture'}]});
    if(path.endsWith('/memories'))return json({items:path.includes('/a/')?[{id:'memory-synthetic',version:1,contactId:'contact-a',status:state.memoryStatus,memoryType:'preference',content:'我喜欢吃饺子',object:'饺子',evidenceType:'explicit_statement',evidenceRefs:[{id:'source-synthetic',version:1}]}]:[],
      relationship:{confirmedStage:'unknown',version:0,locked:false,sourceRefs:[]},personalStyle:{settings:{},statistics:{sampleSize:12},contactVersion:1,globalVersion:1,examples:[],sourceRefs:[]},controls:{enabled:true,styleSamples:true,retentionDays:90,version:0}});
    if(path.endsWith('/context-preview'))return json({status:'valid',context:{recentMessages:[{id:'current'}],memories:[{id:'memory-synthetic'}],summary:null,budget:{estimatedInputTokens:256},selection:[{id:'memory-synthetic',included:true,reason:'chinese_keyword'}]}});
    return json({items:[]});
  });
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  return {page,state,url,close:async()=>{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}};
}
async function refresh(page:Page) {await Promise.all([page.waitForResponse(r=>r.url().includes('/a/workspace')),page.getByRole('button',{name:'刷新',exact:true}).click()]);}
const editor=(page:Page)=>page.getByLabel('发送前编辑');

test('v21 mobile controls save Shadow selectors without approval, and L4 review is visible',settings,async()=>{
  const f=await fixture(390);try{
    f.state.pipelineVersion=2;
    await f.page.route('**/api/v2/model-config',async route=>{
      if(route.request().method()==='POST')return route.fallback();
      return route.fulfill({contentType:'application/json',body:JSON.stringify({version:f.state.modelVersion,config:f.state.modelConfig,providers:[{key:'local-rules',task:'decision',modelId:'rules',cloud:false},{key:'local-fixture',task:'generation',modelId:'fixture',cloud:false},{key:'test-analysis',task:'analysis',modelId:'synthetic-analyzer',cloud:false}]})});
    });
    await f.page.route('**/api/v2/conversations/a/reply-jobs',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({pipelineVersion:2,items:[{id:'job-review',version:1,status:'SKIPPED',conversationRevision:1,reasonCode:'HUMAN_REVIEW_REQUIRED',decision:{strategy:'本人核对',risk_level:'high',action:'ask_user',classification_level:'L4',classification_confidence:0.95},route:{decisionProvider:'synthetic',generationProvider:null,reason:'HUMAN_REVIEW_REQUIRED',engineV21:{mode:'active',upgradeReasons:[],classifierModelId:'synthetic',classificationElapsedMs:10,analysisStatus:'not_needed',analysisModelId:null,analysisElapsedMs:null}},quality:[],sends:[]}]})}));
    await f.page.goto(f.url+'/#chat/a');await f.page.getByText('需要本人审核。', {exact:false}).waitFor();assert.equal(await f.page.getByRole('button',{name:'重新生成本轮候选',exact:true}).count(),0);
    await f.page.getByRole('link',{name:'模型配置',exact:true}).click();await f.page.getByText('四级决策 v2.1',{exact:true}).click();
    await f.page.getByLabel('运行模式',{exact:true}).selectOption('shadow');await f.page.getByLabel('复杂情绪分析模型',{exact:true}).selectOption('test-analysis');
    await f.page.getByRole('button',{name:'保存模型配置',exact:true}).click();await f.page.getByText('模型配置已保存，正在生成和待审批的旧候选已过期。',{exact:true}).waitFor();
    const command=f.state.requests.find(r=>r.path.endsWith('/model-config'))!.body;assert.equal(command.config.decisionEngineV21.mode,'shadow');assert.equal(command.config.decisionEngineV21.analysisProvider,'test-analysis');assert.equal(f.state.requests.some(r=>r.path.endsWith('/approve')||r.path.endsWith('/confirm')),false);
    assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await mkdir(resolve('output/playwright'),{recursive:true});await f.page.screenshot({path:resolve('output/playwright/decision-v21-shadow-390.png'),fullPage:true});
  }finally{await f.close();}
});

test('P5 mobile v2 approval binds the revision, shows diagnosis and preserves the edited final text',settings,async()=>{
  const f=await fixture(320);try{
    f.state.pipelineVersion=2;await f.page.goto(f.url+'/#chat/a');await editor(f.page).waitFor();
    await f.page.getByRole('button',{name:'自然型',exact:true}).waitFor();await editor(f.page).fill('这是本人最终确认的文字');
    await mkdir(resolve('output/playwright'),{recursive:true});await f.page.screenshot({path:resolve('output/playwright/v2-reply-mobile-320.png'),fullPage:true});
    await f.page.getByText('本轮生成说明',{exact:true}).click();await f.page.getByRole('button',{name:'读取完整诊断链路'}).click();await f.page.getByText('完整诊断记录',{exact:true}).click();await f.page.locator('.reply-job-panel pre').waitFor();
    assert.match(await f.page.locator('.reply-job-panel pre').textContent()??'',/DECIDING/);assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await f.page.getByRole('button',{name:'确认并发送',exact:true}).click();
    for(let i=0;i<20&&!f.state.sent;i++)await sleep(50);
    const approval=f.state.requests.find(r=>r.path==='/api/v2/reply-jobs/job-a/approve')!;assert.ok(approval);assert.equal(approval.body.expectedConversationRevision,1);assert.equal(approval.body.editedParts[0].content,'这是本人最终确认的文字');assert.equal(f.state.requests.filter(r=>r.path.startsWith('/api/v1/tasks/')&&r.path.endsWith('/confirm')).length,0);
  }finally{await f.close();}
});
test('model configuration is separate from chat settings and usage stays in overview',settings,async()=>{
  const f=await fixture(320);try{
    await f.page.goto(f.url+'/#chat/a');await editor(f.page).waitFor();await f.page.getByRole('button',{name:'聊天设置',exact:true}).click();
    assert.equal(await f.page.getByLabel('普通聊天生成模型').count(),0);await f.page.getByRole('link',{name:'打开模型配置 →',exact:true}).click();
    await f.page.getByLabel('普通聊天生成模型').waitFor();await f.page.getByLabel('每日云端调用上限').fill('8');await f.page.getByRole('button',{name:'保存模型配置',exact:true}).click();
    await f.page.getByText('模型配置已保存，正在生成和待审批的旧候选已过期。',{exact:true}).waitFor();
    const save=f.state.requests.find(r=>r.path==='/api/v2/model-config')!;assert.equal(save.body.config.dailyCallLimit,8);assert.equal(save.body.expectedVersion,0);assert.ok(save.body.idempotencyKey);
    assert.equal(await f.page.getByRole('heading',{name:'模型用量',exact:true}).count(),0);await f.page.getByRole('link',{name:'运行状态',exact:true}).click();await f.page.getByText('费用暂未提供 · 部分调用费用未知',{exact:true}).waitFor();await f.page.getByText('查看调用统计',{exact:true}).click();await f.page.getByText('synthetic-model · 4 次调用 · 错误 1 次',{exact:true}).waitFor();assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.equal(f.state.sent,false);
    await mkdir(resolve('output/playwright'),{recursive:true});await f.page.screenshot({path:resolve('output/playwright/v2-model-mobile-320.png'),fullPage:true});
  }finally{await f.close();}
});

test('memory panel: opt-in, confirmed memory, preview and deletion work on mobile without sending a reply',settings,async()=>{
  const f=await fixture(320);try{
    await f.page.goto(f.url+'/#chat/a');await editor(f.page).waitFor();await f.page.getByRole('button',{name:'聊天设置',exact:true}).click();
    const toggle=f.page.getByLabel('使用 v2 上下文与记忆');await toggle.click();const access=f.page.getByLabel('回复中使用此联系人已确认记忆');await access.click();await f.page.waitForFunction(()=>Array.from(document.querySelectorAll('label')).some(l=>l.textContent?.includes('回复中使用此联系人已确认记忆')&&l.querySelector('input')?.checked));await f.page.getByRole('button',{name:'确认事实',exact:true}).click();await f.page.getByText('偏好 · 有效',{exact:true}).waitFor();
    await f.page.getByRole('button',{name:'查看最近回复使用的资料'}).click();await f.page.getByText('上下文检查 · 有效',{exact:true}).waitFor();assert.match(await f.page.locator('.chat-settings pre').textContent()??'',/chinese_keyword/);
    assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await f.page.getByRole('button',{name:'删除',exact:true}).click();await f.page.getByText('我喜欢吃饺子',{exact:true}).waitFor({state:'hidden'});
    assert.equal(f.state.requests.filter(r=>r.path.startsWith('/api/v1/tasks/')&&r.path.endsWith('/confirm')).length,0);assert.deepEqual(f.state.requests.find(r=>r.path.endsWith('/pipeline'))!.body.version,2);assert.deepEqual(f.state.requests.find(r=>r.path.endsWith('/policy'))!.body.policy.factScopes,['contact-a']);
  }finally{await f.close();}
});
test('memory panel: uncertain write stays pending and explicit retry reuses the idempotency key',settings,async()=>{
  const f=await fixture();try{
    await f.page.goto(f.url+'/#chat/a');await editor(f.page).waitFor();await f.page.getByRole('button',{name:'聊天设置',exact:true}).click();f.state.uncertainMemory=true;
    await f.page.getByRole('button',{name:'确认事实',exact:true}).click();const retry=f.page.getByRole('button',{name:'重试同一请求',exact:true});await retry.waitFor();assert.equal(await f.page.getByRole('button',{name:'确认事实',exact:true}).isDisabled(),true);
    assert.equal(f.state.requests.filter(r=>r.path.includes('/memories/')).length,1);f.state.uncertainMemory=false;await retry.click();await f.page.getByText('偏好 · 有效',{exact:true}).waitFor();
    const writes=f.state.requests.filter(r=>r.path.includes('/memories/'));assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);
  }finally{await f.close();}
});

test('desktop: switching, polling and delayed responses preserve per-chat drafts; login exit clears them',settings,async()=>{
  const f=await fixture();try {
    await f.page.goto(f.url+'/#chat/a');await editor(f.page).fill('我的草稿 A');await refresh(f.page);assert.equal(await editor(f.page).inputValue(),'我的草稿 A');
    f.state.delayA=true;await f.page.getByRole('button',{name:'刷新',exact:true}).click();
    await f.page.locator('.conversation-item').filter({hasText:'小林'}).click();await editor(f.page).fill('我的草稿 B');
    await sleep(350);assert.equal(await editor(f.page).inputValue(),'我的草稿 B');assert.equal(await f.page.locator('.chat-heading h2').textContent(),'小林');
    f.state.delayA=false;await f.page.locator('.conversation-item').filter({hasText:'小夏'}).click();await editor(f.page).waitFor();assert.equal(await editor(f.page).inputValue(),'我的草稿 A');
    const before=f.state.queries;await f.page.waitForFunction(n=>document.querySelector('.sync-time')!==null,before);await sleep(3100);
    assert.ok(f.state.queries>before);assert.equal(await editor(f.page).inputValue(),'我的草稿 A');
    await f.page.getByRole('button',{name:'退出登录'}).click();await f.page.getByLabel('密码').fill('synthetic');await f.page.getByRole('button',{name:'登录',exact:true}).click();await editor(f.page).waitFor();assert.match(await editor(f.page).inputValue(),/^有空呀/);
  } finally {await f.close();}
});

test('desktop: keyset history preserves the reading position; live messages show a hint; stale edits remain copyable',settings,async()=>{
  const f=await fixture();try {
    await f.page.goto(f.url+'/#chat/a');await editor(f.page).fill('不能丢失的旧草稿');
    await f.page.locator('.message-timeline').evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
    const anchor=f.page.getByText('合成消息 10：周末一起出去走走吧。',{exact:true}),before=(await anchor.boundingBox())!.y;
    await f.page.getByRole('button',{name:'加载更早消息'}).click();await f.page.getByText('合成消息 0：周末一起出去走走吧。',{exact:true}).waitFor();
    assert.ok(Math.abs((await anchor.boundingBox())!.y-before)<5,'history insertion preserves the visible anchor');assert.equal(f.state.historyQueries,1);
    const top=await f.page.locator('.message-timeline').evaluate(el=>el.scrollTop);f.state.extra=true;await refresh(f.page);
    await f.page.getByRole('button',{name:'有新消息，点击查看 ↓'}).waitFor();assert.ok(Math.abs(await f.page.locator('.message-timeline').evaluate(el=>el.scrollTop)-top)<5);
    assert.equal(await editor(f.page).inputValue(),'不能丢失的旧草稿');f.state.version++;await refresh(f.page);await f.page.getByText('保留的编辑内容（1）',{exact:true}).click();
    assert.equal(await f.page.getByLabel('旧方案编辑内容').inputValue(),'不能丢失的旧草稿');assert.notEqual(await editor(f.page).inputValue(),'不能丢失的旧草稿');
    await editor(f.page).fill('最新版本');await editor(f.page).press('Control+Enter');await f.page.locator('.send-bubble').getByText(/尚未发送/).waitFor();
    const sent=f.state.requests.filter(r=>r.path.endsWith('/confirm'));assert.equal(sent.length,1);assert.equal(sent[0].body.planVersion,2);assert.equal(sent[0].body.editedParts[0].content,'最新版本');
  } finally {await f.close();}
});

test('desktop: uncertain confirmation never retries automatically and explicit retry reuses the exact request',settings,async()=>{
  const f=await fixture();try {
    await f.page.goto(f.url+'/#chat/a');await editor(f.page).fill('');await editor(f.page).press('Control+Enter');assert.equal(f.state.requests.filter(r=>r.path.endsWith('/confirm')).length,0);
    await editor(f.page).fill('编辑后再确认');await editor(f.page).press('Enter');assert.equal(f.state.requests.filter(r=>r.path.endsWith('/confirm')).length,0);
    await editor(f.page).dispatchEvent('keydown',{key:'Enter',metaKey:true,isComposing:true});assert.equal(f.state.requests.filter(r=>r.path.endsWith('/confirm')).length,0);
    f.state.failQuery=true;await refresh(f.page);await f.page.getByText(/数据可能已过期/).waitFor();assert.equal(await f.page.getByRole('button',{name:'确认并发送'}).isDisabled(),true);assert.match(await editor(f.page).inputValue(),/编辑后再确认/);
    f.state.failQuery=false;await refresh(f.page);f.state.uncertain=true;await f.page.getByRole('button',{name:'确认并发送'}).click();await f.page.getByRole('button',{name:'重试同一请求'}).waitFor();
    await sleep(3200);assert.equal(f.state.requests.filter(r=>r.path.endsWith('/confirm')).length,1);assert.equal(await f.page.getByRole('button',{name:'确认并发送'}).isDisabled(),true);
    f.state.uncertain=false;await f.page.getByRole('button',{name:'重试同一请求'}).click();await f.page.locator('.send-bubble').getByText(/尚未发送/).waitFor();
    const commands=f.state.requests.filter(r=>r.path.endsWith('/confirm'));assert.equal(commands.length,2);assert.deepEqual(commands[0].body,commands[1].body);
  } finally {await f.close();}
});

test('workspace: a hidden page pauses polling and becoming visible immediately refreshes',settings,async()=>{
  const f=await fixture();try {
    await f.page.goto(f.url+'/#chat/a');await editor(f.page).waitFor();
    await f.page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
    const before=f.state.queries;await sleep(3200);assert.equal(f.state.queries,before);
    const response=f.page.waitForResponse(r=>r.url().includes('/a/workspace'));
    await f.page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});await response;assert.ok(f.state.queries>before);
  } finally {await f.close();}
});

test('workspace: global pause can be explicitly recovered in the current chat without sending',settings,async()=>{
  const f=await fixture(390);try {
    f.state.globalPaused=true;await f.page.goto(f.url+'/#chat/a');await f.page.getByRole('button',{name:'恢复全部代理'}).click();await f.page.getByRole('button',{name:'确认并发送'}).waitFor();
    assert.equal(new URL(f.page.url()).hash,'#chat/a');const command=f.state.requests.find(r=>r.path.endsWith('/resume-all'));assert.equal(command?.body.expectedVersion,2);assert.equal(f.state.requests.filter(r=>r.path.endsWith('/confirm')).length,0);
  } finally {await f.close();}
});

test('workspace: a delayed command result is never shown on another contact',settings,async()=>{
  const f=await fixture();try {
    f.state.delayCommand=true;await f.page.goto(f.url+'/#chat/a');await f.page.getByRole('button',{name:'暂停此聊天'}).click();await f.page.locator('.conversation-item').filter({hasText:'小林'}).click();await editor(f.page).waitFor();
    await sleep(350);assert.equal(await f.page.locator('.chat-heading h2').textContent(),'小林');assert.equal(await f.page.locator('.chat-panel .notice').count(),0);assert.match(await editor(f.page).inputValue(),/^好呀/);
  } finally {await f.close();}
});

test('desktop and 320–390px: list/detail, editor and primary actions fit; synthetic preview artifacts',settings,async()=>{
  await mkdir(resolve('output/playwright'),{recursive:true});
  for (const width of [1440,390,320]) {const f=await fixture(width);try {
    await f.page.goto(f.url+'/#chat/a');await editor(f.page).waitFor();assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    const button=await f.page.getByRole('button',{name:'确认并发送'}).boundingBox();assert.ok(button && button.x>=0 && button.x+button.width<=width && button.y+button.height<=900);
    await f.page.screenshot({path:resolve(`output/playwright/workspace-${width}.png`),fullPage:true});
    await f.page.getByRole('button',{name:'聊天设置',exact:true}).click();await f.page.getByRole('button',{name:'保存聊天设置'}).waitFor();assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await f.page.getByRole('button',{name:'关闭',exact:true}).click();
    if(width<800) {await f.page.getByRole('button',{name:'← 返回'}).click();await f.page.getByLabel('搜索联系人').fill('小夏');assert.equal(await f.page.locator('.chat-panel').isVisible(),false);await f.page.locator('.conversation-item').first().click();await editor(f.page).waitFor();}
  } finally {await f.close();}}
});

for(const width of [320,390])test('Qwen two-role settings save and apply locally without exposing credentials or sending at '+width+'px',settings,async()=>{
 const f=await fixture(width,true);try{
  const states=new Map();await f.page.route(/\/api\/v2\/trial-(?:economy|quality)-settings(?:\/apply)?$/,async route=>{
   const req=route.request(),path=new URL(req.url()).pathname,role=path.includes('economy')?'economy':'quality';let state=states.get(role)??{version:0,phase:'unconfigured',hasApiKey:false,model:null,activeModelId:null,canApply:true};
   if(req.method()==='POST') {const body=req.postDataJSON();f.state.requests.push({path,body});assert.equal(req.headers()['x-csrf-token'],'synthetic');if(path.endsWith('/apply')) state={...state,phase:'active',activeModelId:state.model.modelId};else {assert.equal(body.model.thinkingParameter,'enable_thinking');assert.equal(body.model.thinking,'disabled');const {apiKey,...model}=body.model;assert.equal(apiKey,'synthetic-private-qwen-key');state={...state,version:state.version+1,phase:'saved',model,hasApiKey:true};}states.set(role,state);}
   return route.fulfill({contentType:'application/json',body:JSON.stringify(state)});
  });
  await f.page.goto(f.url+'/#models');
  for(const role of ['economy','quality']){const title=role==='economy'?'低成本模型':'高档模型',panel=f.page.getByRole('region',{name:title+'配置',exact:true});await panel.waitFor();assert.equal(await panel.getByLabel('输入价格（元 / 百万 token）',{exact:true}).isVisible(),false);assert.equal(await panel.getByLabel(title+'名称',{exact:true}).inputValue(),role==='economy'?'qwen3.7-flash':'qwen3.5-plus');await panel.getByLabel('API 密钥',{exact:true}).fill('synthetic-private-qwen-key');await panel.getByRole('button',{name:'保存'+title+'配置',exact:true}).click();await panel.getByRole('button',{name:'启用已保存配置',exact:true}).waitFor();assert.equal(await panel.getByLabel('API 密钥',{exact:true}).inputValue(),'');await panel.getByRole('button',{name:'启用已保存配置',exact:true}).click();await panel.getByText('状态：已启用',{exact:false}).waitFor();}
  assert.equal(f.state.requests.filter(r=>r.path.startsWith('/api/v2/trial-')).length,4);assert.equal(f.state.requests.some(r=>r.path.endsWith('/approve')||r.path.endsWith('/confirm')),false);assert.equal(await f.page.evaluate(()=>Object.values(localStorage).join('').includes('synthetic-private-qwen-key')),false);assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 }finally{await f.close();}
});
