import type { AnalysisDraft, PolicyProjection, Result, ScopedContext } from '../types.mts';
import { validateScopedContext } from '../strategy/fake-decision.mts';

/** Evidence skeleton only. D10/D11 have not fixed a relationship taxonomy or quality threshold. */
export function analyzeFakeContact(context: ScopedContext, policy: PolicyProjection): Result<AnalysisDraft> {
  const valid = validateScopedContext(context, policy);
  if (!valid.ok) return valid;
  const contactMessages = context.messages.filter(m => m.actor === 'contact' && m.mode !== 'trial' && m.mode !== 'replay' && m.type === 'text' && !!m.text?.trim()).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const evidence = contactMessages.map(m => m.evidenceRef);
  const enoughForObservation = contactMessages.length >= 3;
  const short = contactMessages.filter(m => [...m.text!].length <= 12);
  const long = contactMessages.filter(m => [...m.text!].length > 12);
  const claims: AnalysisDraft['claims'] = [];
  if (enoughForObservation) {
    claims.push({
      kind: 'observation',
      text: `截至快照，对方有 ${contactMessages.length} 条可读文字消息；数量本身不能证明性格或关系阶段。`,
      supportingEvidence: evidence, counterEvidence: [],
      alternativeExplanations: ['消息量可能受空闲时间、平台使用习惯和导入覆盖范围影响'],
      uncertainty: '只描述当前快照中可见、可读的文字消息',
    });
    if (short.length >= 2 && long.length >= 1) claims.push({
      kind: 'inference',
      text: '在这段聊天的可见样本中，对方有简短表达，也有较长表达；不能据此确定稳定性格。',
      supportingEvidence: short.map(m => m.evidenceRef),
      counterEvidence: long.map(m => m.evidenceRef),
      alternativeExplanations: ['不同话题需要不同篇幅', '平台或时间条件改变了表达长度'],
      uncertainty: '表达倾向草案；尚未按 D10/D11 确定维度及更新门槛',
    });
  }
  if (evidence.length) claims.push({
    kind: 'inference', text: '现有证据不足以确定双方关系阶段；线下互动和双方确认情况可能不在本快照中。',
    supportingEvidence: evidence, counterEvidence: [],
    alternativeExplanations: ['可能存在未纳入的线下互动', '当前消息可同时符合朋友或暧昧等多种解释'],
    uncertainty: 'D10/D11 未确定阶段体系和证据门槛，保持阶段未知',
  });
  return { ok: true, value: {
    contactId: context.contactId,
    contextSnapshotId: context.snapshot.id,
    taxonomyVersion: 'draft-1',
    status: enoughForObservation ? 'draft' : 'insufficient_evidence',
    sampleRange: { from: contactMessages[0]?.sentAt ?? null, to: context.snapshot.cutoffTime },
    claims,
    stageHypotheses: [],
    trend: 'unknown',
    uncertainty: '性格与关系阶段体系及证据门槛待 D10/D11 确认；假模型不输出诊断或阶段结论',
    dependencySet: contactMessages.map(m => m.id),
    analysisVersion: 'fake-analysis-1',
  } };
}
