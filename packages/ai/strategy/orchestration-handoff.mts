import type { PolicyProjection, ReplyCheck, ReplyDecision, ReplyProposal, Result, ScopedContext } from '../types.mts';

type IntelligencePort = {
  makeDecision(input: { context: ScopedContext; policy: PolicyProjection }): Result<ReplyDecision>;
  proposeReply(input: { context: ScopedContext; policy: PolicyProjection; decision: ReplyDecision }): Promise<Result<ReplyProposal>>;
  checkReply(input: { context: ScopedContext; policy: PolicyProjection; decision: ReplyDecision; parts: ReplyProposal['alternatives'][number]['parts'] }): Result<ReplyCheck>;
};

export type OrchestrationHandoff = {
  decision: ReplyDecision;
  proposal: ReplyProposal | null;
  checks: ReplyCheck[];
  /** 02 owns all authorization, persistence, state transitions and dispatch. */
  authorization: 'not_evaluated';
};

/** Single 04 entrypoint for 02: no proposal is exposed until every candidate passes checks. */
export async function prepareReplyForOrchestration(port: IntelligencePort, context: ScopedContext, policy: PolicyProjection): Promise<Result<OrchestrationHandoff>> {
  const decision = port.makeDecision({ context, policy });
  if (!decision.ok) return decision;
  if (!decision.value.shouldReply) return { ok: true, value: { decision: decision.value, proposal: null, checks: [], authorization: 'not_evaluated' } };
  const proposal = await port.proposeReply({ context, policy, decision: decision.value });
  if (!proposal.ok) return proposal;
  const checks: ReplyCheck[] = [];
  for (const alternative of proposal.value.alternatives) {
    const check = port.checkReply({ context, policy, decision: decision.value, parts: alternative.parts });
    if (!check.ok) return check;
    if (check.value.status === 'blocked') return { ok: false, error: { code: 'MISSING_FACT', message: '候选未通过事实或边界检查', retryable: false } };
    checks.push(check.value);
  }
  return { ok: true, value: { decision: decision.value, proposal: proposal.value, checks, authorization: 'not_evaluated' } };
}
