/** Shared, restart-stable conservative CNY admission budget for the local dual-platform portal.
 * Reserve before HTTP; errors/timeouts retain their reservation. This is not a provider invoice.
 * Input uses a UTF-8 byte upper bound plus protocol allowance, output uses max_tokens. */
import {changeMoneyRow,readMoneyRow,type MoneyRow} from './unified-budget.mts';
import type { TextModelProvider } from './text-provider-contract.mts';
export type SharedBudget = { path: string; dailyCny: number; dailyCalls: number; dailyTokens: number; inputCnyPerMillion: number; outputCnyPerMillion: number; maxOutputTokens: number; now?: () => number };
export const budgetDay = (now: number) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
export async function readSharedBudget(path: string, now = Date.now()) {
  const row=await readMoneyRow(path);
  return row?.day===budgetDay(now)?row:{day:budgetDay(now),reservedMicros:0,calls:0,tokens:0,...(row?.fund?{fund:row.fund}:{})} as MoneyRow;
}
export function withSharedBudget(provider: TextModelProvider, options: SharedBudget, inputUpperBound: (input: Parameters<TextModelProvider['invoke']>[0]) => number): TextModelProvider {
  if (!options.path || ![options.dailyCny, options.inputCnyPerMillion, options.outputCnyPerMillion].every(value => Number.isFinite(value) && value > 0)
    || ![options.dailyCalls, options.dailyTokens, options.maxOutputTokens].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('VALIDATION_FAILED');
  async function reserve(tokensIn: number) {
    if (!Number.isSafeInteger(tokensIn) || tokensIn < 1) throw new Error('MODEL_BUDGET_UNAVAILABLE');
    await changeMoneyRow(options.path,old=>{
      const day=budgetDay(options.now?.()??Date.now());const row:MoneyRow=old?.day===day?old:{day,reservedMicros:0,calls:0,tokens:0,...(old?.fund?{fund:old.fund}:{})};
      const tokens = tokensIn + options.maxOutputTokens;
      const micros = Math.ceil(tokensIn * options.inputCnyPerMillion + options.maxOutputTokens * options.outputCnyPerMillion);
      if (row.calls + 1 > options.dailyCalls || row.tokens + tokens > options.dailyTokens || row.reservedMicros + micros > Math.floor(options.dailyCny * 1_000_000)) throw new Error('MODEL_BUDGET_EXHAUSTED');
      if(row.fund?.policy&&(row.calls+1>row.fund.policy.dailyCalls||row.tokens+tokens>row.fund.policy.dailyTokens||row.reservedMicros+micros>row.fund.policy.dailyMicroCny))throw new Error('MODEL_BUDGET_EXHAUSTED');
      if(row.fund){if(row.fund.desktopMicroCny+row.fund.phones.reduce((n,p)=>n+p.limitMicroCny,0)+micros>row.fund.limitMicroCny)throw new Error('MODEL_BUDGET_EXHAUSTED');row.fund.desktopMicroCny+=micros;}
      return {row:{...row,reservedMicros:row.reservedMicros+micros,calls:row.calls+1,tokens:row.tokens+tokens},value:undefined};
    });
  }
  return { ...provider, async invoke(input) { await reserve(inputUpperBound(input)); return provider.invoke(input); } };
}
