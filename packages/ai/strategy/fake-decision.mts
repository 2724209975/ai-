import type { MessageProjection, PolicyProjection, ReplyDecision, Result, RiskCategory, ScopedContext } from '../types.mts';

export const FAKE_MODEL_VERSION = 'fake-deterministic-1';
export const FAKE_PROMPT_VERSION = 'fixture-1';

const patterns: readonly [RiskCategory, RegExp][] = [
  ['STOP_REQUEST', /别(再)?联系|不要(再)?联系|别(再)?发(消息|信息)|停止联系|拉黑你/u],
  ['REJECTION', /不喜欢你|拒绝(你|表白|追求)|不想(谈恋爱|在一起)|别追我/u],
  ['RELATIONSHIP_COMMITMENT', /我们(已经|算|是)?在一起|做[男女]朋友|答应(交往|在一起)|分手|复合|结婚/u],
  ['CONCRETE_MEETING', /([明后]天|周[一二三四五六日天]|\d{1,2}[点时]|几点|哪里|地点).{0,16}(见面|约会|见)|见面.{0,16}([明后]天|周[一二三四五六日天]|\d{1,2}[点时]|几点|哪里|地点)/u],
  ['MONEY_OR_LEGAL', /转账|借钱|赔偿|合同|签约|法律责任|工作承诺/u],
  ['SENSITIVE_DATA', /密码|验证码|身份证号|家庭住址|银行卡|急救|自杀/u],
  ['CONFESSION', /表白|我爱你|我喜欢你/u],
];

function fail(message: string, details: string[] = []): Result<never> {
  return { ok: false, error: { code: 'VALIDATION_FAILED', message, retryable: false, details } };
}

export function validateScopedContext(context: ScopedContext, policy: PolicyProjection): Result<true> {
  if (!context || !policy || !context.snapshot || !context.contactId || context.contactId !== policy.contactId) return fail('联系人上下文与策略不匹配');
  const snapshot = context.snapshot;
  if (!snapshot.id || !snapshot.conversationId || !snapshot.hash || !Number.isInteger(snapshot.generation) || snapshot.generation < 0 || snapshot.policyVersion !== policy.version) return fail('上下文快照或策略版本无效');
  const cutoff = Date.parse(snapshot.cutoffTime);
  if (!Number.isFinite(cutoff)) return fail('截止时间无效');
  const refs = new Set(snapshot.messageRefs);
  if (!Array.isArray(context.messages) || !Array.isArray(context.facts) || !Array.isArray(context.analyses)) return fail('上下文投影不完整');
  if (context.messages.length !== refs.size || new Set(context.messages.map(m => m.id)).size !== refs.size || context.messages.some(m => m.contactId !== context.contactId || !refs.has(m.id) || !m.evidenceRef || !Number.isFinite(Date.parse(m.sentAt)) || Date.parse(m.sentAt) > cutoff || m.isAgentGenerated !== (m.actor === 'agent') || (m.type === 'text' && !m.text?.trim()) || (m.mediaInterpretation && (m.mediaInterpretation.mediaId !== m.mediaId || m.mediaInterpretation.status !== 'draft')))) return fail('消息超出联系人或时间截断范围，或正文投影不完整');
  if (context.facts.some(f => (f.contactId !== null && f.contactId !== context.contactId) || !Number.isFinite(Date.parse(f.validFrom)) || Date.parse(f.validFrom) > cutoff || f.confirmationStatus !== 'confirmed' || f.deletionStatus !== 'active' || !f.content.trim() || (f.validUntil !== null && (!Number.isFinite(Date.parse(f.validUntil)) || Date.parse(f.validUntil) <= cutoff)))) return fail('事实超出联系人、时间或有效授权范围');
  if (context.analyses.some(a => a.contactId !== context.contactId || (a.cutoff !== undefined && (!Number.isFinite(Date.parse(a.cutoff)) || Date.parse(a.cutoff) > cutoff)))) return fail('分析超出联系人或时间截断范围');
  const factVersions = new Map(snapshot.factRefs.map(ref => [ref.id, ref.version]));
  if (context.facts.length !== factVersions.size || context.facts.some(f => factVersions.get(f.id) !== f.version)) return fail('事实投影与快照引用不一致');
  const analysisVersions = new Map(snapshot.analysisRefs.map(ref => [ref.id, ref.version]));
  if (context.analyses.length !== analysisVersions.size || context.analyses.some(a => analysisVersions.get(a.id) !== a.version)) return fail('分析投影与快照引用不一致');
  return { ok: true, value: true };
}

export function classifyRisks(text: string): RiskCategory[] {
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
}

/** The current reply batch starts after the latest owner/agent message. */
export function pendingContactBatch(context: ScopedContext): MessageProjection[] {
  const ordered = [...context.messages].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || context.snapshot.messageRefs.indexOf(a.id) - context.snapshot.messageRefs.indexOf(b.id));
  const previousReply = ordered.findLastIndex(m => m.actor === 'owner' || m.actor === 'agent');
  return ordered.slice(previousReply + 1).filter(m => m.actor === 'contact' || m.actor === 'unknown' || m.type === 'unsupported');
}

