import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {readLaunchConfig,loadProfiles} from '../.local-workspace-release/scripts/parallel-local-config.mts';

const original='C:/Users/a4151/.codex/worktrees/adc7/ai代聊';
const release='C:/1/ai代聊/.local-workspace-release';
const backup=join(process.env.LOCALAPPDATA!,'ChatAgentTrial','workspace-backup-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(backup,{recursive:true});
const profiles=await loadProfiles(original,await readLaunchConfig(original));
const snapshots=[];
for(const profile of profiles) {
  const pool=new Pool({connectionString:profile.env.DATABASE_URL});
  try {
    const migrations=(await pool.query('SELECT number,filename,sha256 FROM schema_migrations ORDER BY number')).rows;
    for(const row of migrations) {
      const sql=await readFile(join(release,'db/migrations',row.filename));
      if(createHash('sha256').update(sql).digest('hex')!==row.sha256)throw Error('DEPLOYMENT_MIGRATION_DRIFT');
    }
    const global=(await pool.query('SELECT paused,pause_epoch FROM dispatch_global_control')).rows[0];
    const conversations=(await pool.query('SELECT conversation_id,contact_id,state,pause_reasons,version FROM orch_conversations')).rows;
    const sends=(await pool.query('SELECT status,count(*)::int AS count FROM orch_send_tasks GROUP BY status')).rows;
    const url=new URL(profile.env.DATABASE_URL!);
    await new Promise<void>((done,fail)=>{
      const child=spawn(join(profile.env.LOCAL_PG_BIN!,'pg_dump.exe'),['-Fc','-f',join(backup,profile.platform+'.dump')],{windowsHide:true,stdio:'ignore',env:{...process.env,PGHOST:url.hostname,PGPORT:url.port,PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password)}});
      child.once('error',fail);child.once('exit',code=>code===0?done():fail(Error('BACKUP_FAILED')));
    });
    snapshots.push({platform:profile.platform,global,conversations,sends});
    console.log(JSON.stringify({platform:profile.platform,migrations:migrations.length,conversations:conversations.length,globalPaused:global.paused,sends}));
  }finally {await pool.end();}
}
for(const filename of ['profiles.json','model.json','owner.json','model-budget.json']) {
  try{await copyFile(join(original,'.local-launch',filename),join(backup,filename));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
}
await writeFile(join(backup,'state.json'),JSON.stringify(snapshots),{mode:0o600});
await writeFile(join(release,'.local-launch','activation-backup.json'),JSON.stringify({backup,original}),{mode:0o600});
console.log(JSON.stringify({backup}));
