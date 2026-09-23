import type { PolicyProjection, ReplyCheck, ReplyDecision, ReplyPartProposal, Result, ScopedContext } from '../types.mts';
import { classifyRisks, validateScopedContext } from '../strategy/fake-decision.mts';

export function checkFakeReply(context: ScopedContext, policy: PolicyProjection, decision: ReplyDecision, parts: ReplyPartProposal[]): Result<ReplyCheck> {
  const valid = validateScopedContext(context, policy);
  if (!valid.ok) return valid;
  if (decision.contextSnapshotId !== context.snapshot.id || decision.conversationId !== context.snapshot.conversationId || !decision.shouldReply || !Array.isArray(parts) || parts.length < 1 || parts.some(part => part.type !== 'text' || !part.content?.trim())) {
    return { ok: false, error: { code: 'VALIDATION_FAILED', message: '待检查回复或上下文无效', retryable: false } };
  }
  const text = parts.map(part => part.content).join('\n');
  const riskCategories = [...new Set([...decision.riskCategories, ...classifyRisks(text)])];
  const unsupportedClaims = /我(现在|今天|明天|后天).{0,12}(在|会|有空|没空|加班|去)|我(已经|刚)(到|睡|吃|付款)/u.test(text);
  const factIssues = [...decision.requiredFacts];
  if (unsupportedClaims && !context.facts.some(f => f.subject === 'current_personal_status_or_schedule' && text.includes(f.content))) factIssues.push('回复含未经确认的本人当前状态或安排');
  const styleIssues = text.length > 500 ? ['回复超过当前假模型的简短风格建议'] : [];
  const confirmationReasons = [...decision.confirmationReasons];
  for (const category of classifyRisks(text)) if (!confirmationReasons.includes(category)) confirmationReasons.push(category);
  const status = factIssues.length || riskCategories.includes('STOP_REQUEST') ? 'blocked' : riskCategories.some(category => ['RELATIONSHIP_COMMITMENT', 'CONCRETE_MEETING', 'MONEY_OR_LEGAL', 'SENSITIVE_DATA', 'CONFESSION'].includes(category)) || styleIssues.length ? 'review_required' : 'passed';
  return { ok: true, value: {
    status, factIssues, styleIssues, riskCategories, confirmationReasons,
    evidenceRefs: decision.evidenceRefs,
    checkerVersion: 'fake-check-1',
    authorization: 'not_evaluated',
  } };
}
