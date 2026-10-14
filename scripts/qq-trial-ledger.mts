/** The runtime must hold its database lease before opening this journal. */
import {constants} from 'node:fs';
import {open,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PaidReplayBudget,type BudgetEvent,type ReplayPrice} from '../packages/ai/eval/paid-replay-budget.mts';
export async function openQqTrialLedger(options:{root:string;restore:boolean;maxCny:number;maxCalls:number;price:ReplayPrice}){
  const path=join(options.root,'calls.jsonl');
  const restore:BudgetEvent[]=options.restore?(await readFile(path,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const file=await open(path,options.restore?constants.O_WRONLY|constants.O_APPEND:'wx');
  let queue=Promise.resolve();
  try{
    const budget=new PaidReplayBudget({...options,restore,journal:event=>{
      queue=queue.then(async()=>{await file.appendFile(JSON.stringify(event)+'\n');await file.sync();});return queue;
    }});
    return {budget,async close(){try{await queue;}finally{await file.close();}}};
  }catch(error){await file.close();throw error;}
}
