import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareReplaySamples } from './replay-samples.mts';
import { replayPrompts, replayOptions, type ReplayOptions } from './prompt-replay.mts';
import { buildPrompt } from '../generation/deepseek-provider.mts';
import { createFakeIntelligencePort } from '../index.mts';
import type { TextModelProvider } from '../generation/text-provider-contract.mts';
const before = '2026-10-02T04:00:00Z', cutoff = '2026-10-02T04:01:00Z', after = '2026-10-02T04:02:00Z';
function sample() {
  const fact = { id: 'f1', version: 1, recordedAt: before, confirmedAt: before, validFrom: before, validUntil: null,
    subject: 'hobby', content: 'EARLY_FACT', evidenceMessageIds: ['m1'], confirmed: true, deleted: false };
  return { schemaVersion: 1, authorization: { ownerAuthorized: true, deidentified: true, externalModelAuthorized: true }, samples: [{
    cutoffTime: cutoff, cutoffMessageId: 'm2', policy: { effectiveAt: before, sendMode: 'confirm', goal: '自然聊天', restrictions: [], stylePreferences: [] },
    messages: [{ id: 'm1', actor: 'owner', sentAt: before, text: 'EARLY_OWNER' }, { id: 'm2', actor: 'contact', sentAt: cutoff, text: '你好' },
      { id: 'm3', actor: 'owner', sentAt: cutoff, text: 'FUTURE_ANSWER' }, { id: 'm4', actor: 'contact', sentAt: after, text: 'FUTURE_MESSAGE' }],
    facts: [fact, { ...fact, version: 2, recordedAt: after, content: 'FUTURE_CORRECTION' }, { ...fact, id: 'f2', confirmedAt: after, content: 'LATE_FACT' },
      { ...fact, id: 'f3', evidenceMessageIds: ['m4'], content: 'FUTURE_EVIDENCE' }, { ...fact, id: 'f4', validUntil: cutoff, content: 'EXPIRED_FACT' }],
  }] };
}
const defaults: ReplayOptions = { versions: ['reply-candidates-1', 'reply-candidates-2'], provider: 'fake' };
function provider(version: string, observe: TextModelProvider['invoke']): TextModelProvider { return {
  providerId: 'fixture', modelId: 'fixture', modelVersion: '1', promptVersion: version, dataRegion: 'local', retentionPolicy: 'none', invoke: observe };
}
test('replay excludes future tied replies, corrections, confirmations, expired facts and future evidence', () => {
  const prepared = prepareReplaySamples(sample()).samples[0]!;
  assert.deepEqual(prepared.context.messages.map(m => m.id), ['m1', 'm2']);
  assert.equal(prepared.context.facts.length, 1); assert.equal(prepared.context.facts[0]!.content, 'EARLY_FACT');
  assert.ok(prepared.context.messages.every(m => m.mode === 'replay'));
  const ai = createFakeIntelligencePort(), decision = ai.makeDecision({ context: prepared.context, policy: prepared.policy }); assert.ok(decision.ok);
  const first = buildPrompt(prepared.context, decision.value, prepared.policy, 'reply-candidates-1');
  const second = buildPrompt(prepared.context, decision.value, prepared.policy, 'reply-candidates-2');
  assert.notEqual(first.system, second.system); assert.equal(first.user, second.user);
  for (const forbidden of ['FUTURE', 'LATE_FACT', 'EXPIRED_FACT']) assert.equal(JSON.stringify([first, second]).includes(forbidden), false);
});
test('replay requires owner authorization, deidentification, historical policy and strict sample keys', () => {
  for (const edit of [(v: any) => { v.authorization.ownerAuthorized = false; }, (v: any) => { v.authorization.deidentified = false; },
    (v: any) => { v.samples[0].summary = 'FUTURE_SUMMARY'; }, (v: any) => { v.samples[0].messages[0].contactId = 'private'; },
    (v: any) => { v.samples[0].policy.effectiveAt = after; }, (v: any) => { v.samples[0].messages[0].text = 'wxid_private'; },
    (v: any) => { v.samples[0].cutoffMessageId = 'm4'; }]) { const input = sample(); edit(input); assert.throws(() => prepareReplaySamples(input), /SAMPLE_INVALID/); }
});
test('fake replay is deterministic, does not construct real providers and exposes only fixed metrics', async () => {
  let created = 0;
  const result = await replayPrompts(sample(), defaults, () => { created++; throw new Error('UNEXPECTED'); });
  assert.equal(created, 0); assert.equal(result.report.calls, 2);
  assert.equal(result.report.rows[0]!.comparisons[0]!.status, 'checked_candidates');
  assert.deepEqual(result.privateCandidates[0]!.alternatives, result.privateCandidates[1]!.alternatives);
  assert.equal(/FUTURE|EARLY|你好/.test(JSON.stringify(result.report)), false);
});
test('real replay requires explicit paid authorization and shares call/token limits between versions', async () => {
  let calls = 0;
  const factory = (version: string) => provider(version, async input => {
    calls++; assert.equal(JSON.stringify(input).includes('FUTURE'), false);
    return { alternatives: [{ clientAlternativeKey: 'a', strategySummary: '回应', parts: [{ clientPartKey: 'p', sequence: 1, type: 'text', content: '嗯，我在。' }] }], usage: { inputTokens: 10, outputTokens: 5 } };
  });
  await assert.rejects(replayPrompts(sample(), { ...defaults, provider: 'deepseek' }, factory), /AUTH_REQUIRED/); assert.equal(calls, 0);
  const denied = sample(); denied.authorization.externalModelAuthorized = false;
  await assert.rejects(replayPrompts(denied, { ...defaults, provider: 'deepseek', allowPaid: true, maxCalls: 2, maxTokens: 50 }, factory), /AUTH_REQUIRED/);
  const result = await replayPrompts(sample(), { ...defaults, provider: 'deepseek', allowPaid: true, maxCalls: 1, maxTokens: 50 }, factory);
  assert.equal(calls, 1); assert.equal(result.report.calls, 1); assert.equal(result.report.reportedTokens, 15);
  assert.equal(result.report.rows[0]!.comparisons[1]!.status, 'MODEL_UNAVAILABLE');
  const capped = await replayPrompts(sample(), { ...defaults, provider: 'deepseek', allowPaid: true, maxCalls: 2, maxTokens: 10 }, factory);
  assert.equal(capped.report.calls, 1); assert.equal(capped.report.budgetAccountedTokens, 15);
});
test('missing real usage exhausts budget, while stop requests never invoke a candidate model', async () => {
  const factory = (version: string) => provider(version, async () => ({ alternatives: [{ clientAlternativeKey: 'a', strategySummary: '回应', parts: [{ clientPartKey: 'p', sequence: 1, type: 'text', content: '嗯，我在。' }] }] }));
  const result = await replayPrompts(sample(), { ...defaults, provider: 'deepseek', allowPaid: true, maxCalls: 2, maxTokens: 50 }, factory);
  assert.equal(result.report.calls, 1); assert.equal(result.report.reportedTokens, null); assert.equal(result.report.budgetAccountedTokens, 50);
  const stopped = sample(); stopped.samples[0]!.messages[1]!.text = '不要再联系我';
  assert.equal((await replayPrompts(stopped, defaults)).report.calls, 0);
});
test('replay CLI defaults fake even with credentials; private output is opt-in and errors never expose input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-fixture-'));
  try {
    const path = join(root, 'sample.json'), output = join(root, 'private.json'); await writeFile(path, JSON.stringify(sample()));
    const cli = spawnSync(process.execPath, ['packages/ai/eval/prompt-replay.mts', '--samples', path, '--private-candidates', output], { encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: 'PRIVATE_KEY' } });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).provider, 'fake'); assert.equal(cli.stdout.includes('PRIVATE'), false);
    assert.ok(JSON.parse(await readFile(output, 'utf8')).candidates[0].alternatives.length);
    const denied = spawnSync(process.execPath, ['packages/ai/eval/prompt-replay.mts', '--samples', path, '--provider', 'deepseek'], { encoding: 'utf8' });
    assert.equal(denied.status, 1); assert.equal(denied.stdout, ''); assert.equal(denied.stderr.includes(path), false);
    for (const args of [['--samples', path, '--versions', 'PRIVATE,v2'], ['--samples', path, '--provider', 'deepseek', '--allow-paid'], ['--samples', path, '--unknown', 'x']]) assert.throws(() => replayOptions(args));
  } finally { assert.ok(root.startsWith(join(tmpdir(), 'replay-fixture-'))); await rm(root, { recursive: true, force: true }); }
});
