/** Local prerelease manager. Cold backups and cloned databases only; no daily activation command. */
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,copyFile,cp,rm,open,realpath} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {join,resolve,relative,dirname} from 'node:path';
import {createServer} from 'node:net';
import {Client} from 'pg';
import {hashPassword} from '../packages/infrastructure/auth/password.mts';
import {applyMigrations} from '../packages/infrastructure/postgres/migrate.mts';
import {composeMigrationLineage,readMigrationFiles,writeMigrationLineage} from './prerelease-migrations.mts';
import {assertStoppedCluster,assertPhysicalManaged,managedPath,parsePrivateProfile,prereleaseEnvironment} from './prerelease-safety.mts';
type Profile={platform:'qq'|'wechat';data:string;backup:string;pgPort:number;controlPort:number;env:Record<string,string>};
type State={kind:'isolated-v2-prerelease';releaseId:string;root:string;sourceRoot:string;deployedRoot:string;bin:string;controlToken:string;profiles:Profile[];prepared:boolean};
// fileURLToPath handles Windows Unicode; URL.pathname itself is percent-encoded.
const {fileURLToPath}=await import('node:url');const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pointer=join(sourceRoot,'.local-prerelease/current.json');
const args=process.argv.slice(2),command=args.shift();if(!['prepare','start','stop','status','verify','rollback'].includes(command??''))throw new Error('PRERELEASE_COMMAND_REQUIRED');
const options=new Map<string,string>();for(let i=0;i<args.length;i+=2){if(!['--deployed-root','--root','--pg-home'].includes(args[i]!)||!args[i+1]||options.has(args[i]!))throw new Error('PRERELEASE_ARGUMENT_INVALID');options.set(args[i]!,args[i+1]!);}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function save(path:string,value:unknown){await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
const reservedPorts=new Set<number>();
async function port():Promise<number>{const server=createServer();await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});const value=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));if(reservedPorts.has(value))return port();reservedPorts.add(value);return value;}
function pg(state:State,name:string,args:string[],privateEnv:Record<string,string>={}){const env={...prereleaseEnvironment(process.env,{}),...privateEnv};const r=spawnSync(join(state.bin,name+(process.platform==='win32'?'.exe':'')),args,{cwd:state.root,env,windowsHide:true,stdio:'ignore',timeout:45000});if(r.error||r.status!==0)throw new Error(`PRERELEASE_${name.toUpperCase()}_FAILED`);}
async function fingerprints(root:string){const rows:{path:string;sha256:string;bytes:number}[]=[];async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isSymbolicLink())throw new Error('PRERELEASE_SOURCE_LINK_REFUSED');if(e.isDirectory())await walk(path);else if(e.isFile()){const b=await readFile(path);rows.push({path:relative(root,path).replaceAll('\\','/'),sha256:digest(b),bytes:b.length});}}}await walk(root);return rows.sort((a,b)=>a.path.localeCompare(b.path));}
async function client(profile:Profile){const c=new Client({connectionString:profile.env.DATABASE_URL,connectionTimeoutMillis:3000,statement_timeout:15000});await c.connect();return c;}
async function inventory(c:Client,existing?:Record<string,string[]>){
  const tables=existing??{};if(!existing){for(const name of ['data_contacts','data_messages','data_facts','orch_send_tasks','dispatch_attempts','platform_inbox_raw','data_relationship_memory','mobile_link_state']){const rows=(await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position',[name])).rows;if(rows.length)tables[name]=rows.map(r=>r.column_name);}}
  const values:Record<string,{rows:number;hash:string|null}>={};for(const [name,columns]of Object.entries(tables)){if(!/^[a-z0-9_]+$/.test(name)||columns.some(n=>!/^[a-z0-9_]+$/.test(n)))throw new Error('PRERELEASE_SCHEMA_INVALID');const projection=columns.map(n=>`"${n}"`).join(',');values[name]=(await c.query(`SELECT count(*)::int rows,md5(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text))) hash FROM (SELECT ${projection} FROM "${name}") t`)).rows[0];}return {tables,values};
}
async function pgRunning(profile:Profile){try{await assertStoppedCluster(profile.data);return false;}catch(e){if((e as Error).message!=='PRERELEASE_SOURCE_DATABASE_RUNNING')throw e;}
  const c=await client(profile);try{const actual=(await c.query('SHOW data_directory')).rows[0]?.data_directory;if(!actual||resolve(actual).toLowerCase()!==resolve(profile.data).toLowerCase())throw new Error('PRERELEASE_DATABASE_OWNERSHIP_UNVERIFIED');return true;}finally{await c.end();}}
async function startDatabase(state:State,p:Profile){await assertPhysicalManaged(state.root,p.data);if(await pgRunning(p))return;pg(state,'pg_ctl',['-D',p.data,'-l',join(state.root,'logs',`${p.platform}-postgres.log`),'-w','start']);}
async function stopDatabase(state:State,p:Profile){await assertPhysicalManaged(state.root,p.data);if(await pgRunning(p))pg(state,'pg_ctl',['-D',p.data,'-m','fast','-w','stop']);}
async function control(state:State,p:Profile,action:'status'|'stop'){
  const response=await fetch(`http://127.0.0.1:${p.controlPort}/${action}`,{method:action==='stop'?'POST':'GET',headers:{'x-prerelease-token':state.controlToken},signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error('PRERELEASE_CONTROL_REJECTED');const body=await response.json() as Record<string,unknown>;if(action==='status'&&(body.releaseId!==state.releaseId||body.platform!==p.platform))throw new Error('PRERELEASE_CONTROL_REJECTED');return body;
}
async function startHost(state:State,p:Profile,index:number){
  try{await control(state,p,'status');return;}catch{}
  const log=await open(join(state.root,'logs',`${p.platform}-core.log`),'a');try{const child=spawn(process.execPath,[join(state.root,'release/scripts/prerelease-host.mts'),state.root,String(index)],{cwd:join(state.root,'release'),env:prereleaseEnvironment(process.env,p.env),windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();}finally{await log.close();}
  const deadline=Date.now()+20000;while(Date.now()<deadline){try{await control(state,p,'status');const r=await fetch(p.env.PUBLIC_ORIGIN+'/readyz',{signal:AbortSignal.timeout(1500)});if(r.ok&&(await r.json() as {status:string}).status==='ready')return;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error('PRERELEASE_HOST_NOT_READY');
}
async function stopHosts(state:State){for(const p of state.profiles){try{await control(state,p,'stop');}catch{continue;}const deadline=Date.now()+15000;while(Date.now()<deadline){try{await control(state,p,'status');}catch{break;}await new Promise(r=>setTimeout(r,100));}}}
async function start(state:State){if(!state.prepared)throw new Error('PRERELEASE_NOT_PREPARED');try{for(const [i,p]of state.profiles.entries()){await startDatabase(state,p);await startHost(state,p,i);}}catch(e){await stopHosts(state);for(const p of state.profiles)await stopDatabase(state,p).catch(()=>{});throw e;}}
async function stop(state:State){await stopHosts(state);for(const p of state.profiles)await stopDatabase(state,p);}
async function status(state:State){const profiles=[];for(const p of state.profiles){let ready=false;try{await control(state,p,'status');ready=(await fetch(p.env.PUBLIC_ORIGIN+'/readyz',{signal:AbortSignal.timeout(1000)})).ok;}catch{}profiles.push({platform:p.platform,url:p.env.PUBLIC_ORIGIN+'/#chat',ready});}return {releaseId:state.releaseId,prepared:state.prepared,profiles,realPlatformConnected:false,realModelEnabled:false,automaticSendEnabled:false};}
async function load():Promise<State>{const root=options.has('--root')?resolve(options.get('--root')!):JSON.parse(await readFile(pointer,'utf8')).root;const state=JSON.parse(await readFile(join(root,'private/state.json'),'utf8'));if(state.kind!=='isolated-v2-prerelease'||state.root!==root)throw new Error('PRERELEASE_MANIFEST_INVALID');await assertPhysicalManaged(root,join(root,'private/state.json'));return state;}
async function prepare(){
  if(!process.env.LOCALAPPDATA)throw new Error('PRERELEASE_LOCALAPPDATA_REQUIRED');
  const deployedRoot=resolve(options.get('--deployed-root')??join(sourceRoot,'.local-workspace-release'));
  const base=resolve(process.env.LOCALAPPDATA,'ChatAgentTrial/v2-prerelease'),releaseId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex'),root=join(base,releaseId);
  await mkdir(root,{recursive:true});
  if(process.platform==='win32'){const who=spawnSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});const sid=who.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];if(!sid)throw new Error('PRERELEASE_ACL_FAILED');const acl=spawnSync('icacls',[root,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','/Q'],{windowsHide:true,stdio:'ignore'});if(acl.status!==0)throw new Error('PRERELEASE_ACL_FAILED');}
  for(const dir of ['private','backups','databases','logs','release','baseline-migrations'])await mkdir(join(root,dir));
  const config=JSON.parse((await readFile(join(deployedRoot,'.local-launch/profiles.json'),'utf8')).replace(/^\uFEFF/,''));if(!Array.isArray(config.profiles)||config.profiles.length<1||config.profiles.length>2)throw new Error('PRERELEASE_PROFILE_INVALID');
  const state:State={kind:'isolated-v2-prerelease',releaseId,root,sourceRoot,deployedRoot,bin:join(root,'pgsql/bin'),controlToken:randomBytes(32).toString('hex'),profiles:[],prepared:false};await save(join(root,'private/state.json'),state);
  const originals=[];const password=randomBytes(18).toString('base64url'),passwordHash=await hashPassword(password);
  // Offline backups are immutable; only their separate working copies are ever started.
  for(const profile of config.profiles){if(!['qq','wechat'].includes(profile.platform)||state.profiles.some(p=>p.platform===profile.platform))throw new Error('PRERELEASE_PROFILE_INVALID');
    const values={...parsePrivateProfile(await readFile(profile.envFile,'utf8')),...profile.overrides};const data=await realpath(values.LOCAL_PG_DATA);await assertStoppedCluster(data);const before=await fingerprints(data);
    const backup=join(root,'backups',profile.platform);await cp(data,backup,{recursive:true,errorOnExist:true,force:false});await assertStoppedCluster(data);const after=await fingerprints(data);if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(before)!==JSON.stringify(await fingerprints(backup)))throw new Error('PRERELEASE_COLD_BACKUP_CHANGED');
    await save(join(root,'private',`${profile.platform}-cold-files.json`),before);originals.push({platform:profile.platform,data});
    const working=join(root,'databases',profile.platform);await cp(backup,working,{recursive:true,errorOnExist:true,force:false});await assertPhysicalManaged(root,working);await rm(join(working,'postmaster.pid'),{force:true});
    const pgPort=await port(),corePort=await port(),controlPort=await port();const url=new URL(values.DATABASE_URL);if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1')throw new Error('PRERELEASE_SOURCE_DATABASE_NOT_LOCAL');url.port=String(pgPort);
    // Discard inherited archive/replication/log paths so copied server configuration cannot write to the source.
    await writeFile(join(working,'postgresql.conf'),`listen_addresses = '127.0.0.1'\nport = ${pgPort}\nmax_connections = 100\nshared_buffers = '32MB'\nwal_level = replica\nlogging_collector = off\narchive_mode = off\n`);
    await writeFile(join(working,'postgresql.auto.conf'),'# Isolated prerelease: original ALTER SYSTEM paths intentionally excluded.\n');
    await writeFile(join(working,'pg_hba.conf'),'host all all 127.0.0.1/32 trust\n');
    const env={DATABASE_URL:url.toString(),OWNER_ID:values.OWNER_ID,OWNER_PASSWORD_HASH:passwordHash,PUBLIC_ORIGIN:`http://127.0.0.1:${corePort}`,PORT:String(corePort),CORE_PLATFORM:profile.platform,SESSION_DIR:join(root,'private',profile.platform+'-sessions'),WEB_BUILD_DIR:join(root,'release/apps/web/build'),SECURE_COOKIES:'0'};
    state.profiles.push({platform:profile.platform,data:working,backup,pgPort,controlPort,env});
    await copyFile(profile.envFile,join(root,'private',`${profile.platform}-original-env`));
  }
  await save(join(root,'private/originals.json'),originals);await writeFile(join(root,'private/access.txt'),`本机隔离预发布登录密码：${password}\n所有预发布网页共用此密码；日常登录密码没有改变。\n`,{mode:0o600});
  for(const name of ['profiles.json','model.json','owner.json','model-budget.json']){try{await copyFile(join(deployedRoot,'.local-launch',name),join(root,'private',name));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  await cp(resolve(options.get('--pg-home')??join(sourceRoot,'.pg-local/pgsql')),join(root,'pgsql'),{recursive:true,errorOnExist:true,force:false});
  const built=spawnSync(process.env.ComSpec??'cmd.exe',['/d','/s','/c','npm run build:web'],{cwd:sourceRoot,env:{...prereleaseEnvironment(process.env,{}),NODE_ENV:'production'},windowsHide:true,stdio:'ignore',timeout:60000});if(built.status!==0)throw new Error('PRERELEASE_PRODUCTION_WEB_BUILD_FAILED');
  for(const dir of ['apps/core','apps/bridge','apps/web/server','apps/web/build','packages','scripts','node_modules'])await cp(join(sourceRoot,dir),join(root,'release',dir),{recursive:true,errorOnExist:true,force:false});await copyFile(join(sourceRoot,'package.json'),join(root,'release/package.json'));
  await save(join(root,'private/state.json'),state);const deployed=await readMigrationFiles(join(deployedRoot,'db/migrations')),source=await readMigrationFiles(join(sourceRoot,'db/migrations'));for(const f of deployed)await writeFile(join(root,'baseline-migrations',f.filename),f.bytes);
  const results=[];let lineage:ReturnType<typeof composeMigrationLineage>|undefined;
  try{for(const p of state.profiles){await startDatabase(state,p);const c=await client(p);try{
      const stagingPassword=randomBytes(24).toString('hex'),username=decodeURIComponent(new URL(p.env.DATABASE_URL).username);if(!username)throw new Error('PRERELEASE_DATABASE_USER_REQUIRED');await c.query(`ALTER ROLE "${username.replaceAll('"','""')}" PASSWORD '${stagingPassword}'`);
      const url=new URL(p.env.DATABASE_URL);url.password=stagingPassword;p.env.DATABASE_URL=url.toString();await writeFile(join(p.data,'pg_hba.conf'),'host all all 127.0.0.1/32 scram-sha-256\n');await c.query('SELECT pg_reload_conf()');
      const ledger=(await c.query('SELECT number,filename,sha256 FROM schema_migrations ORDER BY number')).rows;const composed=composeMigrationLineage(deployed,source,ledger);
      if(!lineage){lineage=composed;await writeMigrationLineage(join(root,'release/db/migrations'),composed);}else if(JSON.stringify(composed.mapping)!==JSON.stringify(lineage.mapping))throw new Error('PRERELEASE_LINEAGE_MISMATCH');
      const before=await inventory(c);await save(join(root,'private',`${p.platform}-before.json`),before);const applied=await applyMigrations(c,join(root,'release/db/migrations'));const after=await inventory(c,before.tables);if(JSON.stringify(before.values)!==JSON.stringify(after.values))throw new Error('PRERELEASE_EXISTING_DATA_CHANGED');
      if((await applyMigrations(c,join(root,'release/db/migrations'))).length)throw new Error('PRERELEASE_MIGRATION_NOT_IDEMPOTENT');
      pg(state,'pg_dump',['-Fc','--no-owner','--no-acl','-f',join(root,'backups',`${p.platform}-upgraded.dump`),'-h','127.0.0.1','-p',String(p.pgPort),'-U',username,'-d',decodeURIComponent(url.pathname.slice(1))],{PGPASSWORD:stagingPassword});
      results.push({platform:p.platform,previousMigrations:ledger.length,migrations:(await c.query('SELECT count(*)::int count FROM schema_migrations')).rows[0].count,applied,existingDataPreserved:true,tableRows:Object.fromEntries(Object.entries(before.values).map(([t,v])=>[t,v.rows]))});
    }finally{await c.end();await stopDatabase(state,p);}}
  }catch(e){for(const p of state.profiles)await stopDatabase(state,p).catch(()=>{});throw e;}
  state.prepared=true;await save(join(root,'private/state.json'),state);await save(join(root,'preparation.json'),{releaseId,results,migrationMapping:lineage?.mapping,outbound:false,cloud:false,dailyDataChanged:false});
  await mkdir(dirname(pointer),{recursive:true});await save(pointer,{root,releaseId});console.log(JSON.stringify({releaseId,prepared:true,profiles:results,migrationMapping:lineage?.mapping.filter(m=>m.action==='append'),realPlatformConnected:false,realModelEnabled:false,automaticSendEnabled:false}));
}
async function verify(state:State){
  await start(state);const first=await status(state);if(first.profiles.some(p=>!p.ready))throw new Error('PRERELEASE_NOT_READY');
  for(const p of state.profiles){const root=await fetch(p.env.PUBLIC_ORIGIN);if(!root.ok||!(await root.text()).includes('/assets/'))throw new Error('PRERELEASE_WEB_NOT_BUILT');
    const api=await fetch(p.env.PUBLIC_ORIGIN+'/api/v2/model-config');if(api.status!==401)throw new Error('PRERELEASE_AUTH_NOT_ENFORCED');
    const c=await client(p);try{if(!(await c.query('SELECT paused FROM dispatch_global_control')).rows[0]?.paused)throw new Error('PRERELEASE_NOT_PAUSED');const baseline=JSON.parse(await readFile(join(state.root,'private',`${p.platform}-before.json`),'utf8'));const now=await inventory(c,baseline.tables);
      for(const table of ['data_contacts','data_messages','orch_send_tasks','dispatch_attempts','data_relationship_memory','mobile_link_state'])if(baseline.values[table]&&JSON.stringify(now.values[table])!==JSON.stringify(baseline.values[table]))throw new Error('PRERELEASE_HISTORICAL_DATA_CHANGED');
    }finally{await c.end();}}
  await stop(state);await start(state);const restarted=await status(state);if(restarted.profiles.some(p=>!p.ready))throw new Error('PRERELEASE_RESTART_FAILED');
  const originals=JSON.parse(await readFile(join(state.root,'private/originals.json'),'utf8'));for(const p of originals){await assertStoppedCluster(p.data);const expected=JSON.parse(await readFile(join(state.root,'private',`${p.platform}-cold-files.json`),'utf8'));if(JSON.stringify(expected)!==JSON.stringify(await fingerprints(p.data)))throw new Error('PRERELEASE_DAILY_SOURCE_CHANGED');}
  const report={releaseId:state.releaseId,startPassed:true,restartPassed:true,authPassed:true,existingDataPreserved:true,dailySourceUnchanged:true,realPlatformConnected:false,realModelEnabled:false,automaticSendEnabled:false,profiles:restarted.profiles};await save(join(state.root,'verification.json'),report);console.log(JSON.stringify(report));
}
async function rollback(state:State){
  await stop(state);const outcomes=[];for(const p of state.profiles){const restore=join(state.root,'databases',p.platform+'-rollback-'+randomBytes(4).toString('hex'));await cp(p.backup,restore,{recursive:true,errorOnExist:true,force:false});await assertPhysicalManaged(state.root,restore);await rm(join(restore,'postmaster.pid'),{force:true});
    const pgPort=await port();await writeFile(join(restore,'postgresql.conf'),`listen_addresses = '127.0.0.1'\nport = ${pgPort}\nmax_connections = 100\nshared_buffers = '32MB'\nlogging_collector = off\narchive_mode = off\n`);await writeFile(join(restore,'postgresql.auto.conf'),'# Isolated rollback rehearsal\n');await writeFile(join(restore,'pg_hba.conf'),'host all all 127.0.0.1/32 trust\n');
    const originals=JSON.parse(await readFile(join(state.root,'private/profiles.json'),'utf8'));const source=originals.profiles.find((x:{platform:string})=>x.platform===p.platform),values={...parsePrivateProfile(await readFile(join(state.root,'private',`${p.platform}-original-env`),'utf8')),...source.overrides},url=new URL(values.DATABASE_URL);url.port=String(pgPort);
    const back={...p,data:restore,pgPort,env:{...p.env,DATABASE_URL:url.toString()}};await startDatabase(state,back);const c=await client(back);try{const before=JSON.parse(await readFile(join(state.root,'private',`${p.platform}-before.json`),'utf8'));const actual=await inventory(c,before.tables);if(JSON.stringify(actual.values)!==JSON.stringify(before.values))throw new Error('PRERELEASE_ROLLBACK_DATA_CHANGED');
      const applied=await applyMigrations(c,join(state.root,'baseline-migrations'));if(applied.length)throw new Error('PRERELEASE_ROLLBACK_LINEAGE_CHANGED');outcomes.push({platform:p.platform,originalDataRestored:true,legacyMigrationsValid:true,newPipelinePresent:(await c.query("SELECT to_regclass('orch_reply_jobs') name")).rows[0].name!==null});
    }finally{await c.end();await stopDatabase(state,back);}}
  await save(join(state.root,'rollback.json'),{releaseId:state.releaseId,outcomes,dailySourceTouched:false});await start(state);console.log(JSON.stringify({releaseId:state.releaseId,rollbackRehearsal:outcomes,previewRestarted:true,dailySourceTouched:false}));
}
try{if(command==='prepare')await prepare();else{const state=await load();let lock:Awaited<ReturnType<typeof open>>|undefined;const lockPath=join(state.root,'private/command.lock');
  try{if(command!=='status'){try{lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,releaseId:state.releaseId}));}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new Error('PRERELEASE_COMMAND_IN_PROGRESS');throw e;}}
    if(command==='start'){await start(state);console.log(JSON.stringify(await status(state)));}else if(command==='stop'){await stop(state);console.log(JSON.stringify({stopped:true,releaseId:state.releaseId}));}else if(command==='status')console.log(JSON.stringify(await status(state)));else if(command==='verify')await verify(state);else if(command==='rollback')await rollback(state);
  }finally{if(lock){await lock.close();await rm(lockPath);}}}}
catch(error){process.stderr.write((error instanceof Error?error.message:'PRERELEASE_FAILED')+'\n');process.exitCode=1;}
