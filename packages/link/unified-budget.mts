import {configureUnifiedMoneyEnv,unifiedMoneyFromEnv,type UnifiedMoneyBudget} from '../ai/generation/unified-budget.mts';
import type {LinkStore} from './types.mts';
import type {LinkBudgetPort} from './budget.mts';
export class UnifiedLinkBudget implements LinkBudgetPort {
 private money:UnifiedMoneyBudget;private store:LinkStore;
 constructor(money:UnifiedMoneyBudget,store:LinkStore){this.money=money;this.store=store;}
 async initialize(){const state=await this.store.read();if(state.budget?.phones.length)throw new Error('EXISTING_PHONE_BUDGET_REQUIRES_ORIGINAL_LEDGER');await this.money.initialize();}
 view(deviceId?:string){return this.money.view(deviceId);}
 async allocate(deviceId:string,limitMicroCny:number){if(!(await this.store.read()).devices.some(d=>d.id===deviceId&&!d.revoked))throw new Error('FORBIDDEN');return this.money.allocate(deviceId,limitMicroCny);}
 report(deviceId:string,report:{budgetId:string;spentMicroCny:number;calls:number;tokens:number}){return this.money.report(deviceId,report);}
}
export function createUnifiedLinkBudget(env:Record<string,string|undefined>,store:LinkStore){configureUnifiedMoneyEnv(env);return new UnifiedLinkBudget(unifiedMoneyFromEnv(env)!,store);}
