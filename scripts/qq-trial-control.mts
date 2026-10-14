/** Managed continuous trial. The guardian owns only its child; owner stop never auto-restarts. */
import {readFile,writeFile,open,rm,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {ensureQqTrialServices} from './qq-trial-services.mts';
import {superviseLocalStack} from './local-supervisor.mts';
import {assertPhysicalManaged} from './prerelease-safety.mts';
import {validateQqTrialQualityModel} from './qq-trial-models.mts';

async function main(){
  const [command,manifestFile,...extra]=process.argv.slice(2);
  if(!manifestFile||(command==='configure-quality'?extra.length!==1:extra.length!==0)||!['start','stop','status','restart','guard','configure-quality'].includes(command??''))throw new Error('QQ_TRIAL_CONTROL_ARGUMENTS');
  const manifest=resolve(manifestFile),m=JSON.parse(await readFile(manifest,'utf8')),root=resolve(m.root);
  await assertPhysicalManaged(root,manifest);await assertPhysicalManaged(m.prereleaseRoot,root);
  if(!m.persistent||m.ownerAuthorized!==true||m.automaticSendAuthorized!==false)throw new Error('QQ_TRIAL_CONTROL_SCOPE');
  if(command==='configure-quality'){
    const qualityFile=resolve(extra[0]!);await assertPhysicalManaged(root,qualityFile);
    validateQqTrialQualityModel(JSON.parse(await readFile(qualityFile,'utf8')));
    const temporary=manifest+'.models-'+process.pid+'.tmp';
    await writeFile(temporary,JSON.stringify({...m,qualityModelFile:qualityFile},null,2),{flag:'wx'});await rename(temporary,manifest);
    console.log(JSON.stringify({configured:true,restartRequired:true,sendCalls:0}));return;
  }
  const file=join(root,'guardian.json'),stopFile=join(root,'owner-stop.json');
  const load=async(path:string)=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  async function status(){const rt=await load(join(root,'runtime.json'));if(!rt)return null;try{const r=await fetch(rt.url+'/data',{signal:AbortSignal.timeout(3000)});if(!r.ok)return null;const d=await r.json() as any;return {running:true,connected:d.connected,budget:d.budget,sendCalls:d.sendCalls,workbenchUrl:rt.workbenchUrl,lanUrl:rt.lanUrl};}catch{return null;}}
  if(command==='status'){console.log(JSON.stringify(await status()??{running:false,sendCalls:0}));return;}
  if(command==='stop'||command==='restart'){
    await writeFile(stopFile,JSON.stringify({at:new Date().toISOString(),reason:'owner_stop'}));
    const rt=await load(join(root,'runtime.json'));if(rt&&await status()){const r=await fetch(new URL('/stop',rt.url),{method:'POST',headers:{'x-trial-token':rt.token},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('QQ_TRIAL_STOP_FAILED');}
    for(let i=0;i<100;i++){if(!await status()&&!await load(file))break;await new Promise(r=>setTimeout(r,200));}
    if(await status()||await load(file))throw new Error('QQ_TRIAL_STOP_UNCONFIRMED');
    if(command==='stop'){console.log(JSON.stringify({stopped:true,sendCalls:0}));return;}
  }
  if(command!=='guard'){
    const guardian=await load(file);if(guardian&&alive(guardian.pid)){console.log(JSON.stringify({alreadyRunning:true,sendCalls:0}));return;}
    if(guardian)await rm(file);await rm(stopFile,{force:true});
    const log=await open(join(root,'guardian.log'),'a');try{const child=spawn(process.execPath,[resolve('scripts/qq-trial-control.mts'),'guard',manifest],{cwd:process.cwd(),windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();console.log(JSON.stringify({launched:true,pid:child.pid,sendCalls:0}));}finally{await log.close();}return;
  }
  const lock=await open(file,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,manifest,at:new Date().toISOString()}));await lock.close();
  const controller=new AbortController();let checking=false;
  const timer=setInterval(()=>{if(checking)return;checking=true;void load(stopFile).then(s=>{if(s)controller.abort();}).finally(()=>{checking=false;});},500);
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>controller.abort());
  try{await superviseLocalStack({names:['qq-candidates'],signal:controller.signal,log:async(event)=>{const log=await open(join(root,'lifecycle.jsonl'),'a');try{await log.appendFile(JSON.stringify({event,at:new Date().toISOString(),sendCalls:0})+'\n');}finally{await log.close();}},async start(){
    await ensureQqTrialServices({prereleaseRoot:m.prereleaseRoot,webuiConfigFile:m.webuiConfigFile});
    const log=await open(join(root,'process.log'),'a');const child=spawn(process.execPath,[resolve('scripts/qq-candidate-trial.mts'),manifest],{cwd:process.cwd(),windowsHide:true,stdio:['ignore',log.fd,log.fd]});await log.close();let finished=false;
    const exited=new Promise<void>(done=>{child.once('error',()=>{finished=true;done();});child.once('exit',()=>{finished=true;void load(stopFile).then(s=>{if(s)controller.abort();});done();});});
    return {exited,async ready(){for(let i=0;i<300;i++){if(finished||controller.signal.aborted)throw new Error('CHILD_EXITED');const rt=await load(join(root,'runtime.json'));if(rt?.pid===child.pid&&await status())return;await new Promise(r=>setTimeout(r,200));}throw new Error('QQ_TRIAL_READY_TIMEOUT');},async stop(){if(finished)return;const rt=await load(join(root,'runtime.json'));if(rt?.pid===child.pid){await fetch(new URL('/stop',rt.url),{method:'POST',headers:{'x-trial-token':rt.token},signal:AbortSignal.timeout(10000)}).catch(()=>{});}else child.kill();let timeout:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([exited,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('QQ_TRIAL_CHILD_STOP_FAILED')),15000);})]);}finally{clearTimeout(timeout);}}};
  }});}finally{clearInterval(timer);const current=await load(file);if(current?.pid===process.pid)await rm(file);}
}
main().catch(()=>{console.error('QQ_TRIAL_CONTROL_FAILED: inspect private lifecycle state');process.exitCode=1;});
