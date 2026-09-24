import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptDataContextProjection, createFakeIntelligencePort, createTextCandidateGateway, FakeCandidateGateway, interpretWithFallback, interpretWithGateway, prepareReplyForOrchestration, proposeWithGateway } from './index.mts';
import type { TextModelMeasurement, TextModelProvider } from './generation/text-provider-contract.mts';
import { MemoryDataContextStore } from '../data/context/store.mts';
import type { CandidateGateway } from './generation/fake-provider.mts';
import type { MediaGateway } from './understanding/media-gateway.mts';
import type { PolicyProjection, ScopedContext } from './types.mts';

function fixture(text = '你好，今天怎么样？'): { context: ScopedContext; policy: PolicyProjection } {
  const context: ScopedContext = {
    contactId: 'contact-a',
    snapshot: { id: 'snapshot-1', conversationId: 'conv-a', generation: 1, cutoffMessageId: 'm1', cutoffTime: '2026-09-23T12:00:00.000Z', messageRefs: ['m1'], summaryRefs: [], factRefs: [], analysisRefs: [], policyVersion: 1, hash: 'hash-1' },
    messages: [{ id: 'm1', contactId: 'contact-a', actor: 'contact', type: 'text', text, sentAt: '2026-09-23T11:59:00.000Z', isAgentGenerated: false, mode: 'live', evidenceRef: 'message:m1' }],
    facts: [], analyses: [],
  };
  const policy: PolicyProjection = { contactId: 'contact-a', version: 1, goal: '轻松交流', sendMode: 'confirm', agentEnabled: true, activeContactEnabled: false, activeConfessionEnabled: false, restrictions: [], stylePreferences: ['简短'] };
  return { context, policy };
}

test('mock G1: decision -> 3 candidates including a two-part alternative -> advisory check', async () => {
  const { context, policy } = fixture();
  const port = createFakeIntelligencePort();
  const decision = port.makeDecision({ context, policy });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.value.shouldReply, true);
  assert.deepEqual(decision.value.confirmationReasons, ['CONTACT_CONFIRM_MODE']);
  const proposal = await port.proposeReply({ context, policy, decision: decision.value });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  assert.equal(proposal.value.alternatives.length, 3);
  assert.equal(proposal.value.alternatives[1]?.parts.length, 2);
  assert.equal('status' in proposal.value, false);
  assert.equal('planId' in proposal.value, false);
  const check = port.checkReply({ context, policy, decision: decision.value, parts: proposal.value.alternatives[0]!.parts });
  assert.equal(check.ok, true);
  if (check.ok) assert.deepEqual([check.value.status, check.value.authorization], ['passed', 'not_evaluated']);
});

test('04 handoff retains source refs, uncertainty and prompt version without granting dispatch', async () => {
  const { context, policy } = fixture();
  const result = await prepareReplyForOrchestration(createFakeIntelligencePort(), context, policy);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.authorization, 'not_evaluated');
  assert.equal(result.value.decision.contextSnapshotId, context.snapshot.id);
  assert.deepEqual(result.value.decision.evidenceRefs, ['message:m1']);
  assert.ok(result.value.decision.uncertainty);
  assert.equal(result.value.proposal?.promptVersion, 'fixture-1');
  assert.deepEqual(result.value.proposal?.evidenceRefs, ['message:m1']);
  assert.ok(result.value.proposal?.uncertainty);
  assert.ok(result.value.checks.every(check =>
    check.authorization === 'not_evaluated' && check.evidenceRefs.includes('message:m1')));
});

test('missing personal schedule stays missing and yields no candidate', async () => {
  const { context, policy } = fixture('你明天几点有空？');
  const port = createFakeIntelligencePort();
  const decision = port.makeDecision({ context, policy });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.value.shouldReply, false);
  assert.deepEqual(decision.value.requiredFacts, ['current_personal_status_or_schedule']);
  const proposal = await port.proposeReply({ context, policy, decision: decision.value });
  assert.equal(proposal.ok, false);
  if (!proposal.ok) assert.equal(proposal.error.code, 'MISSING_FACT');
});

test('unrelated confirmed fact does not satisfy a current schedule question', () => {
  const { context, policy } = fixture('你明天几点有空？');
  context.snapshot.factRefs.push({ id: 'f1', version: 1 });
  context.facts.push({ id: 'f1', contactId: null, version: 1, subject: 'favorite_food', content: '喜欢饺子', confirmationStatus: 'confirmed', validFrom: '2026-01-01T00:00:00.000Z', validUntil: null, deletionStatus: 'active', evidenceRefs: ['owner:f1'] });
  const decision = createFakeIntelligencePort().makeDecision({ context, policy });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.deepEqual(decision.value.requiredFacts, ['current_personal_status_or_schedule']);
});

