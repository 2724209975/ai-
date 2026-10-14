/** A private, atomic settings document; public reads contain metadata only. */
import {readFile,open,rename,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {assertPhysicalManaged} from './prerelease-safety.mts';
import {validateQqTrialQualityModel,type QqTrialQualityModel} from './qq-trial-models.mts';
import type {TrialQualitySave,TrialQualityApply,TrialQualitySettings} from '../packages/contracts/trial-model-settings.mts';
type Saved={kind:'qq-quality-settings-v1';version:number;model:QqTrialQualityModel;commands:{key:string;hash:string;action:string;version:number}[]};
const queues=new Map<string,Promise<unknown>>();
function hash(value:unknown):string{
 const sort=(v:any):any=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
 return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}
export function qualityModelDocument(value:unknown):QqTrialQualityModel{
 const v=value as Partial<Saved>|null,model=v?.kind==='qq-quality-settings-v1'?v.model:value;validateQqTrialQualityModel(model);return model;
}
export function createQqTrialQualitySettings(options:{root:string;manifestFile:string;activeModel?:QqTrialQualityModel;onApply?:()=>Promise<void>;role?:'quality'|'economy'}){
 const role=options.role??'quality';
 const root=resolve(options.root),file=join(root,role+'-model-settings.json');
 const serial=<T,>(work:()=>Promise<T>)=>{const next=(queues.get(root)??Promise.resolve()).then(work,work);queues.set(root,next.catch(()=>{}));return next;};
 async function load():Promise<Saved|null>{
  try{await lstat(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  await assertPhysicalManaged(root,file);const v=JSON.parse(await readFile(file,'utf8')) as Saved;
  if(v.kind!=='qq-quality-settings-v1'||!Number.isSafeInteger(v.version)||v.version<1||!Array.isArray(v.commands)||v.commands.length>100)throw new Error('INTERNAL_ERROR');
  qualityModelDocument(v);return v;
 }
 async function atomic(path:string,value:unknown){const tmp=path+'.'+randomUUID()+'.tmp',fd=await open(tmp,'wx');try{await fd.writeFile(JSON.stringify(value,null,2));await fd.sync();}finally{await fd.close();}await rename(tmp,path);}
 function project(saved:Saved|null):TrialQualitySettings{
  const model=saved?.model??options.activeModel;
  if(!model)return {version:0,phase:'unconfigured',hasApiKey:false,model:null,activeModelId:null,canApply:!!options.onApply};
  const {apiKey:_key,...publicModel}=model;
  return {version:saved?.version??0,phase:options.activeModel&&hash(model)===hash(options.activeModel)?'active':'saved',hasApiKey:true,model:publicModel as TrialQualitySettings['model'],activeModelId:options.activeModel?.modelId??null,canApply:!!options.onApply};
 }
 function command(input:TrialQualityApply){if(!input||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||typeof input.idempotencyKey!=='string'||input.idempotencyKey.length<8||input.idempotencyKey.length>200)throw new Error('VALIDATION_FAILED');}
 function oldCommand(saved:Saved|null,input:TrialQualityApply,action:string){const entry=saved?.commands.find(c=>c.key===input.idempotencyKey);if(entry&&(entry.hash!==hash(input)||entry.action!==action))throw new Error('CONFLICT_VERSION');return entry;}
 return {
  read:()=>serial(async()=>project(await load())),
  save:(input:TrialQualitySave)=>serial(async()=>{
   command(input);if(Object.keys(input).sort().join(',')!=='expectedVersion,idempotencyKey,model'||!input.model||typeof input.model!=='object'||Array.isArray(input.model))throw new Error('VALIDATION_FAILED');
   const saved=await load(),old=oldCommand(saved,input,'save');if(old)return project(saved);
   if(input.expectedVersion!==(saved?.version??0))throw new Error('CONFLICT_VERSION');
   const prior=saved?.model??options.activeModel;
   if(input.model.apiKey!==undefined&&typeof input.model.apiKey!=='string')throw new Error('VALIDATION_FAILED');
   if(!input.model.apiKey?.trim()&&prior&&(input.model.providerId!==prior.providerId||input.model.baseUrl!==prior.baseUrl))throw new Error('VALIDATION_FAILED');
   const model={...input.model,apiKey:input.model.apiKey?.trim()||prior?.apiKey||''};
   try{validateQqTrialQualityModel(model);}catch{throw new Error('VALIDATION_FAILED');}
   const version=(saved?.version??0)+1,next:Saved={kind:'qq-quality-settings-v1',version,model,commands:[...(saved?.commands??[]).slice(-99),{key:input.idempotencyKey,hash:hash(input),action:'save',version}]};
   await atomic(file,next);return project(next);
  }),
  apply:(input:TrialQualityApply)=>serial(async()=>{
   command(input);if(Object.keys(input).sort().join(',')!=='expectedVersion,idempotencyKey')throw new Error('VALIDATION_FAILED');
   if(!options.onApply)throw new Error('FORBIDDEN');const saved=await load();if(!saved)throw new Error('POLICY_BLOCKED');
   if(input.expectedVersion!==saved.version)throw new Error('CONFLICT_VERSION');const old=oldCommand(saved,input,'apply');
   if(project(saved).phase==='active')return {...project(saved),restarting:false};
   if(!old){await assertPhysicalManaged(root,options.manifestFile);const manifest=JSON.parse(await readFile(options.manifestFile,'utf8'));
    if(resolve(manifest.root)!==root||manifest.ownerAuthorized!==true||manifest.automaticSendAuthorized!==false||manifest.persistent!==true)throw new Error('FORBIDDEN');
    // Startup reads an applied snapshot, never the mutable draft. A crash cannot activate a later unsaved-to-runtime edit.
    const activeFile=join(root,role+'-model-active-'+saved.version+'.json');
    try{await lstat(activeFile);await assertPhysicalManaged(root,activeFile);if(hash(qualityModelDocument(JSON.parse(await readFile(activeFile,'utf8'))))!==hash(saved.model))throw new Error('CONFLICT_VERSION');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await atomic(activeFile,saved.model);}
    await atomic(options.manifestFile,{...manifest,[role+'ModelFile']:activeFile});saved.commands=[...saved.commands.slice(-99),{key:input.idempotencyKey,hash:hash(input),action:'apply',version:saved.version}];await atomic(file,saved);
   }
   await options.onApply();return {...project(saved),restarting:true};
  })
 };
}
