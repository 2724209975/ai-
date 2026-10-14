/** Imports local QQ history for exactly the contacts in a private candidate-trial manifest. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {assertPhysicalManaged} from './prerelease-safety.mts';
import {PgDataProvider} from '../packages/data/postgres/provider.mts';
import {importQqHistory} from '../packages/data/imports/qq-history.mts';
import {MemoryWorker} from '../packages/data/memory-v2/worker.mts';

async function main(){
  const [pointer,phase,...extra]=process.argv.slice(2);
  if(!pointer||!['fetch','commit'].includes(phase??'')||extra.length)throw new Error('QQ_HISTORY_ARGUMENTS_REQUIRED');
  const {root}=JSON.parse(await readFile(resolve(pointer),'utf8'));
  const m=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')),runtime=JSON.parse(await readFile(join(root,'runtime.json'),'utf8'));
  await assertPhysicalManaged(m.prereleaseRoot,root);
  if(m.ownerAuthorized!==true||m.automaticSendAuthorized!==false||runtime.kind!=='qq-candidate-trial'||m.schema!==runtime.schema||!/^[a-z0-9_]+$/.test(m.schema)||m.contacts.length!==runtime.contacts.length||m.contacts.some((c:any)=>!runtime.contacts.some((r:any)=>r.userId===c.userId)))throw new Error('QQ_HISTORY_SCOPE_INVALID');
  const directory=join(root,'history-import');await mkdir(directory,{recursive:true});
  if(phase==='fetch'){
    const web=JSON.parse(await readFile(m.webuiConfigFile,'utf8'));
    const post=async(path:string,body:unknown,credential?:string)=>{
      const response=await fetch('http://127.0.0.1:6099'+path,{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:'Bearer '+credential}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:'error'});
      const result=await response.json() as any;if(!response.ok||result.code!==0)throw new Error('QQ_HISTORY_API_UNAVAILABLE');return result.data;
    };
    const credential=(await post('/api/auth/login',{hash:createHash('sha256').update(web.token+'.napcat').digest('hex')})).Credential;
    const login=await post('/api/Debug/call',{action:'get_login_info',params:{}},credential);
    if(login.status!=='ok'||String(login.data?.user_id)!==m.selfId)throw new Error('QQ_HISTORY_ACCOUNT_MISMATCH');
    const report=[];
    for(const c of runtime.contacts){
      const seen=new Map<string,any>();let cursor:string|undefined,end='page_limit',pages=0;
      for(let page=0;page<1000;page++){
        const response=await post('/api/Debug/call',{action:'get_friend_msg_history',params:{user_id:c.userId,...(cursor?{message_seq:cursor}:{}),count:100,reverse_order:true,disable_get_url:true,parse_mult_msg:false}},credential);
        await writeFile(join(directory,c.contactId+'-page-'+page+'.json'),JSON.stringify(response));pages++;
        if(response.status!=='ok'||response.retcode!==0){if(cursor&&/^消息.*不存在$/.test(String(response.message??response.wording??''))){end='local_history_end';break;}throw new Error('QQ_HISTORY_PAGE_FAILED');}
        if(!Array.isArray(response.data?.messages))throw new Error('QQ_HISTORY_PAGE_INVALID');
        const rows=response.data.messages;if(!rows.length){end='local_history_end';break;}
        const before=seen.size;for(const row of rows){if(row.message_id===undefined)throw new Error('QQ_HISTORY_CURSOR_INVALID');seen.set(String(row.message_id),row);}
        if(seen.size===before){end='no_earlier_records';break;}
        rows.sort((a:any,b:any)=>Number(a.time)-Number(b.time)||(BigInt(a.real_seq??a.message_seq??0)<BigInt(b.real_seq??b.message_seq??0)?-1:1));
        const next=String(rows[0].message_id);if(next===cursor){end='no_earlier_records';break;}cursor=next;
      }
      await writeFile(join(directory,c.contactId+'-rows.json'),JSON.stringify([...seen.values()]));
      const summary={name:c.displayName,contactId:c.contactId,fetched:seen.size,pages,end};report.push(summary);
      console.log(JSON.stringify({phase:'fetched',name:summary.name,messages:summary.fetched,pages,end}));
    }
    await writeFile(join(directory,'fetch-report.json'),JSON.stringify({fetchedAt:new Date().toISOString(),contacts:report},null,2));return;
  }
  // Stop the receiver before committing so every later candidate uses the new source and context rules.
  await readFile(join(root,'final.json'));
  const state=JSON.parse(await readFile(join(m.prereleaseRoot,'private/state.json'),'utf8')),profile=state.profiles.find((p:any)=>p.platform==='qq');
  if(state.kind!=='isolated-v2-prerelease'||!profile)throw new Error('QQ_HISTORY_DATABASE_INVALID');
  const pool=new Pool({connectionString:profile.env.DATABASE_URL,options:'-c search_path='+m.schema});
  try{
    const owner=(await pool.query<{owner_id:string}>('SELECT owner_id FROM ai_model_configs_v2')).rows;
    if(owner.length!==1)throw new Error('QQ_HISTORY_OWNER_INVALID');const ownerId=owner[0]!.owner_id;
    const contacts=[];
    for(const c of runtime.contacts){
      const identity=(await pool.query<{account_id:string;external_contact_ref:string}>('SELECT account_id,external_contact_ref FROM orch_conversations WHERE contact_id=$1 AND conversation_id=$2',[c.contactId,c.conversationId])).rows[0];
      if(!identity||identity.external_contact_ref!==c.userId)throw new Error('QQ_HISTORY_CONTACT_MISMATCH');
      const rows=JSON.parse(await readFile(join(directory,c.contactId+'-rows.json'),'utf8'));
      const result=await importQqHistory(pool,new PgDataProvider(),{selfId:m.selfId,ownerId,contact:{...c,accountId:identity.account_id},rows,beforeSeconds:Math.floor(Date.parse(runtime.startedAt)/1000)});
      contacts.push({name:c.displayName,...result});console.log(JSON.stringify({phase:'imported',name:c.displayName,...result}));
    }
    const worker=new MemoryWorker({pool,data:new PgDataProvider(),ownerId});let maintenance={extracted:0,summarized:0,indexed:0,failed:0};
    // Drain finite, locally extracted historical tasks. No cloud extractor or embedding is configured.
    for(let i=0;i<100;i++){const r=await worker.runOnce();for(const k of ['extracted','summarized','indexed','failed'] as const)maintenance[k]+=r[k];const pending=await pool.query("SELECT count(*)::int AS count FROM data_memory_tasks WHERE status IN ('PENDING','PROCESSING')");if(!pending.rows[0].count||r.failed)break;}
    await writeFile(join(directory,'import-report.json'),JSON.stringify({importedAt:new Date().toISOString(),contacts,maintenance,externalModelCalls:0,sendCalls:0},null,2));
    console.log(JSON.stringify({maintenance,externalModelCalls:0,sendCalls:0}));
  }finally{await pool.end();}
}
main().catch(()=>{process.stderr.write('QQ_HISTORY_IMPORT_FAILED; private history and existing model ledgers retained\n');process.exitCode=1;});
