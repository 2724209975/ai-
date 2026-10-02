/** Unit tests against a fake endpoint: prompt shape, normalisation, failures and secret hygiene. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, createDeepSeekTextProvider, normaliseAlternatives, parseModelJson } from './deepseek-provider.mts';
import { createDeepSeekFromEnv, describeDeepSeekEnv, readDeepSeekEnv } from './deepseek-env.mts';
import type { PolicyProjection, ReplyDecision, ScopedContext } from '../types.mts';

const policy: PolicyProjection = { contactId: 'c1', version: 3, goal: '保持轻松暧昧', sendMode: 'confirm',
  agentEnabled: true, activeContactEnabled: false, activeConfessionEnabled: false,
  restrictions: ['不提钱', '不约见面时间'], stylePreferences: ['简短', '别用表情'] };
const context: ScopedContext = {
  contactId: 'c1',
  snapshot: { id: 's1', conversationId: 'v1', generation: 1, cutoffMessageId: null, cutoffTime: '2026-09-26T10:00:00.000Z',
    messageRefs: [], summaryRefs: [], factRefs: [], analysisRefs: [], policyVersion: 3, hash: 'h' },
  messages: [
    { id: 'm1', contactId: 'c1', actor: 'contact', type: 'text', text: '你在干嘛呢', sentAt: '2026-09-26T10:00:00.000Z',
      isAgentGenerated: false, mode: 'live', evidenceRef: 'e1' },
    { id: 'm2', contactId: 'c1', actor: 'owner', type: 'text', text: '刚吃完饭', sentAt: '2026-09-26T09:50:00.000Z',
      isAgentGenerated: false, mode: 'live', evidenceRef: 'e2' },
  ],
  facts: [{ id: 'f1', contactId: 'c1', version: 1, subject: '本人职业', content: '后端工程师',
    confirmationStatus: 'confirmed', validFrom: '2026-09-01T00:00:00.000Z', validUntil: null, deletionStatus: 'active', evidenceRefs: [] }],
  analyses: [],
};
const decision: ReplyDecision = {
  conversationId: 'v1', contextSnapshotId: 's1', shouldReply: true, timing: 'now',
  strategy: { summary: '简短回应', tone: '轻松', analysisAdjustment: null, reason: '普通闲聊' },
  riskCategories: [], requiredFacts: [], confirmationReasons: [], analysisRefs: [], skillInvocationRefs: [],
  generatorVersion: 'fake-deterministic-1', promptVersion: 'decision-1', evidenceRefs: [], uncertainty: '低',
};

function completion(content: string, usage: Record<string, unknown> = { prompt_tokens: 120, completion_tokens: 30 }) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('the prompt carries the goal, restrictions and scoped facts, and marks speculation as such', () => {
  const prompt = buildPrompt(context, decision, policy);
  assert.match(prompt.user, /保持轻松暧昧/);
  assert.match(prompt.user, /不提钱/);
  assert.match(prompt.user, /后端工程师/);
  assert.match(prompt.user, /对方（2026-09-26T10:00:00.000Z）：你在干嘛呢/);
  assert.match(prompt.user, /本人（2026-09-26T09:50:00.000Z）：刚吃完饭/);
  assert.match(prompt.system, /只输出一个 JSON 对象/);
  assert.match(prompt.system, /不要表白/);
});

test('a well-formed answer becomes the validated alternative shape with usage recorded', async () => {
  let seen: Record<string, unknown> | undefined;
  const provider = createDeepSeekTextProvider({
    apiKey: 'unit-test-key', modelId: 'deepseek-chat', promptVersion: 'reply-candidates-1', dataRegion: 'CN', retentionPolicy: 'unverified',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body)) };
      return completion(JSON.stringify({ alternatives: [
        { summary: '简短回应', parts: ['嗯，我在呢。'] },
        { summary: '接话', parts: ['在的，你呢？', '今天忙不忙？'] },
      ] }));
    },
  });
  const result = await provider.invoke({ context, decision, policy, signal: new AbortController().signal });
  assert.equal(seen?.url, 'https://api.deepseek.com/chat/completions');
  assert.equal((seen?.headers as Record<string, string>)['authorization'], 'Bearer unit-test-key');
  assert.deepEqual((seen?.body as { response_format: unknown }).response_format, { type: 'json_object' });
  assert.equal((seen?.body as { model: string }).model, 'deepseek-chat');
  assert.deepEqual((seen?.body as { thinking: unknown }).thinking, { type: 'disabled' }, 'reply candidates default to non-thinking mode');
  assert.deepEqual(result.alternatives, [
    { clientAlternativeKey: 'a1', strategySummary: '简短回应', parts: [{ clientPartKey: 'a1-p1', sequence: 1, type: 'text', content: '嗯，我在呢。' }] },
    { clientAlternativeKey: 'a2', strategySummary: '接话', parts: [
      { clientPartKey: 'a2-p1', sequence: 1, type: 'text', content: '在的，你呢？' },
      { clientPartKey: 'a2-p2', sequence: 2, type: 'text', content: '今天忙不忙？' },
    ] },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30 });
});

test('fenced JSON, stray prose and loose part objects are still normalised', () => {
  assert.deepEqual(normaliseAlternatives(parseModelJson('```json\n{"alternatives":[{"strategySummary":"x","parts":[{"content":"喂"}]}]}\n```')),
    [{ clientAlternativeKey: 'a1', strategySummary: 'x', parts: [{ clientPartKey: 'a1-p1', sequence: 1, type: 'text', content: '喂' }] }]);
  assert.deepEqual(normaliseAlternatives(parseModelJson('好的：{"alternatives":[{"summary":"y","parts":["一","二","三","四"]}]} 以上')), [
    { clientAlternativeKey: 'a1', strategySummary: 'y', parts: [
      { clientPartKey: 'a1-p1', sequence: 1, type: 'text', content: '一' },
      { clientPartKey: 'a1-p2', sequence: 2, type: 'text', content: '二' },
      { clientPartKey: 'a1-p3', sequence: 3, type: 'text', content: '三' },
    ] },
  ]);
  assert.throws(() => parseModelJson('没有 JSON'), { message: 'MODEL_UNAVAILABLE' });
  assert.deepEqual(normaliseAlternatives({ nonsense: true }), []);
  assert.deepEqual(normaliseAlternatives({ alternatives: [{ summary: '空', parts: [] }] }), []);
});

test('HTTP failures, empty answers and unusable JSON all fail closed without leaking the key', async () => {
  const key = ['sk', 'unit', 'test', 'key'].join('-');
  const cases: ((url: string, init?: RequestInit) => Promise<Response>)[] = [
    async () => new Response('{"error":"insufficient balance"}', { status: 402 }),
    async () => completion(''),
    async () => completion('纯粹的一句话，没有 JSON'),
    async () => completion(JSON.stringify({ alternatives: [] })),
  ];
  for (const fetchImpl of cases) {
    const provider = createDeepSeekTextProvider({ apiKey: key, modelId: 'deepseek-chat', promptVersion: 'reply-candidates-1',
      dataRegion: 'CN', retentionPolicy: 'unverified', fetchImpl });
    await assert.rejects(provider.invoke({ context, decision, policy, signal: new AbortController().signal }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        assert.ok(!message.includes(key), 'the key must never appear in an error');
        return true;
      });
  }
});

test('configuration is validated and the key stays out of the describable view', () => {
  assert.throws(() => createDeepSeekTextProvider({ apiKey: 'k', modelId: 'm', promptVersion: 'arbitrary-private-label', dataRegion: 'CN', retentionPolicy: 'x' }), /PROMPT_VERSION_UNKNOWN/);
  assert.throws(() => createDeepSeekTextProvider({ apiKey: '', modelId: 'deepseek-chat', promptVersion: 'reply-candidates-1', dataRegion: 'CN', retentionPolicy: 'x' }), { message: 'MISSING_DEEPSEEK_API_KEY' });
  assert.throws(() => createDeepSeekTextProvider({ apiKey: 'k', modelId: 'deepseek-chat', promptVersion: 'reply-candidates-1', dataRegion: 'CN', retentionPolicy: 'x', baseUrl: 'http://api.deepseek.com' }), { message: 'INVALID_DEEPSEEK_BASE_URL' });
  assert.throws(() => readDeepSeekEnv({}), { message: 'MISSING_ENV:DEEPSEEK_API_KEY' });
  assert.throws(() => readDeepSeekEnv({ DEEPSEEK_API_KEY: 'k', DEEPSEEK_MAX_TOKENS: 'lots' }), { message: 'INVALID_ENV:DEEPSEEK_MAX_TOKENS' });

  const env = readDeepSeekEnv({ DEEPSEEK_API_KEY: 'k' });
  assert.equal(env.modelId, 'deepseek-flash', 'the current API model name, not the legacy chat alias');
  assert.equal(env.thinking, 'disabled');
  assert.equal(env.maxTokens, 2_000);
  assert.equal(env.dataRegion, 'CN');
  assert.equal(env.retentionPolicy, 'provider-default-unverified');
  assert.equal(JSON.stringify(describeDeepSeekEnv(env)).includes('"k"'), false);
  assert.equal(createDeepSeekFromEnv({ DEEPSEEK_API_KEY: 'k' }).modelId, 'deepseek-flash');
  assert.equal(readDeepSeekEnv({ DEEPSEEK_API_KEY: 'k', DEEPSEEK_THINKING: 'ENABLED' }).thinking, 'enabled');
  assert.throws(() => readDeepSeekEnv({ DEEPSEEK_API_KEY: 'k', DEEPSEEK_THINKING: 'maybe' }), { message: 'INVALID_ENV:DEEPSEEK_THINKING' });
  // Hand-edited files: quotes and a pasted variable name are normalised away.
  assert.equal(readDeepSeekEnv({ DEEPSEEK_API_KEY: '  "sk-abc"  ' }).apiKey, 'sk-abc');
  assert.equal(readDeepSeekEnv({ DEEPSEEK_API_KEY: 'DEEPSEEK_API_KEY=sk-abc' }).apiKey, 'sk-abc');
  assert.equal(readDeepSeekEnv({ DEEPSEEK_API_KEY: '"DEEPSEEK_API_KEY=sk-abc"' }).apiKey, 'sk-abc');
});

test('thinking mode can be turned back on, and the request says so explicitly either way', async () => {
  const bodies: Record<string, unknown>[] = [];
  for (const thinking of ['disabled', 'enabled'] as const) {
    const provider = createDeepSeekTextProvider({ apiKey: 'k', modelId: 'deepseek-v4-pro', promptVersion: 'reply-candidates-1',
      dataRegion: 'CN', retentionPolicy: 'x', thinking,
      fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return completion(JSON.stringify({ alternatives: [{ summary: 's', parts: ['ok'] }] })); } });
    await provider.invoke({ context, decision, policy, signal: new AbortController().signal });
  }
  assert.deepEqual(bodies.map(body => body['thinking']), [{ type: 'disabled' }, { type: 'enabled' }]);
  assert.deepEqual(bodies.map(body => body['model']), ['deepseek-v4-pro', 'deepseek-v4-pro']);
});

test('a slow endpoint aborts on our own timeout rather than hanging the contact', async () => {
  const provider = createDeepSeekTextProvider({ apiKey: 'k', modelId: 'deepseek-chat', promptVersion: 'reply-candidates-1',
    dataRegion: 'CN', retentionPolicy: 'x', timeoutMs: 1_000,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    }) });
  await assert.rejects(provider.invoke({ context, decision, policy, signal: new AbortController().signal }));
});