test('stop request is surfaced and no proposal is generated', async () => {
  const { context, policy } = fixture('请不要再联系我');
  policy.sendMode = 'auto';
  const port = createFakeIntelligencePort();
  const decision = port.makeDecision({ context, policy });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.shouldReply, false);
    assert.ok(decision.value.riskCategories.includes('STOP_REQUEST'));
  }
});

test('meeting commitment and relationship claim demand review even in auto mode', () => {
  const { context, policy } = fixture('周六几点见面？');
  policy.sendMode = 'auto';
  const port = createFakeIntelligencePort();
  const decision = port.makeDecision({ context, policy });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.ok(decision.value.confirmationReasons.includes('CONCRETE_MEETING'));
  const check = port.checkReply({ context, policy, decision: decision.value, parts: [{ clientPartKey: 'edited', sequence: 1, type: 'text', content: '我们已经在一起了，周六两点见。' }] });
  assert.equal(check.ok, true);
  if (check.ok) {
    assert.equal(check.value.status, 'review_required');
    assert.ok(check.value.confirmationReasons.includes('RELATIONSHIP_COMMITMENT'));
    assert.equal(check.value.authorization, 'not_evaluated');
  }
});

test('scope and time cutoff reject cross-contact and future evidence', () => {
  const { context, policy } = fixture();
  const port = createFakeIntelligencePort();
  context.messages[0]!.contactId = 'contact-b';
  assert.equal(port.makeDecision({ context, policy }).ok, false);
  context.messages[0]!.contactId = 'contact-a';
  context.messages[0]!.sentAt = '2026-09-24T12:00:00.000Z';
  assert.equal(port.makeDecision({ context, policy }).ok, false);
  context.messages[0]!.sentAt = '2026-09-23T11:59:00.000Z';
  context.snapshot.messageRefs.push('missing-ref');
  assert.equal(port.makeDecision({ context, policy }).ok, false);
});

test('draft analysis excludes agent-generated speech as relationship evidence', () => {
  const { context, policy } = fixture();
  context.snapshot.messageRefs.push('m2');
  context.messages.push({ id: 'm2', contactId: 'contact-a', actor: 'agent', type: 'text', text: '我喜欢你', sentAt: '2026-09-23T11:59:30.000Z', isAgentGenerated: true, mode: 'live', evidenceRef: 'message:m2' });
  const analysis = createFakeIntelligencePort().analyzeContact({ context, policy });
  assert.equal(analysis.ok, true);
  if (analysis.ok) {
    assert.equal(analysis.value.status, 'insufficient_evidence');
    assert.deepEqual(analysis.value.stageHypotheses, []);
    assert.deepEqual(analysis.value.dependencySet, ['m1']);
  }
});

test('valid analysis hint is cited but does not mutate policy', () => {
  const { context, policy } = fixture();
  context.snapshot.analysisRefs.push({ id: 'analysis-1', version: 2 });
  context.analyses.push({ id: 'analysis-1', contactId: 'contact-a', version: 2, cutoff: context.snapshot.cutoffTime, status: 'valid', taxonomyVersion: 'draft-1', observation: '对方更偏好简短问答', strategyHint: '减少连续追问', evidenceRefs: ['message:m1'], counterEvidenceRefs: [], alternativeExplanations: ['也可能只是当时很忙'], uncertainty: '有限证据' });
  const before = structuredClone(policy);
  const decision = createFakeIntelligencePort().makeDecision({ context, policy });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.strategy.analysisAdjustment, '减少连续追问');
    assert.deepEqual(decision.value.analysisRefs, [{ id: 'analysis-1', version: 2 }]);
  }
  assert.deepEqual(policy, before);
});

test('analysis hint with out of snapshot evidence is ignored', () => {
  const { context, policy } = fixture();
  context.snapshot.analysisRefs.push({ id: 'a-future', version: 1 });
  context.analyses.push({ id: 'a-future', contactId: 'contact-a', version: 1, status: 'valid', taxonomyVersion: 'draft-1', observation: '推测', strategyHint: '不应采用', evidenceRefs: ['message:future'], counterEvidenceRefs: [], alternativeExplanations: ['其他解释'], uncertainty: '有限' });
  const result = createFakeIntelligencePort().makeDecision({ context, policy });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.strategy.analysisAdjustment, null);
});

