/** Isolated real PostgreSQL + synthetic OneBot/vision; no real QQ or paid model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { createOneBotImageSource, createPgQqRawImageLoader } from '../../packages/platform/qq/onebot-media-source.mts';
import { createQqBridge } from '../../apps/bridge/bridge.mts';
import { PgPrivateImageReader } from '../../packages/data/media/pg-private-reader.mts';
import type { BinaryMediaProvider } from '../../packages/ai/index.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { png, animatedGif } from '../fixtures/media-images.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const settings = { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL' };
async function fixture(kind = 'ok', beforeReply?: () => Promise<void>) {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL_REQUIRED');
  const { Client, Pool } = await import('pg');
  const schema = `qq_media_${randomBytes(8).toString('hex')}`;
  const admin = new Client({connectionString:databaseUrl}); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema}`);
  await applyMigrations(admin,resolve('db/migrations'));
  const pool = new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:3});
  const accountId = newId(), contactId = newId(), conversationId = newId();
  await withTransaction(pool,async tx=>{
    await setContactScope(tx,contactId);
    await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
      VALUES($1,$2,$3,'20002','合成图片联系人','enrolled',1,now(),now())`,[contactId,conversationId,accountId]);
    await changeGlobalPause(tx,false);
  });
  const root = await mkdtemp(join(tmpdir(),'qq-media-integration-'));
  const rawRoot = join(root,'raw'), mediaRoot = join(root,'media'), cacheDir = join(root,'cache');
  await mkdir(cacheDir); await mkdir(mediaRoot);
  let path = join(cacheDir,'image.png');
  await writeFile(path,kind==='large'?Buffer.alloc(1025):kind==='truncated'?png.subarray(0,20):kind==='animated'?animatedGif:kind==='corrupt'?Buffer.concat([png.subarray(0,8),Buffer.alloc(80)]):png);
  if(kind==='outside'){path=join(root,'outside.png');await writeFile(path,png);}
  if(kind==='symlink'){
    const outside = join(root,'external');await mkdir(outside);await writeFile(join(outside,'image.png'),png);
    await symlink(outside,join(cacheDir,'escape'),'junction'); path=join(cacheDir,'escape','image.png');
  }
  if(kind==='url')path='https://example.invalid/private.png';
  if(kind==='file-url')path=`file://${path}`;
  const requests: unknown[] = []; let modelCalls = 0;
  const onebot = createServer((request,response)=>{
    let body='';request.on('data',chunk=>{body+=chunk;});request.on('end',async()=>{
      requests.push({path:request.url,body:JSON.parse(body)});
      assert.equal(request.url,'/get_image'); assert.equal(request.headers.authorization,'Bearer fixture-media-token');
      await beforeReply?.();
      const reply=()=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({status:'ok',retcode:0,data:{file:path}}));};
      if(kind==='timeout')setTimeout(reply,100);else reply();
    });
  });
  await new Promise<void>(done=>onebot.listen(0,'127.0.0.1',done));
  const onebotPort = (onebot.address() as {port:number}).port;
  const readRaw = createPgQqRawImageLoader({pool,accountId,selfId:'10001',rawRoot});
  const source = createOneBotImageSource({baseUrl:`http://127.0.0.1:${onebotPort}/`,accessToken:'fixture-media-token',selfId:'10001',cacheDir,
    timeoutMs:kind==='timeout'?20:8_000,readRaw:kind==='cross-peer'?async(p,s)=>readRaw({...p,externalContactRef:'29999'},s):readRaw});
  const provider: BinaryMediaProvider = {providerId:'synthetic',modelId:'vision',modelVersion:'1',promptVersion:'fixture-image-1',
    dataRegion:'test',retentionPolicy:'test',supportedMimeTypes:{image:['image/png'],voice:[]},async invoke(input){
      modelCalls++; assert.deepEqual(Buffer.from(input.bytes),png);
      return {interpretation:{text:'合成图片中有三种颜色',completeness:'complete',uncertainty:'合成夹具',criticalUnclear:false,visualCoverage:'full_image'}};
    }};
  const errors: string[] = [];
  const bridge = createQqBridge({pool,accountId,selfId:'10001',bridgeToken:'fixture-media-token',rawStore:createFileRawEventStore(rawRoot),
    transport:{async submitOnce(){throw new Error('SEND_FORBIDDEN');}},outboxIntervalMs:600_000,
    media:{source,readRaw,mediaRoot,maxBytes:1024,originalVerified:kind!=='unverified'},
    imageUnderstanding:kind==='fetch-only'?undefined:{provider},onError:(error,phase)=>errors.push(`${phase}:${error instanceof Error?error.message:'unknown'}`)});
  await bridge.start();await bridge.service.enrollContact({accountId,contactId,conversationId,externalContactRef:'20002',timezone:'Asia/Shanghai',goal:'普通聊天'});
  await new Promise<void>(done=>bridge.server.listen(0,'127.0.0.1',done));
  const base=`http://127.0.0.1:${(bridge.server.address() as {port:number}).port}`;
  const body=JSON.stringify({post_type:'message',message_type:'private',sub_type:'friend',self_id:10001,user_id:kind==='stranger'?29999:20002,
    message_id:31001,time:Math.floor(Date.now()/1000),message:[{type:'reply',data:{id:9}},{type:'image',data:{file:'synthetic-original-ref'}}]});
  const post=()=>fetch(`${base}/onebot/event`,{method:'POST',headers:{authorization:'Bearer fixture-media-token','content-type':'application/json'},body});
  return {pool,bridge,contactId,conversationId,mediaRoot,root,rawRoot,requests,errors,base,post,calls:()=>modelCalls,
    async cleanup(){await bridge.stop();await new Promise<void>(done=>onebot.close(()=>done()));onebot.closeAllConnections();await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});}};
}

test('QQ complete image: fixed fetch, private bytes, interpretation and fresh confirmation; duplicate is inert',settings,async()=>{
  const f=await fixture();try{
    assert.equal((await f.post()).status,204,f.errors.join(' | '));
    assert.equal(f.requests.length,1);assert.equal(f.calls(),1);
    const task=(await f.bridge.service.ownerTasks()).items[0]!;assert.ok(task);assert.ok(task.alternatives.length>0);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM orch_send_tasks')).rows[0]!.n,0);
    const asset=(await f.pool.query('SELECT * FROM data_media_assets')).rows[0]!;
    assert.equal(asset.completeness,'complete');
    assert.deepEqual(await readFile(join(f.mediaRoot,`${asset.id}.bin`)),png);
    const interpretation=(await f.pool.query('SELECT * FROM data_media_interpretations')).rows;
    assert.equal(interpretation.length,1);assert.equal(interpretation[0]!.status,'valid');
    const snapshot=(await f.pool.query('SELECT s.message_refs FROM data_context_snapshots s JOIN orch_plans p ON p.context_snapshot_id=s.id')).rows[0]!;
    assert.equal(snapshot.message_refs[0].mediaInterpretation.id,interpretation[0]!.id);
    assert.equal(snapshot.message_refs[0].version,2);
    const reader=new PgPrivateImageReader(f.pool,f.mediaRoot);
    await assert.rejects(reader.readPrivate({callerContactId:newId(),contactId:f.contactId,mediaId:asset.id}),/FORBIDDEN/);
    assert.equal((await f.post()).status,204);assert.equal(f.calls(),1);assert.equal(f.requests.length,1);
    const health=await(await fetch(`${f.base}/healthz`)).json() as {mediaFetch:Record<string,unknown>};
    assert.equal(health.mediaFetch.fetched,1);
    assert.ok(!JSON.stringify(health).includes(f.contactId)&&!JSON.stringify(health).includes(f.root)&&!JSON.stringify(health).includes('fixture-media-token'));
  }finally{await f.cleanup();}
});

test('QQ unsafe or unverified images stay manual with zero model calls',settings,async t=>{
  for(const kind of ['outside','symlink','url','file-url','large','truncated','corrupt','animated','unverified','cross-peer','timeout','stranger'])await t.test(kind,async()=>{
    const f=await fixture(kind);try{
      assert.equal((await f.post()).status,204,f.errors.join(' | '));assert.equal(f.calls(),0);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM orch_plans')).rows[0]!.n,0);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM data_media_assets')).rows[0]!.n,0);
      assert.deepEqual(await readdir(f.mediaRoot),[]);
      if(kind!=='stranger')assert.equal((await f.bridge.service.getConversation(f.conversationId)).control.state,'PAUSED_MEDIA');
      if(['cross-peer','stranger'].includes(kind))assert.equal(f.requests.length,0);
      else assert.equal(f.requests.length,1,'the failure must exercise acquisition rather than an unrelated pre-fetch error');
    }finally{await f.cleanup();}
  });
});

test('QQ media policy and pause gates prevent both HTTP and model calls',settings,async t=>{
  for(const kind of ['disabled','auto','paused'])await t.test(kind,async()=>{
    const f=await fixture();try{
      if(kind==='paused'){
        const overview=await f.bridge.service.ownerOverview();
        await f.bridge.service.pauseAll({expectedVersion:overview.version,idempotencyKey:'fixture-pause'});
      }else{
        const contact=(await f.bridge.service.ownerContacts()).items[0]!;
        await f.bridge.service.updatePolicy(f.contactId,{expectedVersion:contact.version,idempotencyKey:`fixture-${kind}`,
          policy:kind==='disabled'?{agentEnabled:false}:{sendMode:'auto'}});
      }
      assert.equal((await f.post()).status,204);assert.equal(f.calls(),0);assert.equal(f.requests.length,0);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM data_media_assets')).rows[0]!.n,0);
    }finally{await f.cleanup();}
  });
});

test('QQ pause during acquisition discards unbound bytes before vision can run',settings,async()=>{
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture('ok',async()=>{entered();await gate;});
  const pending=f.post();
  try{
    await started;
    const overview=await f.bridge.service.ownerOverview();
    await f.bridge.service.pauseAll({expectedVersion:overview.version,idempotencyKey:'pause-acquiring'});
    release();assert.equal((await pending).status,204);assert.equal(f.calls(),0);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM data_media_assets')).rows[0]!.n,0);
    assert.deepEqual(await readdir(f.mediaRoot),[]);
  }finally{release();await pending;await f.cleanup();}
});

test('QQ fetch without vision binds verified private bytes but leaves the reply for manual review',settings,async()=>{
  const f=await fixture('fetch-only');try{
    assert.equal((await f.post()).status,204);assert.equal(f.calls(),0);assert.equal(f.requests.length,1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM data_media_assets')).rows[0]!.n,1);
    assert.equal((await f.bridge.service.getConversation(f.conversationId)).control.state,'PAUSED_MEDIA');
  }finally{await f.cleanup();}
});
