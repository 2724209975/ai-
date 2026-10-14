import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSharedBudget, readSharedBudget } from './persistent-budget.mts';
import type { TextModelProvider } from './text-provider-contract.mts';
test('two platform providers share a durable conservative budget across restarts, failures and Beijing midnight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-model-budget-')), path = join(root, 'budget.json'); let calls = 0, now = Date.parse('2026-10-04T15:59:59Z');
  const options = { path, dailyCny: .001, dailyCalls: 10, dailyTokens: 1000, inputCnyPerMillion: 2, outputCnyPerMillion: 8, maxOutputTokens: 100, now: () => now };
  const provider = { providerId: 'fixture', modelId: 'fixture', modelVersion: '1', promptVersion: 'fixture', dataRegion: 'local', retentionPolicy: 'none', async invoke() { calls++; throw new Error('fixture timeout'); } } satisfies TextModelProvider;
  const input = { signal: new AbortController().signal } as Parameters<TextModelProvider['invoke']>[0];
  try {
    const qq = withSharedBudget(provider, options, () => 100), wx = withSharedBudget(provider, options, () => 100);
    const results = await Promise.allSettled([qq.invoke(input), wx.invoke(input)]); assert.equal(results.filter(row => row.status === 'rejected').length, 2); assert.equal(calls, 1);
    const restarted = withSharedBudget(provider, options, () => 100); await assert.rejects(restarted.invoke(input), /MODEL_BUDGET_EXHAUSTED/); assert.equal(calls, 1);
    const row = await readSharedBudget(path, now); assert.equal(row.reservedMicros, 1000); assert.equal(row.calls, 1); assert.equal(row.day, '2026-10-04');
    now = Date.parse('2026-10-04T16:00:00Z'); await assert.rejects(restarted.invoke(input), /fixture timeout/); assert.equal(calls, 2);
    assert.equal((await readSharedBudget(path, now)).day, '2026-10-05');
    await writeFile(path, '{corrupt'); await assert.rejects(restarted.invoke(input), /MODEL_BUDGET_UNAVAILABLE/); assert.equal(calls, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