test('media without complete verified meaning fails closed', () => {
  const port = createFakeIntelligencePort();
  const unsupported = port.interpretMedia({ mediaId: 'x', mediaType: 'sticker_animated', sourceRef: 'private:x' });
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.error.code, 'UNSUPPORTED_CAPABILITY');
  const partial = port.interpretMedia({ mediaId: 'x', mediaType: 'voice', sourceRef: 'private:x', verifiedInterpretation: { text: '听不清', completeness: 'partial', evidenceRefs: ['media:x'] } });
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.equal(partial.error.code, 'MEDIA_UNCERTAIN');
});

test('provider malformed, unavailable and timeout produce no sendable plan', async () => {
  const { context, policy } = fixture();
  const decision = createFakeIntelligencePort().makeDecision({ context, policy });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const gateways: CandidateGateway[] = [
    { version: 'bad-1', promptVersion: 'test-1', generate: async () => [{ clientAlternativeKey: 'x', strategySummary: 'bad', parts: [] }] },
    { version: 'error-1', promptVersion: 'test-1', generate: async () => { throw new Error('RATE_LIMIT'); } },
  ];
  for (const gateway of gateways) {
    const port = createFakeIntelligencePort(gateway);
    const result = await port.proposeReply({ context, policy, decision: decision.value });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'MODEL_UNAVAILABLE');
  }
  const slow: CandidateGateway = { version: 'slow-1', promptVersion: 'test-1', generate: async () => new Promise(() => {}) };
  const timed = await proposeWithGateway(context, decision.value, slow, 20);
  assert.equal(timed.ok, false);
  if (!timed.ok) assert.equal(timed.error.code, 'MODEL_UNAVAILABLE');
  const recovered = await createFakeIntelligencePort(gateways[1], new FakeCandidateGateway()).proposeReply({ context, policy, decision: decision.value });
  assert.equal(recovered.ok, true);
  if (recovered.ok) assert.equal(recovered.value.generatorVersion, 'fake-deterministic-1');
  const good = await createFakeIntelligencePort(new FakeCandidateGateway()).proposeReply({ context, policy, decision: decision.value });
  assert.equal(good.ok, true);
});

test('provider candidate with unsupported personal claim is rejected before proposal', async () => {
  const { context, policy } = fixture();
  const decision = createFakeIntelligencePort().makeDecision({ context, policy });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const unsafe: CandidateGateway = { version: 'unsafe-1', promptVersion: 'test-1', generate: async () => [{ clientAlternativeKey: 'a', strategySummary: 'unsafe', parts: [{ clientPartKey: 'p', sequence: 1, type: 'text', content: '我明天有空，我们两点见。' }] }] };
  const result = await createFakeIntelligencePort(unsafe).proposeReply({ context, policy, decision: decision.value });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MISSING_FACT');
});

test('pending batch checks every message and never treats unsupported as text', () => {
  const { context, policy } = fixture('先说一句');
  context.snapshot.messageRefs.push('m2');
  context.messages.push({ ...context.messages[0]!, id: 'm2', type: 'unsupported', text: null, evidenceRef: 'message:m2', sentAt: '2026-09-23T11:59:30.000Z' });
  const result = createFakeIntelligencePort().makeDecision({ context, policy });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'UNSUPPORTED_CAPABILITY', JSON.stringify(result.error));
});

test('all media types require complete, type appropriate coverage and cite interpretations', () => {
  const port = createFakeIntelligencePort();
  for (const mediaType of ['image', 'voice', 'sticker_static', 'sticker_animated'] as const) {
    const { context, policy } = fixture();
    const message = context.messages[0]!;
    message.type = mediaType; message.text = null; message.mediaId = 'media-1';
    const partial = port.interpretMedia({ mediaId: 'media-1', mediaType, sourceRef: 'private:media-1', verifiedInterpretation: {
      text: '识别到了局部', completeness: 'complete', evidenceRefs: ['media:e1'],
      visualCoverage: mediaType === 'sticker_animated' ? 'single_frame' : undefined,
      transcriptCoverage: mediaType === 'voice' ? 'partial' : undefined,
    } });
    assert.equal(partial.ok, false, mediaType);
    if (!partial.ok) assert.equal(partial.error.code, 'MEDIA_UNCERTAIN');
    const good = port.interpretMedia({ mediaId: 'media-1', mediaType, sourceRef: 'private:media-1', verifiedInterpretation: {
      text: '对方说你好', completeness: 'complete', evidenceRefs: ['media:e1'],
      visualCoverage: mediaType === 'sticker_animated' ? 'temporal_sequence' : 'full_image',
      transcriptCoverage: 'complete',
    } });
    assert.equal(good.ok, true, mediaType);
    if (!good.ok) continue;
    message.mediaInterpretation = good.value;
    const decision = port.makeDecision({ context, policy });
    assert.equal(decision.ok, true, mediaType);
    if (decision.ok) assert.ok(decision.value.evidenceRefs.includes('media:e1'));
  }
});

