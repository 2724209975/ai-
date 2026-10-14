import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPacket} from './context.mts';
import type {LinkGroup,LinkMessage,LinkRecord} from './types.mts';
function fixture():LinkGroup {
 const records:Record<string,LinkRecord>={};
 for(let i=0;i<300;i++)records['desktop:'+i]={id:'desktop:'+i,kind:'message',version:1,seq:i+1,deleted:false,body:{speaker:i%2?'ME':'OTHER',text:i===10?'周六音乐会约在东门，已经买好票':i===11?'好呀东门见':i===299?'音乐会的票还在吗':'无关天气发言'+i,timestamp:i+1,uncertain:false,generated:false,styleExample:true,sourceId:String(i)}};
 (records['desktop:299'].body as LinkMessage).speaker='OTHER';
 return {id:'group',deviceId:'device',archiveId:'archive',contactId:'contact',revision:301,records,conflicts:[],packet:{revision:0,summary:'',sourceIds:[],style:'',examples:[],method:'extractive',ready:true}};
}
test('current topic retrieves distant evidence with adjacent reply and recent background',()=>{
 const packet=buildPacket(fixture());
 assert.ok(packet.sourceIds.includes('desktop:10'));assert.ok(packet.sourceIds.includes('desktop:11'));
 assert.match(packet.summary,/已经买好票/);assert.ok(packet.sourceIds.includes('desktop:267'));
 assert.ok(packet.sourceIds.length<=64);assert.ok(!packet.sourceIds.includes('desktop:299'));
 const indices=packet.sourceIds.map(id=>Number(id.split(':')[1]));assert.deepEqual(indices,[...indices].sort((a,b)=>a-b));
});
test('uncertain, generated, unknown and deleted evidence never becomes certain background',()=>{
 const g=fixture();for(const [i,change] of [[10,{generated:true}],[11,{uncertain:true}],[12,{speaker:'UNKNOWN'}]] as const)g.records['desktop:'+i].body={...g.records['desktop:'+i].body as LinkMessage,...change};g.records['desktop:13'].deleted=true;
 const packet=buildPacket(g);for(const i of [10,11,12,13])assert.ok(!packet.sourceIds.includes('desktop:'+i));assert.doesNotMatch(packet.summary,/已经买好票/);
});
test('bounded summary has one attributed line for every actual source and adapts to topic',()=>{
 const g=fixture();for(const r of Object.values(g.records)) (r.body as LinkMessage).text+='长'.repeat(1000);
 let packet=buildPacket(g);assert.equal(packet.summary.split('\n').length,packet.sourceIds.length);assert.ok(packet.summary.length<=18000);
 (g.records['desktop:299'].body as LinkMessage).text='完全不同的问题';packet=buildPacket(g);assert.ok(!packet.sourceIds.includes('desktop:10'));
});
test('fewer than 32 records retain recent originals without fabricated background',()=>{
 const g=fixture();g.records=Object.fromEntries(Object.entries(g.records).slice(0,10));const packet=buildPacket(g);assert.equal(packet.summary,'');assert.deepEqual(packet.sourceIds,[]);
});
