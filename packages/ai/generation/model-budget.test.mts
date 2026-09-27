/** Unit tests for the runaway guard: limits, refusal shape, rollover and pass-through fields. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetOptionsFromEnv, DEFAULT_DAILY_CALL_LIMIT, DEFAULT_DAILY_TOKEN_LIMIT, withDailyBudget } from './model-budget.mts';
import type { TextModelProvider } from './text-provider-contract.mts';

const base: TextModelProvider = {
  providerId: 'stub', modelId: 'm', modelVersion: 'v', promptVersion: 'p', dataRegion: 'CN', retentionPolicy: 'x',
  async invoke() { return { alternatives: [], usage: { inputTokens: 100, outputTokens: 20 } }; },
};

test('the guard counts calls and tokens, refuses past the limit and keeps the provider identity', async () => {
  let refused: { reason: string } | undefined;
  const provider = withDailyBudget(base, { maxCallsPerDay: 2, maxTokensPerDay: 1_000, onRefusal: info => { refused = info; } });
  assert.deepEqual([provider.providerId, provider.modelId, provider.modelVersion, provider.promptVersion], ['stub', 'm', 'v', 'p']);
  await provider.invoke({} as never);
  await provider.invoke({} as never);
  await assert.rejects(provider.invoke({} as never), { message: 'MODEL_BUDGET_EXHAUSTED' });
  assert.deepEqual(refused, { reason: 'calls', calls: 2, tokens: 240 });
});

test('a token limit refuses even when the call count is fine', async () => {
  // One call spends 120 tokens, which reaches the 120-token ceiling exactly.
  const provider = withDailyBudget(base, { maxCallsPerDay: 100, maxTokensPerDay: 120 });
  await provider.invoke({} as never);
  await assert.rejects(provider.invoke({} as never), { message: 'MODEL_BUDGET_EXHAUSTED' });
});

test('failed provider attempts count toward the call ceiling', async () => {
  let attempts = 0;
  const failing = withDailyBudget({ ...base, async invoke() { attempts++; throw new Error('provider failed'); } }, { maxCallsPerDay: 2 });
  await assert.rejects(failing.invoke({} as never), { message: 'provider failed' });
  await assert.rejects(failing.invoke({} as never), { message: 'provider failed' });
  await assert.rejects(failing.invoke({} as never), { message: 'MODEL_BUDGET_EXHAUSTED' });
  assert.equal(attempts, 2);
});

test('concurrent calls cannot pass the same remaining slot', async () => {
  let attempts = 0;
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const provider = withDailyBudget({ ...base, async invoke() { attempts++; await waiting; return { alternatives: [], usage: { inputTokens: 1 } }; } }, { maxCallsPerDay: 1 });
  const first = provider.invoke({} as never);
  const second = provider.invoke({} as never);
  finish();
  await first;
  await assert.rejects(second, { message: 'MODEL_BUDGET_EXHAUSTED' });
  assert.equal(attempts, 1);
});

test('counters roll over with the UTC day', async () => {
  let clock = Date.parse('2026-09-26T23:00:00.000Z');
  const provider = withDailyBudget(base, { maxCallsPerDay: 1, now: () => clock });
  await provider.invoke({} as never);
  await assert.rejects(provider.invoke({} as never), { message: 'MODEL_BUDGET_EXHAUSTED' });
  clock = Date.parse('2026-09-27T00:30:00.000Z');
  await provider.invoke({} as never);
});

test('limits come from the environment and malformed values are refused by name', () => {
  assert.deepEqual(budgetOptionsFromEnv({}), { maxCallsPerDay: DEFAULT_DAILY_CALL_LIMIT, maxTokensPerDay: DEFAULT_DAILY_TOKEN_LIMIT, onRefusal: undefined });
  assert.equal(budgetOptionsFromEnv({ DEEPSEEK_DAILY_CALL_LIMIT: '5' }).maxCallsPerDay, 5);
  assert.throws(() => budgetOptionsFromEnv({ DEEPSEEK_DAILY_TOKEN_LIMIT: '0' }), { message: 'INVALID_ENV:DEEPSEEK_DAILY_TOKEN_LIMIT' });
  assert.throws(() => withDailyBudget(base, { maxCallsPerDay: 0 }), { message: 'VALIDATION_FAILED' });
});
