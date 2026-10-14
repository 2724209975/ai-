/** Remove only the supervisor's upgrade pause, keeping all pre-existing contact blockers. */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {readLaunchConfig,loadProfiles} from '../.local-workspace-release/scripts/parallel-local-config.mts';
import {PgConfirmedService} from '../.local-workspace-release/packages/orchestration/postgres/confirmed-service.mts';
import {PgDataProvider} from '../.local-workspace-release/packages/data/postgres/provider.mts';
import {withTransaction} from '../.local-workspace-release/packages/infrastructure/postgres/transaction.mts';
import {acquireDispatchBoundary,changeGlobalPause} from '../.local-workspace-release/packages/infrastructure/postgres/dispatch-journal.mts';
import {appendOutbox} from '../.local-workspace-release/packages/infrastructure/postgres/event-store.mts';

const root='C:/1/ai代聊/.local-workspace-release';
const {backup}=JSON.parse(await readFile(join(root,'.local-launch/activation-backup.json'),'utf8'));
const snapshots=JSON.parse(await readFile(join(backup,'state.json'),'utf8'));
for(const profile of await loadProfiles(root,await readLaunchConfig(root))) {
  const before=snapshots.find((row:any)=>row.platform===profile.platform);
  if(!before || before.global.paused)continue;
  const pool=new Pool({connectionString:profile.env.DATABASE_URL});
  try {
    await withTransaction(pool,async tx=>{
      await acquireDispatchBoundary(tx);
      const current=(await tx.query('SELECT * FROM dispatch_global_control FOR UPDATE')).rows[0];
      if(!current.paused || Number(current.pause_epoch)!==Number(before.global.pause_epoch)+1)throw Error('GLOBAL_STATE_CHANGED_KEEP_PAUSE');
      const version=await changeGlobalPause(tx,false),id=randomUUID();
      await appendOutbox(tx,{eventId:id,eventType:'GlobalPauseChanged',eventVersion:1,occurredAt:new Date().toISOString(),correlationId:id,causationId:id,aggregateId:'global',aggregateVersion:version,payload:{paused:false,reason:'WORKSPACE_UPGRADE_FINISHED'}});
    });
    const service=new PgConfirmedService({pool,data:new PgDataProvider(),authority:{},intelligence:{async propose(){throw Error('MODEL_DISABLED');},async checkEdited(){return {allowed:false,reasons:['MODEL_DISABLED']};}},platform:{platform:profile.platform as 'qq'|'wechat',accountId:profile.env[profile.platform==='qq'?'QQ_ACCOUNT_ID':'WECHAT_ACCOUNT_ID']!,async submitSend(){throw Error('SEND_DISABLED');}}});
    for(const row of (await service.ownerConversations()).items) {
      const original=before.conversations.find((item:any)=>item.conversation_id===row.id);
      if(original && !original.pause_reasons.includes('GLOBAL_PAUSE') && row.pauseReasons.includes('GLOBAL_PAUSE')) {
        try {await service.resumeContact(row.contactId,{expectedVersion:row.version,reason:'GLOBAL_PAUSE',idempotencyKey:randomUUID()});}
        catch {console.log(JSON.stringify({platform:profile.platform,status:'CONTACT_BLOCK_RETAINED'}));}
      }
    }
    const overview=await service.ownerOverview();
    console.log(JSON.stringify({platform:profile.platform,globalPaused:overview.globalPaused,status:'PREVIOUS_RUNTIME_STATE_RESTORED'}));
  }finally {await pool.end();}
}
