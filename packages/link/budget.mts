import type {LinkStore} from './types.mts';
export type PhoneAllowance={deviceId:string;limitMicroCny:number;spentMicroCny:number;calls:number;tokens:number;updatedAt:number;lastReportedAt?:number};
export interface LinkBudgetPort {initialize():Promise<void>;view(deviceId?:string):Promise<{budgetId:string;limitMicroCny:number;desktopMicroCny:number;halted:boolean;phones:PhoneAllowance[]}>;allocate(deviceId:string,limitMicroCny:number):Promise<unknown>;report(deviceId:string,report:{budgetId:string;spentMicroCny:number;calls:number;tokens:number}):Promise<unknown>}
/** Allocations are cumulative and never reclaimed while a phone can spend offline. */
export class LinkBudget {
  private allocated=0;
  private store:LinkStore;readonly budgetId:string;private desktop:()=>{limitCny:number;accountedCny:number;halted:boolean};
  constructor(store:LinkStore,budgetId:string,desktop:()=>{limitCny:number;accountedCny:number;halted:boolean}){this.store=store;this.budgetId=budgetId;this.desktop=desktop;}
  async initialize(){const state=await this.store.read();const b=state.budget;if(b&&b.id!==this.budgetId)throw new Error('BUDGET_SCOPE_CHANGED');this.allocated=(b?.phones??[]).reduce((n,p)=>n+p.limitMicroCny,0);}
  get blockedMicroCny(){return this.allocated;}
  async view(deviceId?:string){const s=await this.store.read();const d=this.desktop();const phones=s.budget?.phones??[];return {budgetId:this.budgetId,limitMicroCny:Math.floor(d.limitCny*1e6),desktopMicroCny:Math.ceil(d.accountedCny*1e6),halted:d.halted,phones:deviceId?phones.filter(p=>p.deviceId===deviceId):phones};}
  async allocate(deviceId:string,limitMicroCny:number){return this.store.change(s=>{
    if(!s.devices.some(d=>d.id===deviceId&&!d.revoked))throw new Error('FORBIDDEN');
    if(!Number.isSafeInteger(limitMicroCny)||limitMicroCny<1)throw new Error('INVALID_ALLOWANCE');
    const b=s.budget??={id:this.budgetId,phones:[]};if(b.id!==this.budgetId)throw new Error('BUDGET_SCOPE_CHANGED');
    const old=b.phones.find(p=>p.deviceId===deviceId);const previous=old?.limitMicroCny??0;
    if(limitMicroCny<previous)throw new Error('OFFLINE_ALLOWANCE_CANNOT_SHRINK');
    const d=this.desktop();const allocated=b.phones.reduce((n,p)=>n+p.limitMicroCny,0)+limitMicroCny-previous;
    if(d.halted||Math.ceil(d.accountedCny*1e6)+allocated>Math.floor(d.limitCny*1e6))throw new Error('BUDGET_EXHAUSTED');
    if(old)old.limitMicroCny=limitMicroCny;else b.phones.push({deviceId,limitMicroCny,spentMicroCny:0,calls:0,tokens:0,updatedAt:Date.now()});
    // Conservative cache is changed before persistence: a failed commit never grants PC extra funds.
    this.allocated=allocated;return b;
  });}
  async report(deviceId:string,report:{budgetId:string;spentMicroCny:number;calls:number;tokens:number}){await this.store.change(s=>{
    const p=s.budget?.phones.find(p=>p.deviceId===deviceId);
    if(report.budgetId!==this.budgetId||!p)throw new Error('BUDGET_SCOPE_CHANGED');
    for(const k of ['spentMicroCny','calls','tokens'] as const)if(!Number.isSafeInteger(report[k])||report[k]<p[k])throw new Error('USAGE_REWIND_REFUSED');
    if(report.spentMicroCny>p.limitMicroCny)throw new Error('BUDGET_EXHAUSTED');
    p.spentMicroCny=report.spentMicroCny;p.calls=report.calls;p.tokens=report.tokens;p.updatedAt=Date.now();p.lastReportedAt=p.updatedAt;
  });return this.view(deviceId);}
}
