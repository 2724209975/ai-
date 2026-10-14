import {createMobileLink} from './runtime.mts';
import {setContactScope,withTransaction,type PgPool} from '../infrastructure/postgres/transaction.mts';
import type {OwnerAuthService} from '../infrastructure/auth/owner-auth.mts';
import {configureUnifiedMoneyEnv,unifiedMoneyFromEnv} from '../ai/generation/unified-budget.mts';
/** Local portal adapter. Each platform retains its own DB and account scope. */
export async function createPortalMobileLink(options:{ownerId:string;auth:OwnerAuthService;configs:{platform:string;env:NodeJS.ProcessEnv}[];pools:Map<string,PgPool>}){
 for(const c of options.configs)configureUnifiedMoneyEnv(c.env);
 const policies=options.configs.map(c=>unifiedMoneyFromEnv(c.env)!.options);
 if(policies.some(p=>p.path!==policies[0].path||p.totalCny!==policies[0].totalCny||p.dailyCny!==policies[0].dailyCny||p.dailyCalls!==policies[0].dailyCalls||p.dailyTokens!==policies[0].dailyTokens))throw new Error('PLATFORM_SHARED_BUDGET_CONFIG_MISMATCH');
 const primary=options.configs.find(c=>c.platform==='qq')??options.configs[0];
 return createMobileLink({env:{...process.env,...primary.env,MOBILE_LINK_ENABLED:undefined},modelEnv:()=>primary.env,pool:options.pools.get(primary.platform)!,ownerId:options.ownerId,auth:options.auth,platformPools:options.pools,
  async contacts(){const items=[];for(const config of options.configs){const pool=options.pools.get(config.platform)!;const accountId=config.env[config.platform==='qq'?'QQ_ACCOUNT_ID':'WECHAT_ACCOUNT_ID'];
   const rows=await withTransaction(pool,tx=>tx.query<{contact_id:string}>('SELECT contact_id FROM orch_conversations WHERE account_id=$1',[accountId]));
   for(const row of rows.rows){const name=await withTransaction(pool,async tx=>{await setContactScope(tx,row.contact_id);return (await tx.query<{display_name:string}>('SELECT display_name FROM data_contacts WHERE id=$1',[row.contact_id])).rows[0]?.display_name;});if(name)items.push({id:`${config.platform}__${row.contact_id}`,name,platform:config.platform});}
  }return {items};}});
}