export function makeFakeDecision(context: ScopedContext, policy: PolicyProjection): Result<ReplyDecision> {
  const valid = validateScopedContext(context, policy);
  if (!valid.ok) return valid;
  const pending = pendingContactBatch(context);
  if (!pending.some(m => m.actor === 'contact')) return fail('当前截止点没有待回应的对方消息');
  if (pending.some(m => m.actor === 'unknown')) return { ok: false, error: { code: 'MEDIA_UNCERTAIN', message: '消息来源未核实，需人工处理', retryable: false, details: pending.filter(m => m.actor === 'unknown').map(m => m.id) } };
  if (pending.some(m => m.type === 'unsupported')) return { ok: false, error: { code: 'UNSUPPORTED_CAPABILITY', message: '关键消息类型不支持，需人工处理', retryable: false, details: pending.filter(m => m.type === 'unsupported').map(m => m.id) } };
  const unresolved = pending.filter(m => m.type !== 'text' && (!m.mediaInterpretation || m.mediaInterpretation.completeness !== 'complete' || !m.mediaInterpretation.text.trim() || !m.mediaInterpretation.evidenceRefs.length || m.mediaInterpretation.structuredMeaning.mediaType !== m.type ||
    (m.type === 'voice' && m.mediaInterpretation.structuredMeaning.transcriptCoverage !== 'complete') ||
    (m.type === 'sticker_animated' && m.mediaInterpretation.structuredMeaning.visualCoverage !== 'temporal_sequence') ||
    ((m.type === 'image' || m.type === 'sticker_static') && m.mediaInterpretation.structuredMeaning.visualCoverage !== 'full_image')));
  if (unresolved.length) return { ok: false, error: { code: 'MEDIA_UNCERTAIN', message: '关键媒体内容尚未可靠理解，需人工处理', retryable: false, details: unresolved.map(m => m.id) } };
  const pendingText = pending.map(m => m.type === 'text' ? m.text! : m.mediaInterpretation!.text).join('\n');
  const riskCategories = classifyRisks(pendingText);
  const asksCurrentPersonalFact = /你(现在|今天|明天|后天).{0,12}(在哪|干嘛|有空|几点|什么时候|安排)|你(的)?(地址|电话|密码|验证码)/u.test(pendingText);
  const usableFacts = context.facts;
  const requiredFacts = asksCurrentPersonalFact && !usableFacts.some(f => f.subject === 'current_personal_status_or_schedule') ? ['current_personal_status_or_schedule'] : [];
  if (requiredFacts.length) riskCategories.push('MISSING_FACT');
  const visibleEvidence = new Set([...context.messages.filter(m => (m.actor === 'contact' || m.actor === 'owner') && !m.isAgentGenerated && m.mode !== 'trial' && m.mode !== 'replay').flatMap(m => [m.id, m.evidenceRef, ...(m.mediaInterpretation?.evidenceRefs ?? [])]), ...context.facts.flatMap(f => [f.id, ...f.evidenceRefs])]);
  const validAnalysis = context.analyses.find(a => a.status === 'valid' && a.evidenceRefs.length > 0 && !!a.uncertainty && !!a.counterEvidenceRefs && !!a.alternativeExplanations?.length &&
    [...a.evidenceRefs, ...a.counterEvidenceRefs].every(ref => visibleEvidence.has(ref)));
  const shouldReply = policy.agentEnabled && !riskCategories.includes('STOP_REQUEST') && !riskCategories.includes('REJECTION') && requiredFacts.length === 0;
  const confirmationReasons: string[] = [];
  if (policy.sendMode === 'confirm') confirmationReasons.push('CONTACT_CONFIRM_MODE');
  for (const risk of riskCategories) if (risk !== 'MISSING_FACT') confirmationReasons.push(risk);
  if (requiredFacts.length) confirmationReasons.push('MISSING_FACT');
  return { ok: true, value: {
    conversationId: context.snapshot.conversationId,
    contextSnapshotId: context.snapshot.id,
    shouldReply,
    timing: shouldReply ? 'now' : 'no_reply',
    strategy: {
      summary: shouldReply ? '回应当前消息，保持简短并避免无依据的个人事实' : '等待本人处理当前边界或补充事实',
      tone: policy.stylePreferences[0] ?? '自然、简短',
      analysisAdjustment: validAnalysis?.strategyHint ?? null,
      reason: validAnalysis ? `参考分析 ${validAnalysis.id}@${validAnalysis.version} 的证据，仍遵循联系人目标：${policy.goal}` : `按已设置目标回应：${policy.goal}`,
    },
    riskCategories,
    requiredFacts,
    confirmationReasons,
    analysisRefs: validAnalysis ? [{ id: validAnalysis.id, version: validAnalysis.version }] : [],
    skillInvocationRefs: [],
    generatorVersion: FAKE_MODEL_VERSION,
    promptVersion: FAKE_PROMPT_VERSION,
    evidenceRefs: [...new Set([...pending.map(m => m.evidenceRef), ...pending.flatMap(m => m.mediaInterpretation?.evidenceRefs ?? []), ...(validAnalysis?.evidenceRefs ?? []), ...(validAnalysis?.counterEvidenceRefs ?? [])])],
    uncertainty: '这是确定性开发夹具的规则结果，未经过真实模型质量评估',
  } };
}
