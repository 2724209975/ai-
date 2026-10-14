import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {Pool} from 'pg';import {createHash} from 'node:crypto';
import {currentProject} from './project-control.mts';import {clearTrialContent} from '../packages/link/cleanup.mts';
if(process.argv[2]!=='--confirmed-current-trial'||process.argv.length!==3)throw Error('EXPLICIT_CURRENT_TRIAL_CLEANUP_REQUIRED');
const current=await currentProject(),m=JSON.parse(await readFile(current.manifest,'utf8'));
if(!/^qq_trial_[a-f0-9]{16}$/.test(m.schema))throw Error('TRIAL_SCHEMA_REQUIRED');
const rt=JSON.parse(await readFile(join(current.privateRoot,'runtime.json'),'utf8'));try{const r=await fetch(rt.url+'/data',{signal:AbortSignal.timeout(1000)});if(r.ok)throw Error('STOP_PROJECT_BEFORE_CLEANUP');}catch(e){if(e instanceof Error&&e.message==='STOP_PROJECT_BEFORE_CLEANUP')throw e;}
const state=JSON.parse(await readFile(join(m.prereleaseRoot,'private/state.json'),'utf8')),profile=state.profiles.find((p:any)=>p.platform==='qq');const pool=new Pool({connectionString:profile.env.DATABASE_URL,options:'-c search_path='+m.schema});const client=await pool.connect();
const ledgerHash=createHash('sha256').update(await readFile(join(current.privateRoot,'calls.jsonl'))).digest('hex');
try{await client.query('BEGIN');const lock=(await client.query("SELECT pg_try_advisory_xact_lock(hashtext('qq-candidate-runtime'),hashtext($1)) AS locked",[m.schema])).rows[0].locked;if(!lock)throw Error('TRIAL_STILL_RUNNING');const counts=await clearTrialContent(client);await client.query('COMMIT');
 if(m.visionAcceptanceImage){delete m.visionAcceptanceImage;await writeFile(current.manifest,JSON.stringify(m,null,2));}
 const result={at:new Date().toISOString(),counts,ledgerHash,automaticSend:false,phoneCleanupPending:true};await writeFile('output/android/project-cleanup-result.json',JSON.stringify(result,null,2));console.log({cleared:true,counts,ledgerPreserved:true,phoneCleanupPending:true});
}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await pool.end();}
