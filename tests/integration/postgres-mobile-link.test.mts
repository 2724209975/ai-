import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {applyMigrations} from '../../packages/infrastructure/postgres/migrate.mts';
import {PgLinkStore} from '../../packages/link/store.mts';
import {LinkService} from '../../packages/link/service.mts';
import {DesktopLinkCollector} from '../../packages/link/desktop.mts';
const url=process.env.TEST_DATABASE_URL;
test('mobile link persists isolated data without inbox/outbox or send side effects',{skip:!url},async()=>{
 const {Client,Pool}=await import('pg');const schema='test_link_'+randomBytes(8).toString('hex');const admin=new Client({connectionString:url});await admin.connect();let pool:any;
 try {await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema}`);await applyMigrations(admin,resolve('db/migrations'));pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});const service=new LinkService(new PgLinkStore(pool,'owner'));const p=await service.pair(await service.invite(),'SyntheticPhone');const g=await service.bind(p.deviceId,'SyntheticArchive',{name:'Synthetic',platform:'微信',relationship:'',style:'简短',preferences:[],memory:{consent:false,paused:false,profile:'',entries:[]}},null);
 const before=await admin.query(`SELECT (SELECT count(*) FROM data_messages) AS messages,(SELECT count(*) FROM orch_send_tasks) AS sends,(SELECT count(*) FROM event_outbox) AS outbox`);
 const body={speaker:'OTHER' as const,text:'合成上下文',timestamp:10,uncertain:false,generated:false,styleExample:false,sourceId:'synthetic-source'};
 await service.sync(p.deviceId,g.id,[{id:`phone:${p.deviceId}:message`,kind:'message',body,expectedVersion:0,deleted:false}],0);
 const reopened=new LinkService(new PgLinkStore(pool,'owner'));assert.equal((await reopened.store.read()).groups[0].revision,2);assert.equal(await reopened.authenticate(p.token),p.deviceId);
 const replay=await reopened.sync(p.deviceId,g.id,[{id:`phone:${p.deviceId}:message`,kind:'message',body,expectedVersion:0,deleted:false}],2);
 assert.equal(replay.revision,2);assert.deepEqual(replay.records,[]);assert.deepEqual(replay.conflicts,[]);
 const receipt=(await new PgLinkStore(pool,'owner').read()).groups[0].syncReceipt!;assert.equal(receipt.confirmedCursor,2);assert.equal(receipt.lastRequestCursor,2);assert.ok(receipt.confirmedAt>0);
 const other=new LinkService(new PgLinkStore(pool,'different-owner'));assert.equal((await other.store.read()).groups.length,0);
 await new DesktopLinkCollector(pool,reopened).refresh();
 const after=await admin.query(`SELECT (SELECT count(*) FROM data_messages) AS messages,(SELECT count(*) FROM orch_send_tasks) AS sends,(SELECT count(*) FROM event_outbox) AS outbox`);assert.deepEqual(after.rows,before.rows);
 }finally{await pool?.end();await admin.query('SET search_path TO public');await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
