/** Requires a supplied isolated test database; scrubs all real provider/platform configuration. */
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export function p6TestEnvironment(env:NodeJS.ProcessEnv){
  let url:URL;try{url=new URL(env.TEST_DATABASE_URL??'');}catch{throw new Error('P6_ISOLATED_TEST_DATABASE_REQUIRED');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('P6_ISOLATED_TEST_DATABASE_REQUIRED');
  const out={...env};for(const key of Object.keys(out))if(/^(AI_V2_|MEMORY_|MODEL_|DEEPSEEK_|QQ_|WECHAT_|MOBILE_LINK_|LOCAL_|DATABASE_URL$|OWNER_|SESSION_DIR$|RAW_EVENT_DIR$|PUBLIC_ORIGIN$|PG(?:HOST|PORT|DATABASE|USER|PASSWORD|PASSFILE|SERVICE|SERVICEFILE)$)/.test(key))delete out[key];
  return out;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const env=p6TestEnvironment(process.env);const child=spawn(process.execPath,['--test','packages/ai/eval/acceptance-v2.test.mts','tests/integration/postgres-reply-pipeline-v2.test.mts','tests/integration/postgres-context-memory-v2.test.mts','tests/integration/postgres-decision-models-v2.test.mts','tests/integration/postgres-p6-acceptance.test.mts'],{env,stdio:'inherit',windowsHide:true});
  process.exitCode=await new Promise<number>((res,rej)=>{child.on('error',rej);child.on('exit',code=>res(code??1));});
}
