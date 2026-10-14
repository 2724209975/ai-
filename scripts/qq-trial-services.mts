/** Reuse the existing isolated QQ database and the owner-authorized NapCat installation. */
import {readFile,open,access} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from 'pg';
import {assertPhysicalManaged,assertStoppedCluster} from './prerelease-safety.mts';
export async function ensureQqTrialServices(options:{prereleaseRoot:string;webuiConfigFile:string}){
  const root=resolve(options.prereleaseRoot);await assertPhysicalManaged(root,join(root,'private/state.json'));
  const state=JSON.parse(await readFile(join(root,'private/state.json'),'utf8'));
  const profile=state.profiles?.find((p:any)=>p.platform==='qq');
  if(state.kind!=='isolated-v2-prerelease'||resolve(state.root)!==root||!profile)throw new Error('QQ_TRIAL_SERVICE_SCOPE_INVALID');
  await assertPhysicalManaged(root,profile.data);
  try{await assertStoppedCluster(profile.data);await promisify(execFile)(join(state.bin,'pg_ctl.exe'),['-D',profile.data,'-l',join(root,'logs/qq-postgres.log'),'-w','start'],{cwd:root,windowsHide:true,timeout:40000});}
  catch(error){if(!(error instanceof Error)||error.message!=='PRERELEASE_SOURCE_DATABASE_RUNNING')throw error;}
  const client=new Client({connectionString:profile.env.DATABASE_URL,connectionTimeoutMillis:5000});
  try{await client.connect();if(resolve((await client.query('SHOW data_directory')).rows[0].data_directory).toLowerCase()!==resolve(profile.data).toLowerCase())throw new Error('QQ_TRIAL_DATABASE_OWNERSHIP_INVALID');}finally{await client.end();}
  let available=false;try{available=(await fetch('http://127.0.0.1:6099',{signal:AbortSignal.timeout(2000)})).ok;}catch{}
  if(!available){
    const napcat=dirname(dirname(resolve(options.webuiConfigFile))),launcher=join(napcat,'launcher-user.bat');await access(launcher);
    const log=await open(join(root,'private','qq-relaunch-'+Date.now()+'.log'),'wx');
    try{const child=spawn(process.env.ComSpec??'cmd.exe',['/d','/c','launcher-user.bat'],{cwd:napcat,windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();}finally{await log.close();}
  }
  return {isolatedDatabaseReady:true,napcatLaunched:!available,dailyDatabaseUntouched:true,automaticSend:false};
}
