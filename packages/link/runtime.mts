import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import type { OwnerAuthService } from '../infrastructure/auth/owner-auth.mts';
import type { PgPool } from '../infrastructure/postgres/transaction.mts';
import { PgLinkStore } from './store.mts';
import { LinkService } from './service.mts';
import { linkHttp } from './http.mts';
import { DesktopLinkCollector } from './desktop.mts';
import { LinkSummarizer } from './model-summary.mts';
import type {LinkBudgetPort} from './budget.mts';
import {createUnifiedLinkBudget} from './unified-budget.mts';
import {PeopleService} from '../data/people/service.mts';
export async function createMobileLink(options:{env:NodeJS.ProcessEnv;pool:PgPool;ownerId:string;auth:OwnerAuthService;contacts:()=>Promise<{items:any[]}>;platformPools?:Map<string,PgPool>;modelEnv?:()=>NodeJS.ProcessEnv;configFile?:string;budget?:LinkBudgetPort}){
  const saved=await readFile(resolve(options.configFile??'.local-mobile-link/config.json'),'utf8').then(text=>JSON.parse(text.replace(/^\uFEFF/,''))).catch(()=>({}));
  const env={...saved,...Object.fromEntries(Object.entries(options.env).filter(([,v])=>v!==undefined))};if(env.MOBILE_LINK_ENABLED!=='1')return null;
  const endpoint=new URL(env.MOBILE_LINK_ORIGIN??'');const oct=endpoint.hostname.split('.').map(Number);const local=isIP(endpoint.hostname)===4&&(oct[0]===10||oct[0]===192&&oct[1]===168||oct[0]===172&&oct[1]>=16&&oct[1]<=31||oct[0]===127);
  if(endpoint.protocol!=='https:'||!local||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw new Error('INVALID_MOBILE_LINK_ORIGIN');
  const cert=await readFile(env.MOBILE_LINK_CERT??'');const key=await readFile(env.MOBILE_LINK_KEY??'');const fingerprint=new X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase();
  const store=new PgLinkStore(options.pool,options.ownerId);await store.read();
  const budget=options.budget??createUnifiedLinkBudget(env,store);await budget.initialize();
  const service=new LinkService(store);const collector=new DesktopLinkCollector(options.pool,service,options.platformPools,options.ownerId);let collecting:Promise<void>=Promise.resolve();const refresh=()=>{collecting=collecting.catch(()=>{}).then(()=>collector.refresh());return collecting;};
  const people=new PeopleService(options.pool,options.ownerId,async()=>(await options.contacts()).items.map(c=>c.id));
  const contacts=async()=>{const original=await options.contacts();if(options.platformPools)return original;const list=await people.list();return {items:[...original.items,...list.items.flatMap(p=>p.channels.filter(c=>c.importOnly).map(c=>({id:c.contactId,name:p.name+' / '+c.label,platform:c.platform})))]};};
  const http=linkHttp(service,options.auth,{endpoint:endpoint.origin,fingerprint,contacts,refresh,budget,evidence:(group,id)=>collector.evidence(group,id),remember:(group,input)=>collector.remember(group,input)});
  const server=createServer({cert,key,minVersion:'TLSv1.2'},(req,res)=>{void http(req,res,false).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
  const summarizer=new LinkSummarizer(service,options.modelEnv?()=>({...env,...options.modelEnv!()}):env);let timer:NodeJS.Timeout|undefined;let running:Promise<void>|null=null;
  const tick=()=>{if(!running)running=refresh().then(()=>summarizer.tick()).catch(()=>{}).finally(()=>{running=null;});return running;};
  return {owner:(req:any,res:any)=>http(req,res,true),service,
    async start(){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(Number(endpoint.port||443),env.MOBILE_LINK_HOST??'0.0.0.0',()=>{server.off('error',reject);resolve();});});timer=setInterval(()=>void tick(),15000);timer.unref();void tick();},
    async stop(){if(timer)clearInterval(timer);await new Promise<void>(resolve=>server.close(()=>resolve()));server.closeIdleConnections();await running;await collecting;},tick};
}
