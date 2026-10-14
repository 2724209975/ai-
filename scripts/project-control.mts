/** Single daily entry, anchored to this source checkout and the existing authorized trial. */
import {readFile,writeFile,copyFile,readdir,mkdir,rename} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {projectRelease} from '../packages/infrastructure/release.mts';
import {assertPhysicalManaged} from './prerelease-safety.mts';
export const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function currentProject(root=projectRoot){
 const pointer=JSON.parse(await readFile(join(root,'.local-prerelease/qq-candidate-current.json'),'utf8')),m=JSON.parse(await readFile(pointer.manifest,'utf8'));
 await assertPhysicalManaged(m.prereleaseRoot,pointer.root);await assertPhysicalManaged(pointer.root,pointer.manifest);
 if(resolve(pointer.root)!==resolve(m.root)||m.ownerAuthorized!==true||m.automaticSendAuthorized!==false||!m.persistent)throw new Error('PROJECT_SCOPE_INVALID');
 return {manifest:pointer.manifest,privateRoot:pointer.root};
}
async function control(command:string,manifest:string){const child=spawn(process.execPath,[join(projectRoot,'scripts/qq-trial-control.mts'),command,manifest],{cwd:projectRoot,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',()=>{});const code=await new Promise<number>((r,j)=>{child.on('error',j);child.on('exit',c=>r(c??1));});if(code!==0)throw new Error('PROJECT_CONTROL_FAILED');return JSON.parse(stdout.trim());}
async function hash(file:string){return createHash('sha256').update(await readFile(file)).digest('hex');}
export async function releaseIdentity(root=projectRoot){return {...projectRelease,webHash:await hash(join(root,'apps/web/build/index.html')),apkHash:await hash(join(root,`output/android/reply-assistant-${projectRelease.androidVersion}-debug.apk`)).catch(()=>null)};}
async function main(){const command=process.argv[2]??'status';if(process.argv.length>3||!['start','stop','restart','status','update'].includes(command))throw new Error('PROJECT_COMMAND_INVALID');const current=await currentProject();
 if(command==='update'){
  const build=spawn(process.platform==='win32'?'npm.cmd':'npm',['--prefix','apps/web','run','build','--','--outDir','../../output/project-next-web'],{cwd:projectRoot,windowsHide:true,shell:process.platform==='win32',stdio:'ignore'});
  if(await new Promise<number>((r,j)=>{build.on('error',j);build.on('exit',c=>r(c??1));})!==0)throw new Error('PROJECT_WEB_BUILD_FAILED');
  await control('stop',current.manifest);const backup=join(current.privateRoot,'web-release-'+Date.now());await mkdir(backup);await copyFile(join(projectRoot,'apps/web/build/index.html'),join(backup,'index.html'));
  const next=join(projectRoot,'output/project-next-web');for(const name of await readdir(join(next,'assets')))await copyFile(join(next,'assets',name),join(projectRoot,'apps/web/build/assets',name));
  await copyFile(join(next,'index.html'),join(projectRoot,'apps/web/build/index.html.next'));await rename(join(projectRoot,'apps/web/build/index.html.next'),join(projectRoot,'apps/web/build/index.html'));
  await writeFile(join(projectRoot,'.local-prerelease/project-release.json'),JSON.stringify({...await releaseIdentity(),updatedAt:new Date().toISOString()},null,2));
 }
 const result=await control(command==='update'?'start':command,current.manifest);const rt=await readFile(join(current.privateRoot,'runtime.json'),'utf8').then(JSON.parse).catch(()=>null);
 console.log(JSON.stringify({...result,sourceRoot:projectRoot,release:await releaseIdentity(),runningRelease:result.running?rt?.release??null:null,phoneInstalledVersion:'请在手机设置核对'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e instanceof Error?e.message:'PROJECT_CONTROL_FAILED');process.exitCode=1;});
