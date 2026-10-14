/** Read-only post-deployment checks; never invokes a model, send or login activation. */
import {Pool} from 'pg';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {readLaunchConfig,loadProfiles} from '../.local-workspace-release/scripts/parallel-local-config.mts';
import {PgConfirmedService} from '../.local-workspace-release/packages/orchestration/postgres/confirmed-service.mts';
import {PgDataProvider} from '../.local-workspace-release/packages/data/postgres/provider.mts';
import {createPortalAccounts} from '../.local-workspace-release/scripts/local-portal-accounts.mts';

const root='C:/1/ai代聊/.local-workspace-release';
const config=await readLaunchConfig(root),profiles=await loadProfiles(root,config),stacks:any[]=[],results=[];
for(const profile of profiles) {
  const pool=new Pool({connectionString:profile.env.DATABASE_URL});
  try {
    const migration=(await pool.query('SELECT filename FROM schema_migrations ORDER BY number DESC LIMIT 1')).rows[0]?.filename;
    if(migration!=='0015_platform_accounts.sql')throw Error('MIGRATION_NOT_APPLIED');
    const service=new PgConfirmedService({pool,data:new PgDataProvider(),authority:{},intelligence:{async propose(){throw Error('MODEL_DISABLED');},async checkEdited(){return {allowed:false,reasons:['MODEL_DISABLED']};}},platform:{platform:profile.platform as 'qq'|'wechat',accountId:profile.env[profile.platform==='qq'?'QQ_ACCOUNT_ID':'WECHAT_ACCOUNT_ID']!,async submitSend(){throw Error('SEND_DISABLED');}}});
    const list=await service.workspaceList();
    for(const row of list.items) {
      const detail=await service.workspaceDetail(row.id);
      if(detail.contact.id!==row.contactId || detail.conversation.id!==row.id || detail.tasks.some(task=>task.contactId!==row.contactId))throw Error('WORKSPACE_SCOPE_MISMATCH');
    }
    const overview=await service.ownerOverview();
    const response=await fetch(profile.env.PUBLIC_ORIGIN+'/readyz');if(!response.ok)throw Error('CORE_NOT_READY');
    const corePort=Number(new URL(profile.env.PUBLIC_ORIGIN!).port),bridgePort=Number(profile.env.LOCAL_BRIDGE_PORT);
    stacks.push({platform:profile.platform,env:profile.env,corePort,bridgePort});
    const health=await (await fetch('http://127.0.0.1:'+bridgePort+'/healthz')).json() as any;
    results.push({platform:profile.platform,migration,workspaceConversations:list.total,globalPaused:overview.globalPaused,pauseReasons:[...new Set(list.items.flatMap(row=>row.pauseReasons))],bridge:health.status,watchdog:health.watchdog?.status});
  }finally {await pool.end();}
}
const portal='http://127.0.0.1:8790';
const response=await fetch(portal),html=await response.text();if(!response.ok)throw Error('WEB_NOT_READY');
const asset=/src="([^"]+\.js)"/.exec(html)?.[1];if(!asset)throw Error('WEB_ASSET_MISSING');
const script=await (await fetch(portal+asset)).text();if(!script.includes('聊天工作台'))throw Error('OLD_WEB_BUILD');
const unauthenticated=await fetch(portal+'/api/v1/workspace/conversations');if(unauthenticated.status!==401)throw Error('WORKSPACE_AUTH_BOUNDARY_FAILED');
const accounts=await createPortalAccounts({root,config,stacks}).accounts();
const report={checkedAt:new Date().toISOString(),url:portal,results,accounts:accounts.items.map(row=>({platform:row.platform,state:row.state,backendReady:row.backendReady,bridgeState:row.bridgeState})),workspaceAuthStatus:unauthenticated.status};
await writeFile(join(root,'.local-launch/activation-health.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
