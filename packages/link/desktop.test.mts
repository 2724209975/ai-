import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopLinkCollector} from './desktop.mts';
import {LinkService} from './service.mts';
import {MemoryLinkStore} from './store.mts';
import type {PgPool} from '../infrastructure/postgres/transaction.mts';

test('desktop refresh avoids unchanged writes after JSONB reorders stored fields',async()=>{
 const store=new MemoryLinkStore(),service=new LinkService(store),pair=await service.pair(await service.invite(),'fixture');
 const group=await service.bind(pair.deviceId,'archive',{name:'合成',platform:'qq',relationship:'',style:'',preferences:[],memory:{consent:false,paused:false,profile:'',entries:[]}},'contact');
 const pool:PgPool={async connect(){return {async query(sql){return {rows:sql.includes('FROM data_messages')?[{id:'message',actor:'owner',content_ref:'合成原文',sent_at:'2026-10-12',is_agent_generated:false}]:[]} as any;}};}};
 let writes=0;const original=service.desktopUpdate.bind(service);service.desktopUpdate=async(...args)=>{writes++;return original(...args);};
 const collector=new DesktopLinkCollector(pool,service);await collector.refresh();
 const before=(await store.read()).groups[0];const record=store.state.groups[0].records['desktop:message'];record.body=Object.fromEntries(Object.entries(record.body!).reverse()) as any;
 await collector.refresh();await collector.refresh();
 assert.equal(writes,1);assert.equal((await store.read()).groups[0].revision,before.revision);
 assert.equal((await store.read()).groups[0].records['desktop:message'].version,1);
});
test('portal collection keeps same contact and message IDs isolated across platform databases',async()=>{
 const service=new LinkService(new MemoryLinkStore());const paired=await service.pair(await service.invite(),'synthetic');
 const profile={name:'同名',platform:'测试',relationship:'',style:'',preferences:[],memory:{consent:false,paused:false,profile:'',entries:[]}};
 const qq=await service.bind(paired.deviceId,'qq-archive',profile,'qq__same-id');const wx=await service.bind(paired.deviceId,'wx-archive',profile,'wechat__same-id');
 const scopes:string[]=[];
 function pool(platform:string):PgPool{return {async connect(){return {async query(sql,params){if(sql.includes('set_config'))scopes.push(`${platform}:${params?.[1]}`);return {rows:sql.includes('FROM data_messages')?[{id:'same-message',actor:'owner',content_ref:platform,sent_at:'2026-10-08',is_agent_generated:false}]:[]} as any;}};}};}
 const pools=new Map([['qq',pool('qq')],['wechat',pool('wechat')]]);await new DesktopLinkCollector(pools.get('qq')!,service,pools).refresh();
 const groups=(await service.store.read()).groups;
 assert.equal((groups.find(g=>g.id===qq.id)!.records['desktop:qq:same-message'].body as any).text,'qq');
 assert.equal((groups.find(g=>g.id===wx.id)!.records['desktop:wechat:same-message'].body as any).text,'wechat');
 assert.deepEqual(scopes,['qq:same-id','wechat:same-id']);
});