test('earlier unresolved media in pending batch blocks a later readable text', () => {
  const { context, policy } = fixture();
  context.messages[0]!.type = 'image'; context.messages[0]!.text = null; context.messages[0]!.mediaId = 'media-1';
  context.snapshot.messageRefs.push('m2');
  context.messages.push({ ...context.messages[0]!, id: 'm2', type: 'text', text: '你怎么看？', mediaId: undefined, evidenceRef: 'message:m2', sentAt: '2026-09-23T11:59:30.000Z' });
  const result = createFakeIntelligencePort().makeDecision({ context, policy });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.error.details, ['m1']);
});

test('03 scoped projection adapter retains cutoff and unsupported type', () => {
  const store = new MemoryDataContextStore(() => Date.parse('2026-09-23T12:00:00.000Z'));
  store.createContact({ id: 'contact-a', conversationId: 'conv-a', platformAccountId: 'account-a', externalContactRef: 'external-a', displayName: 'A', enrollmentStatus: 'enrolled' });
  const append = (id: string, type: 'text' | 'unsupported', time: string) => store.appendObservedMessage({
    contactId: 'contact-a', conversationId: 'conv-a', platformAccountId: 'account-a', platformMessageId: id,
    platformEventId: id, actor: 'contact', type, contentRef: type === 'text' ? '你好' : undefined,
    sentAt: time, receivedAt: time, provenance: 'fixture', isAgentGenerated: false, mode: 'live',
  });
  append('earlier', 'unsupported', '2026-09-23T11:58:00.000Z');
  append('future', 'text', '2026-09-23T12:01:00.000Z');
  const projection = store.buildContext({ callerContactId: 'contact-a', contactId: 'contact-a', cutoffTime: '2026-09-23T12:00:00.000Z', generation: 1, allowedScopes: [], policyVersion: 1 });
  const context = adaptDataContextProjection(projection);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0]!.type, 'unsupported');
  const policy = fixture().policy;
  const result = createFakeIntelligencePort().makeDecision({ context, policy });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'UNSUPPORTED_CAPABILITY', JSON.stringify(result.error));
});

test('03 PostgreSQL shaped projection is adapted without losing refs or source', () => {
  const projection = {
    snapshot: { id: 'snapshot-pg', contactId: 'contact-a', conversationId: 'conv-a', generation: 2, cutoffMessageId: 'm1', cutoffTime: '2026-09-23T12:00:00.000Z', messageRefs: [{ id: 'm1', version: 3 }], summaryRefs: [], factRefs: [], analysisRefs: [], policyVersion: 1, hash: 'hash-pg' },
    messages: [{ id: 'm1', contactId: 'contact-a', actor: 'contact', type: 'text', contentRef: '你好', sentAt: '2026-09-23T11:59:00.000Z', isAgentGenerated: false, mode: 'live', platformAccountId: 'account-a', platformMessageId: 'platform-m1', mediaId: null }],
    facts: [], analyses: [], dependencyEpoch: 4,
  };
  const context = adaptDataContextProjection(projection);
  assert.deepEqual(context.snapshot.messageRefs, ['m1']);
  assert.equal(context.messages[0]!.evidenceRef, 'account-a:platform-m1');
  assert.equal(context.messages[0]!.text, '你好');
  const decision = createFakeIntelligencePort().makeDecision({ context, policy: fixture().policy });
  assert.equal(decision.ok, true);
});

