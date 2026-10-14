import {LinkBudget} from '../packages/link/budget.mts';
import {PgLinkStore} from '../packages/link/store.mts';
import type {PgPool} from '../packages/infrastructure/postgres/transaction.mts';
/** Use the resolved trial data owner after migrations, never an inherited/missing process environment owner. */
export async function createQqTrialLinkBudget(options:{pool:PgPool;ownerId:string;budgetId:string;desktop:()=>{limitCny:number;accountedCny:number;halted:boolean}}){
  if(typeof options.ownerId!=='string'||!options.ownerId.trim())throw new Error('QQ_TRIAL_LINK_OWNER_REQUIRED');
  const budget=new LinkBudget(new PgLinkStore(options.pool,options.ownerId),options.budgetId,options.desktop);
  await budget.initialize();return budget;
}
