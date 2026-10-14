/** Isolated preview composition: production Core, no Bridge, no cloud credentials. */
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import {readCoreConfig} from '../apps/core/config.mts';
import {createCoreRuntime} from '../apps/core/runtime.mts';
import {prereleaseEnvironment,assertPhysicalManaged} from './prerelease-safety.mts';
const [base,index]=process.argv.slice(2);if(!base||!/^\d+$/.test(index??''))throw new Error('PRERELEASE_HOST_ARGUMENT_INVALID');
const root=resolve(base);await assertPhysicalManaged(root,join(root,'private/state.json'));
const state=JSON.parse(await readFile(join(root,'private/state.json'),'utf8')),profile=state.profiles[Number(index)];
if(state.kind!=='isolated-v2-prerelease'||!profile)throw new Error('PRERELEASE_MANIFEST_INVALID');
const clean=prereleaseEnvironment(process.env,profile.env);for(const k of Object.keys(process.env))if(!(k in clean))delete process.env[k];Object.assign(process.env,clean);
const config=readCoreConfig(clean),pool=new Pool({connectionString:config.databaseUrl,max:8});const runtime=createCoreRuntime({config,pool});
let closing=false;const stop=async()=>{if(closing)return;closing=true;await runtime.stop();await pool.end();control.close(()=>process.exit(0));};
const control=createServer((req,res)=>{const supplied=Buffer.from(req.headers['x-prerelease-token']?.toString()??''),expected=Buffer.from(state.controlToken);
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(403);res.end();return;}
  if(req.url==='/status'&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({kind:state.kind,releaseId:state.releaseId,platform:profile.platform,pid:process.pid}));return;}
  if(req.url==='/stop'&&req.method==='POST'){res.end(JSON.stringify({stopping:true}));void stop().catch(()=>process.exit(1));return;}res.writeHead(404);res.end();});
try{await runtime.start();await runtime.listen();await new Promise<void>((r,j)=>{control.once('error',j);control.listen(profile.controlPort,'127.0.0.1',r);});
  await writeFile(join(root,'private',`${profile.platform}-host.json`),JSON.stringify({pid:process.pid,releaseId:state.releaseId}),{mode:0o600});
}catch{await runtime.stop().catch(()=>{});await pool.end().catch(()=>{});process.exit(1);}
for(const s of ['SIGTERM','SIGINT'] as const)process.on(s,()=>{void stop().catch(()=>process.exit(1));});
