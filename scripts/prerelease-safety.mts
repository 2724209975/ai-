import {resolve,relative,isAbsolute,join} from 'node:path';
import {readFile,lstat,realpath} from 'node:fs/promises';
export function managedPath(root:string,path:string){const rel=relative(resolve(root),resolve(path));if(!rel||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))throw new Error('PRERELEASE_PATH_OUTSIDE_ROOT');return resolve(path);}
export async function assertPhysicalManaged(root:string,path:string){managedPath(root,path);const a=await realpath(root),b=await realpath(path);managedPath(a,b);if((await lstat(path)).isSymbolicLink())throw new Error('PRERELEASE_LINK_REFUSED');return b;}
export function parsePrivateProfile(text:string):Record<string,string>{
  const value=text.replace(/^\uFEFF/,'');if(value.trimStart().startsWith('{')){const d=JSON.parse(value);if(!d||typeof d!=='object'||Array.isArray(d)||Object.entries(d).some(([k,v])=>!/^[A-Z][A-Z0-9_]*$/.test(k)||typeof v!=='string'))throw new Error('PRIVATE_PROFILE_INVALID');return d;}
  const d:Record<string,string>={};for(const line of value.split(/\r?\n/)){if(!line.trim()||line.trimStart().startsWith('#'))continue;const m=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);if(!m)throw new Error('PRIVATE_PROFILE_INVALID');d[m[1]!]=m[2]!;}return d;
}
export function prereleaseEnvironment(inherited:NodeJS.ProcessEnv,profile:Record<string,string>):NodeJS.ProcessEnv{
  const env={...inherited};for(const k of Object.keys(env))if(/^(AI_V2_|MEMORY_|DEEPSEEK_|QQ_|WECHAT_|MOBILE_LINK_|LOCAL_|OWNER_|PG|DATABASE_URL$|PUBLIC_ORIGIN$|SESSION_DIR$|RAW_EVENT_DIR$|NODE_OPTIONS$)/.test(k))delete env[k];
  const allowed=['DATABASE_URL','OWNER_ID','OWNER_PASSWORD_HASH','PUBLIC_ORIGIN','PORT','CORE_PLATFORM','SESSION_DIR','WEB_BUILD_DIR','SECURE_COOKIES'];
  const chosen=Object.fromEntries(Object.entries(profile).filter(([k])=>allowed.includes(k)));
  return {...env,...chosen,HOST:'127.0.0.1',START_PAUSED:'1',INTELLIGENCE_PROVIDER:'persistent-fake',COLLECTION_ENABLED:'0',QQ_ENABLE_OUTBOUND:'0',WECHAT_ENABLE_OUTBOUND:'0',WORKER_ENABLED:'0',MEDIA_VISION_ENABLED:'0',MEDIA_VOICE_ENABLED:'0',QQ_MEDIA_FETCH:'0',WECHAT_MEDIA_FETCH:'0',MOBILE_LINK_ENABLED:'0',LOG_LEVEL:'warn'};
}
export async function assertStoppedCluster(dir:string){
  if((await readFile(join(dir,'PG_VERSION'),'utf8')).trim()!=='17')throw new Error('PRERELEASE_POSTGRES_VERSION_MISMATCH');
  try{const pid=Number((await readFile(join(dir,'postmaster.pid'),'utf8')).split(/\r?\n/)[0]);if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('PRERELEASE_SOURCE_PID_INVALID');
    try{process.kill(pid,0);throw new Error('PRERELEASE_SOURCE_DATABASE_RUNNING');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
}
