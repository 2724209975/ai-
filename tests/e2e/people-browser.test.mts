import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {applyMigrations} from '../../packages/infrastructure/postgres/migrate.mts';
import {withTransaction} from '../../packages/infrastructure/postgres/transaction.mts';
import {PeopleService} from '../../packages/data/people/service.mts';
import {PgDataProvider} from '../../packages/data/postgres/provider.mts';
import {createOwnerHttpHandler,type OwnerPort} from '../../apps/web/server/owner-http.mts';
const enabled=process.env.RUN_BROWSER_E2E==='1',url=process.env.TEST_DATABASE_URL;
test('real browser and PostgreSQL: people linkage, history import preview, dedup, correction and narrow layouts',{skip:(!enabled||!url)&&'browser and isolated database required',timeout:120000},async()=>{
 const {Pool,Client}=await import('pg'),{chromium}=await import('playwright'),schema='people_browser_'+randomBytes(6).toString('hex');
 const admin=new Client({connectionString:url});await admin.connect();let pool:InstanceType<typeof Pool>|undefined,server:ReturnType<typeof createServer>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema}`);await applyMigrations(admin,resolve('db/migrations'));pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});const db=pool,data=new PgDataProvider(),ids:string[]=[];
  for(const platform of ['wechat','qq']){const contactId=randomUUID(),accountId=randomUUID(),conversationId=randomUUID();ids.push(contactId);await withTransaction(db,async tx=>{await tx.query("INSERT INTO orch_platform_accounts(account_id,platform,mapping_status) VALUES($1,$2,'verified')",[accountId,platform]);await data.createContact(tx,{id:contactId,platformAccountId:accountId,conversationId,externalContactRef:platform,displayName:'合成'+platform,enrollmentStatus:'enrolled'});await tx.query('INSERT INTO dispatch_control(conversation_id,account_id,paused) VALUES($1,$2,true)',[conversationId,accountId]);});}
  const people=new PeopleService(db,'browser-owner',async()=>ids,data),initial=(await people.list()).items;
  const port={people:async()=>people.list(),peopleCommand:async(_id,input)=>people.command(input),personHistory:async(_id,id,c,b)=>people.history(id,c,b),historyPreview:async(_id,input)=>people.preview(input),historyCommit:async(_id,input)=>people.commit(input),personMessage:async(_id,input)=>people.changeMessage(input),personMemory:async(_id,input)=>people.remember(input)} as OwnerPort;
  let origin='';const handle=createOwnerHttpHandler({ownerPort:port,authenticate:async r=>r.headers.cookie?.includes('owner=synthetic')?{ownerId:'browser-owner'}:null,verifyWrite:r=>r.headers.origin===origin&&r.headers['x-csrf-token']==='synthetic'});
  const build=resolve('apps/web/build');server=createServer(async(req,res)=>{try{const path=new URL(req.url!,'http://localhost').pathname;
   if(path==='/api/v1/session'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ownerId:'browser-owner',csrfToken:'synthetic',expiresAt:new Date(Date.now()+3600000).toISOString()}));return;}
   if(path.startsWith('/api/')){await handle(req,res);return;}const file=path==='/'?resolve(build,'index.html'):resolve(build,'.'+path);if(file!==build&&!file.startsWith(build+sep))throw new Error('NOT_FOUND');let content=await readFile(file);if(path==='/')content=Buffer.from(content.toString().replace('<head>','<head><meta name="csrf-token" content="synthetic">'));res.writeHead(200,{'Content-Type':extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'text/html'});res.end(content);
  }catch{res.writeHead(404);res.end();}});await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');origin=`http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(origin+'/api/v2/people')).status,401);assert.equal((await fetch(origin+'/api/v2/people',{method:'POST',headers:{cookie:'owner=synthetic'},body:'{}'})).status,403);
  browser=await chromium.launch({headless:true});const context=await browser.newContext();await context.addCookies([{name:'owner',value:'synthetic',url:origin}]);const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/#people');await page.getByLabel('当前人物').selectOption(initial.find(p=>p.channels[0]!.contactId===ids[0])!.id);await page.getByLabel('关联已有聊天').selectOption(ids[1]!);await page.getByRole('button',{name:'确认是同一个人并关联'}).click();await page.getByText('人物与渠道已保存，旧候选需要重新生成。').waitFor();
  const csv=Buffer.from('speaker,text,timestamp\nOTHER,我喜欢面条,2026-10-12T10:00:00+08:00\nME,好的,');
  await page.getByLabel('导入渠道').selectOption(ids[1]!);await page.getByLabel('选择导出文件').setInputFiles({name:'合成历史.csv',mimeType:'text/csv',buffer:csv});await page.getByRole('heading',{name:'预览：合成历史.csv · 2条'}).waitFor();assert.equal((await db.query('SELECT count(*)::int AS n FROM data_messages')).rows[0].n,0);
  await page.getByRole('button',{name:/确认导入到/}).click();await page.getByText('已导入2条，重复0条。').waitFor();assert.equal((await db.query('SELECT count(*)::int AS n FROM data_messages')).rows[0].n,2);
  await page.getByRole('button',{name:'整理为长期记忆'}).first().click();await page.getByLabel('确认的记忆内容').fill('喜欢面条');await page.getByRole('button',{name:'本人确认并保存记忆'}).click();await page.getByText('已保存，相关旧候选需要重新生成。').waitFor();
  await page.getByLabel('选择导出文件').setInputFiles({name:'合成历史.csv',mimeType:'text/csv',buffer:csv});await page.getByRole('heading',{name:'预览：合成历史.csv · 2条'}).waitFor();await page.getByRole('button',{name:/确认导入到/}).click();await page.getByText('已导入0条，重复2条。').waitFor();
  await page.getByRole('button',{name:'纠正导入原文'}).first().click();await page.getByLabel('修订原文').fill('修订后的合成原文');await page.getByRole('button',{name:'保存纠正'}).click();await page.getByText('修订后的合成原文',{exact:true}).waitFor();
  await page.getByLabel('查看渠道').selectOption(ids[0]!);await page.getByText('暂无已保存记录。').waitFor();await page.getByLabel('查看渠道').selectOption('');await page.getByText('修订后的合成原文',{exact:true}).waitFor();
  await mkdir(resolve('output/people-browser'),{recursive:true});for(const width of [320,390,1280]){await page.setViewportSize({width,height:900});await page.screenshot({path:resolve(`output/people-browser/people-${width}.png`),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);}
  assert.deepEqual(errors,[]);assert.equal((await db.query('SELECT count(*)::int AS n FROM orch_reply_jobs')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM orch_send_tasks')).rows[0].n,0);await context.close();
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}await pool?.end();await admin.query('SET search_path TO public');await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