test('draft claims carry support, counter evidence, alternatives and uncertainty', () => {
  const { context, policy } = fixture('短句');
  for (const [id, value, at] of [['m2', '也短', '11:59:10'], ['m3', '这是一条明显更长的补充说明', '11:59:20']] as const) {
    context.snapshot.messageRefs.push(id);
    context.messages.push({ ...context.messages[0]!, id, text: value, evidenceRef: `message:${id}`, sentAt: `2026-09-23T${at}.000Z` });
  }
  const result = createFakeIntelligencePort().analyzeContact({ context, policy });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const inference = result.value.claims.find(c => c.text.includes('简短表达'));
  assert.ok(inference);
  assert.equal(inference?.kind, 'inference');
  assert.deepEqual(inference?.supportingEvidence, ['message:m1', 'message:m2']);
  assert.deepEqual(inference?.counterEvidence, ['message:m3']);
  assert.ok(inference?.alternativeExplanations.length);
  assert.ok(inference?.uncertainty);
  assert.deepEqual(result.value.stageHypotheses, []);
});

test('02 handoff keeps no-reply and all checked alternatives separate from authorization', async () => {
  const port = createFakeIntelligencePort();
  const normal = fixture();
  const prepared = await prepareReplyForOrchestration(port, normal.context, normal.policy);
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal(prepared.value.authorization, 'not_evaluated');
    assert.equal(prepared.value.proposal?.alternatives.length, prepared.value.checks.length);
  }
  const stop = fixture('不要再联系我');
  const withheld = await prepareReplyForOrchestration(port, stop.context, stop.policy);
  assert.equal(withheld.ok, true);
  if (withheld.ok) {
    assert.equal(withheld.value.proposal, null);
    assert.equal(withheld.value.decision.shouldReply, false);
  }
});

test('proposal triggers only the current contact batch after the last owner reply', async () => {
  const { context, policy } = fixture('旧话题');
  context.snapshot.messageRefs.push('owner-1', 'm2');
  context.messages.push({ ...context.messages[0]!, id: 'owner-1', actor: 'owner', isAgentGenerated: false, text: '知道了', evidenceRef: 'message:owner-1', sentAt: '2026-09-23T11:59:10.000Z' });
  context.messages.push({ ...context.messages[0]!, id: 'm2', text: '新话题', evidenceRef: 'message:m2', sentAt: '2026-09-23T11:59:20.000Z' });
  const result = await prepareReplyForOrchestration(createFakeIntelligencePort(), context, policy);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.proposal?.triggerMessageIds, ['m2']);
});

test('expired and unrelated facts cannot support a personal schedule claim', async () => {
  const { context, policy } = fixture('你明天有空吗？');
  const fact = { id: 'f1', contactId: null, version: 1, subject: 'favorite_food', content: '我明天有空', confirmationStatus: 'confirmed' as const, validFrom: '2026-01-01T00:00:00.000Z', validUntil: null, deletionStatus: 'active' as const, evidenceRefs: ['owner:f1'] };
  context.snapshot.factRefs.push({ id: fact.id, version: fact.version });
  context.facts.push(fact);
  const port = createFakeIntelligencePort();
  const decision = port.makeDecision({ context, policy });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.deepEqual(decision.value.requiredFacts, ['current_personal_status_or_schedule']);
  context.facts[0]!.validUntil = '2026-09-23T12:00:00.000Z';
  assert.equal(port.makeDecision({ context, policy }).ok, false);
});

test('agent-authored evidence cannot activate an analysis strategy hint', () => {
  const { context, policy } = fixture();
  context.snapshot.messageRefs.push('agent-1');
  context.messages.push({ ...context.messages[0]!, id: 'agent-1', actor: 'agent', isAgentGenerated: true, text: '我喜欢你', evidenceRef: 'message:agent-1', sentAt: '2026-09-23T11:58:00.000Z' });
  context.snapshot.analysisRefs.push({ id: 'analysis-agent', version: 1 });
  context.analyses.push({ id: 'analysis-agent', contactId: 'contact-a', version: 1, status: 'valid', taxonomyVersion: 'draft-1', observation: 'AI 发言', strategyHint: '错误提示', evidenceRefs: ['message:agent-1'], counterEvidenceRefs: [], alternativeExplanations: ['其他解释'], uncertainty: '不确定' });
  const result = createFakeIntelligencePort().makeDecision({ context, policy });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.strategy.analysisAdjustment, null);
});

