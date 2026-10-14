/** Humanlike prompt (reply-candidates-3): style learning from the owner's real replies, image
 * descriptions and chat-like cleanup of the model's answer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, createDeepSeekTextProvider } from './deepseek-provider.mts';
import { describeMessageBody, describeStyle, humaniseAlternatives, ownerStyleProfile, styleExamples } from './humanlike.mts';
import type { MessageProjection, PolicyProjection, ReplyDecision, ScopedContext } from '../types.mts';

const policy: PolicyProjection = { contactId: 'c1', version: 1, goal: '保持轻松', sendMode: 'confirm',
  agentEnabled: true, activeContactEnabled: false, activeConfessionEnabled: false, restrictions: [], stylePreferences: [] };
const decision: ReplyDecision = {
  conversationId: 'v1', contextSnapshotId: 's1', shouldReply: true, timing: 'now',
  strategy: { summary: '简短回应', tone: '轻松', analysisAdjustment: null, reason: '普通闲聊' },
  riskCategories: [], requiredFacts: [], confirmationReasons: [], analysisRefs: [], skillInvocationRefs: [],
  generatorVersion: 'fake-deterministic-1', promptVersion: 'decision-1', evidenceRefs: [], uncertainty: '低',
};
let seq = 0;
function message(actor: MessageProjection['actor'], text: string | null, extra: Partial<MessageProjection> = {}): MessageProjection {
  seq += 1;
  return { id: `m${seq}`, contactId: 'c1', actor, type: 'text', text, sentAt: `2026-10-04T10:${String(seq).padStart(2, '0')}:00.000Z`,
    isAgentGenerated: false, mode: 'live', evidenceRef: `e${seq}`, ...extra };
}
function context(messages: MessageProjection[]): ScopedContext {
  return { contactId: 'c1', messages, facts: [], analyses: [],
    snapshot: { id: 's1', conversationId: 'v1', generation: 1, cutoffMessageId: null, cutoffTime: '2026-10-04T11:00:00.000Z',
      messageRefs: [], summaryRefs: [], factRefs: [], analysisRefs: [], policyVersion: 1, hash: 'h' } };
}
const chat = [
  message('contact', '在干嘛'), message('owner', '刚下班哈哈'),
  message('contact', '吃饭没'), message('owner', '还没呢 等下吃'),
  message('contact', '今天好累'), message('owner', '摸摸 早点休息哈哈'),
  message('agent', '这是助手发过的话', { isAgentGenerated: true }),
  message('contact', '周末有空吗'),
];
const enoughSamples = [...chat, ...Array.from({ length: 7 }, () => message('owner', '好呀 等下看看哈哈'))];

test('the style profile is learned only from the owner\'s own text, and needs enough of it', () => {
  const profile = ownerStyleProfile(enoughSamples)!;
  assert.equal(profile.sampleSize, 10);
  assert.equal(profile.periodEndingRate, 0);
  assert.ok(profile.habits.includes('哈哈'));
  assert.equal(ownerStyleProfile(chat.slice(0, 2)), undefined);
  assert.equal(ownerStyleProfile(chat), undefined);
});

test('examples pair the contact\'s message with the owner\'s real reply and never use agent text', () => {
  const examples = styleExamples(chat);
  assert.deepEqual(examples, ['对方：在干嘛\n本人：刚下班哈哈', '对方：吃饭没\n本人：还没呢 等下吃', '对方：今天好累\n本人：摸摸 早点休息哈哈']);
  assert.ok(!examples.join('').includes('助手发过的话'));
});

test('an image is described to the model only when a complete interpretation exists', () => {
  const described = message('contact', null, { type: 'image', mediaInterpretation: { mediaId: 'x', interpreterVersion: 'v', text: '一只橘猫趴在键盘上',
    structuredMeaning: {}, completeness: 'complete', uncertainty: '低', evidenceRefs: [], correctedByOwner: false, status: 'draft' } });
  assert.equal(describeMessageBody(described), '[图片：一只橘猫趴在键盘上]');
  assert.equal(describeMessageBody(message('contact', null, { type: 'image' })), '[image 内容未取到可靠文本]');
});

test('the humanlike prompt carries the style summary, examples, image text and a tail reminder', () => {
  const image = message('contact', null, { type: 'image', mediaInterpretation: { mediaId: 'x', interpreterVersion: 'v', text: '海边日落',
    structuredMeaning: {}, completeness: 'complete', uncertainty: '低', evidenceRefs: [], correctedByOwner: false, status: 'draft' } });
  const prompt = buildPrompt(context([...enoughSamples, image]), decision, policy, 'reply-candidates-3');
  assert.match(prompt.user, /本人的说话习惯/);
  assert.match(prompt.user, /一般不在句末加句号/);
  assert.match(prompt.user, /本人：摸摸 早点休息哈哈/);
  assert.match(prompt.user, /\[图片：海边日落\]/);
  assert.match(prompt.user, /最后提醒/);
  const baseline = buildPrompt(context([...chat, image]), decision, policy, 'reply-candidates-1');
  assert.doesNotMatch(baseline.user, /本人回复示例|最后提醒|海边日落/);
});

test('answers are split into short messages, stripped of formatting and AI talk', () => {
  const profile = ownerStyleProfile(enoughSamples);
  const cleaned = humaniseAlternatives([
    { clientAlternativeKey: 'a1', strategySummary: '接话', parts: [{ clientPartKey: 'a1-p1', sequence: 1, type: 'text', content: '**有空呀**\n- 你想干嘛。' }] },
    { clientAlternativeKey: 'a2', strategySummary: '坏', parts: [{ clientPartKey: 'a2-p1', sequence: 1, type: 'text', content: '作为一个AI，我无法…' }] },
    { clientAlternativeKey: 'a3', strategySummary: '引号', parts: [{ clientPartKey: 'a3-p1', sequence: 1, type: 'text', content: '“看情况吧。”' }] },
  ], profile);
  assert.deepEqual(cleaned, [
    { clientAlternativeKey: 'a1', strategySummary: '接话', parts: [
      { clientPartKey: 'a1-p1', sequence: 1, type: 'text', content: '有空呀' },
      { clientPartKey: 'a1-p2', sequence: 2, type: 'text', content: '你想干嘛' }] },
    { clientAlternativeKey: 'a3', strategySummary: '引号', parts: [{ clientPartKey: 'a3-p1', sequence: 1, type: 'text', content: '看情况吧' }] },
  ]);
});

test('the provider applies the cleanup end to end and fails closed when nothing usable is left', async () => {
  const answer = (content: string) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), { status: 200 });
  const options = { apiKey: 'k', modelId: 'deepseek-flash', promptVersion: 'reply-candidates-3', dataRegion: 'CN', retentionPolicy: 'x' };
  const good = createDeepSeekTextProvider({ ...options, fetchImpl: answer(JSON.stringify({ alternatives: [{ summary: 's', parts: ['好呀。\n几点'] }] })) });
  const result = await good.invoke({ context: context(chat), decision, policy, signal: new AbortController().signal });
  assert.deepEqual((result.alternatives[0] as { parts: { content: string }[] }).parts.map(p => p.content), ['好呀。', '几点']);
  const bad = createDeepSeekTextProvider({ ...options, fetchImpl: answer(JSON.stringify({ alternatives: [{ summary: 's', parts: ['我是一个AI助手'] }] })) });
  await assert.rejects(bad.invoke({ context: context(chat), decision, policy, signal: new AbortController().signal }), /MODEL_UNAVAILABLE/);
});

function alternative(contents: string[]) {
  return { clientAlternativeKey: 'a1', strategySummary: '接话', parts: contents.map((content, index) => ({
    clientPartKey: `a1-p${index + 1}`, sequence: index + 1, type: 'text' as const, content,
  })) };
}

function cleaned(contents: string[], profile = ownerStyleProfile(chat), maxParts = 3, maxChars = 200): string[] {
  const result = humaniseAlternatives([alternative(contents)], profile, maxParts, maxChars) as ReturnType<typeof alternative>[];
  return result[0]?.parts.map(part => part.content) ?? [];
}

test('overflow lines and original parts retain their final qualification, even with a one-part limit', () => {
  const clauses = ['这个可以', '我先看看', '再给你答复', '但现在还没确定，先别当作答应了'];
  const expected = ['这个可以', '我先看看', '再给你答复\n但现在还没确定，先别当作答应了'];
  assert.deepEqual(cleaned([clauses.join('\n')]), expected);
  assert.deepEqual(cleaned(clauses), expected);
  assert.deepEqual(cleaned(clauses, undefined, 1), [clauses.join('\n')]);
});

test('oversize merged replies reject the entire candidate instead of dropping a clause', () => {
  assert.deepEqual(cleaned(['先看看', '再答复', '内容很长'.repeat(30), '但还没确定'.repeat(30)]), []);
  assert.deepEqual(cleaned(['一'.repeat(201)]), []);
  assert.deepEqual(cleaned(['😀'.repeat(200)]), ['😀'.repeat(200)]);
});

test('normal AI topics and names are retained while explicit AI self-introductions are rejected', () => {
  for (const text of ['你说的那个AI助手叫什么？', '作为AI工具，它挺好用的', '我是Aidan', '他问我是不是AI助手']) {
    assert.deepEqual(cleaned([text]), [text]);
  }
  for (const text of ['我是一个AI助手', '作为一个AI，我无法回答', '我是人工智能语言模型']) {
    assert.deepEqual(cleaned([text]), []);
  }
  assert.deepEqual(cleaned(['先看看\n再答复\n等消息\n我是一个AI助手']), []);
});

test('format cleanup preserves identifiers, code, underscores and unmatched formatting', () => {
  for (const text of ['入口是 __init__，别改成 init', '`__init__`', '路径是 foo__bar', '请保留 ** 这个符号', '**没有闭合']) {
    assert.deepEqual(cleaned([text]), [text]);
  }
  assert.deepEqual(cleaned(['**好呀**\n- 可以看看']), ['好呀', '可以看看']);
});

test('sparse and mixed style evidence does not force sentence length or punctuation', () => {
  assert.equal(ownerStyleProfile(['好。', '行', '嗯'].map(text => message('owner', text))), undefined);
  const mixed = ownerStyleProfile(Array.from({ length: 10 }, (_, i) => message('owner', i < 4 ? '好。' : '行')))!;
  assert.doesNotMatch(describeStyle(mixed), /平均每条|习惯在句末加句号|一般不在句末加句号|不要加表情/);
  assert.match(describeStyle(mixed), /明确设置的表达偏好优先/);
  assert.deepEqual(cleaned(['好。'], mixed), ['好。']);
  assert.deepEqual(cleaned(['好。'], undefined), ['好。']);
  assert.deepEqual(cleaned(['好。'], ownerStyleProfile(enoughSamples)), ['好']);
});

test('provider preserves excess original parts and honours explicit preferences over inferred punctuation', async () => {
  const clauses = ['这个可以', '我先看看', '再给你答复', '但现在还没确定，先别当作答应了'];
  const makeProvider = (parts: string[]) => createDeepSeekTextProvider({
    apiKey: 'k', modelId: 'deepseek-flash', promptVersion: 'reply-candidates-3', dataRegion: 'CN', retentionPolicy: 'x',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ alternatives: [{ summary: 's', parts }] }) } }] })),
  });
  const input = { context: context(enoughSamples), decision, policy, signal: new AbortController().signal };
  const overflow = await makeProvider(clauses).invoke(input);
  assert.deepEqual((overflow.alternatives[0] as ReturnType<typeof alternative>).parts.map(p => p.content),
    ['这个可以', '我先看看', '再给你答复\n但现在还没确定，先别当作答应了']);
  const preferred = await makeProvider(['好。']).invoke({ ...input, policy: { ...policy, stylePreferences: ['保留句号'] } });
  assert.equal((preferred.alternatives[0] as ReturnType<typeof alternative>).parts[0]!.content, '好。');
  await assert.rejects(makeProvider(['一'.repeat(201)]).invoke(input), /MODEL_UNAVAILABLE/);
});