test('media gateway rejects malformed, partial and unsupported outputs without a usable draft', async () => {
  const input = { mediaId: 'media-1', mediaType: 'sticker_animated' as const, sourceRef: 'private:media-1' };
  const gateway: MediaGateway = { version: 'test-media-1', promptVersion: 'prompt-1', supportedTypes: ['sticker_animated'], interpret: async () => ({ text: '只见单帧', completeness: 'complete', evidenceRefs: ['frame:1'], uncertainty: '仅单帧', visualCoverage: 'single_frame' }) };
  const partial = await interpretWithGateway(input, gateway);
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.equal(partial.error.code, 'MEDIA_UNCERTAIN');
  const unsupported = await interpretWithGateway({ ...input, mediaType: 'voice' }, gateway);
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.error.code, 'UNSUPPORTED_CAPABILITY');
  const malformed = await interpretWithGateway(input, { ...gateway, interpret: async () => ({ text: 'missing evidence' }) });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, 'MODEL_UNAVAILABLE');
});

test('media gateway timeout aborts and explicit fallback records actual interpreter', async () => {
  const input = { mediaId: 'media-1', mediaType: 'voice' as const, sourceRef: 'private:media-1' };
  let aborted = false;
  const slow: MediaGateway = { version: 'slow-1', promptVersion: 'prompt-1', supportedTypes: ['voice'], interpret: async ({ signal }) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } };
  const timed = await interpretWithGateway(input, slow, 10);
  assert.equal(timed.ok, false);
  if (!timed.ok) assert.equal(timed.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(aborted, true);
  const fallback: MediaGateway = { version: 'fallback-media-1', promptVersion: 'prompt-2', supportedTypes: ['voice'], interpret: async () => ({
    text: '你好', completeness: 'complete', evidenceRefs: ['transcript:1'], uncertainty: '已完整转写的测试夹具', transcriptCoverage: 'complete',
  }) };
  const result = await interpretWithFallback(input, slow, fallback, 10);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.interpreterVersion, 'fallback-media-1');
    assert.equal(result.value.structuredMeaning.promptVersion, 'prompt-2');
  }
});

test('candidate gateway records its own model and prompt versions', async () => {
  const { context, policy } = fixture();
  const gateway: CandidateGateway = { version: 'candidate-test-2', promptVersion: 'prompt-test-3', generate: async () => [
    { clientAlternativeKey: 'a', strategySummary: '简短', parts: [{ clientPartKey: 'p', sequence: 1, type: 'text', content: '你好' }] },
  ] };
  const result = await prepareReplyForOrchestration(createFakeIntelligencePort(gateway), context, policy);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual([result.value.proposal?.generatorVersion, result.value.proposal?.promptVersion], ['candidate-test-2', 'prompt-test-3']);
});

test('replaceable text provider records version and usage without storing message content', async () => {
  const measurements: TextModelMeasurement[] = [];
  const provider: TextModelProvider = {
    providerId: 'stub', modelId: 'text-stub', modelVersion: '1', promptVersion: 'prompt-2',
    dataRegion: 'fixture-only', retentionPolicy: 'none',
    async invoke({ signal }) {
      assert.equal(signal.aborted, false);
      return { alternatives: [{ clientAlternativeKey: 'a', strategySummary: '简短', parts: [{ clientPartKey: 'p', sequence: 1, type: 'text', content: '你好' }] }], usage: { inputTokens: 12, outputTokens: 2 } };
    },
  };
  const { context, policy } = fixture();
  const port = createFakeIntelligencePort(createTextCandidateGateway(provider, m => measurements.push(m)));
  const result = await prepareReplyForOrchestration(port, context, policy);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual([result.value.proposal?.generatorVersion, result.value.proposal?.promptVersion], ['stub/text-stub@1', 'prompt-2']);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0]?.outcome, 'ok');
  assert.deepEqual([measurements[0]?.inputTokens, measurements[0]?.outputTokens], [12, 2]);
  assert.equal(JSON.stringify(measurements).includes('你好'), false);
});

test('provider failure records only an error outcome and yields no candidate', async () => {
  const measurements: TextModelMeasurement[] = [];
  const provider: TextModelProvider = {
    providerId: 'stub', modelId: 'text-stub', modelVersion: '1', promptVersion: 'prompt-2',
    dataRegion: 'fixture-only', retentionPolicy: 'none',
    async invoke() { throw new Error('private message text must not enter telemetry'); },
  };
  const { context, policy } = fixture();
  const result = await prepareReplyForOrchestration(createFakeIntelligencePort(
    createTextCandidateGateway(provider, m => measurements.push(m))), context, policy);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0]?.outcome, 'error');
  assert.equal(measurements[0]?.inputTokens, null);
  assert.equal(JSON.stringify(measurements).includes('private message'), false);
});
