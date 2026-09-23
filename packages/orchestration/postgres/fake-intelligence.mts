/** Explicit offline 04 bridge for the PostgreSQL confirmation demo. */
import { adaptDataContextProjection, createFakeIntelligencePort, prepareReplyForOrchestration } from '../../ai/index.mts';
import type { PolicyProjection, RiskCategory } from '../../ai/types.mts';
import type { Policy, Risk } from '../policy/evaluate.mts';
import type { Draft } from '../conversations/engine.mts';
import type { PersistentContext, PersistentIntelligence } from './confirmed-service.mts';

const port = createFakeIntelligencePort();

function policyView(policy: Policy): PolicyProjection {
  return { contactId: policy.contactId, version: policy.version, goal: policy.goal, sendMode: policy.sendMode,
    agentEnabled: policy.agentEnabled, activeContactEnabled: policy.activeContactEnabled,
    activeConfessionEnabled: policy.activeConfessionEnabled, restrictions: [...policy.restrictions], stylePreferences: [] };
}
function risk(value: RiskCategory): Risk {
  const mapped: Record<RiskCategory, Risk> = {
    STOP_REQUEST: 'stop_request', REJECTION: 'stop_request', ACTIVE_CONTACT: 'sensitive',
    CONFESSION: 'confession', RELATIONSHIP_COMMITMENT: 'relationship_decision',
    CONCRETE_MEETING: 'meeting_commitment', MONEY_OR_LEGAL: 'major_commitment',
    SENSITIVE_DATA: 'sensitive', MISSING_FACT: 'unknown_fact',
  };
  return mapped[value];
}
function blockedDraft(code: string, context: PersistentContext): Draft {
  if (code === 'MISSING_FACT') return { shouldReply: false, risks: ['unknown_fact'], alternatives: [], generatorVersion: 'fake-04', timing: 'no_reply' };
  if (code === 'MEDIA_UNCERTAIN' || code === 'UNSUPPORTED_CAPABILITY') return { shouldReply: false, risks: ['media_uncertain'], alternatives: [], generatorVersion: 'fake-04', timing: 'no_reply' };
  throw new Error(`INTELLIGENCE_${code}:${context.snapshot.id}`);
}

export function createFakePersistentIntelligence(): PersistentIntelligence {
  return {
    async propose(projection, policy): Promise<Draft> {
      const context = adaptDataContextProjection(projection);
      const handoff = await prepareReplyForOrchestration(port, context, policyView(policy));
      if (!handoff.ok) return blockedDraft(handoff.error.code, projection);
      const { decision, proposal } = handoff.value;
      return { shouldReply: decision.shouldReply && !!proposal, risks: decision.riskCategories.map(risk),
        alternatives: proposal?.alternatives.map(a => ({ key: a.clientAlternativeKey, strategySummary: a.strategySummary,
          parts: a.parts.map(p => ({ key: p.clientPartKey, sequence: p.sequence, type: 'text', content: p.content })) })) ?? [],
        generatorVersion: decision.generatorVersion, timing: decision.timing === 'delay' ? 'wait' : decision.timing === 'no_reply' ? 'no_reply' : decision.timing,
        factVersions: Object.fromEntries(projection.snapshot.factRefs.map(r => [r.id, r.version])),
        analysisVersions: Object.fromEntries(projection.snapshot.analysisRefs.map(r => [r.id, r.version])) };
    },
    async checkEdited(projection, policy, parts) {
      const context = adaptDataContextProjection(projection);
      const decision = port.makeDecision({ context, policy: policyView(policy) });
      if (!decision.ok || !decision.value.shouldReply) return { allowed: false, reasons: [decision.ok ? 'POLICY_BLOCKED' : decision.error.code] };
      const checked = port.checkReply({ context, policy: policyView(policy), decision: decision.value,
        parts: parts.map((p, index) => ({ clientPartKey: `edited-${index + 1}`, sequence: index + 1, type: 'text', content: p.content })) });
      if (!checked.ok) return { allowed: false, reasons: [checked.error.code] };
      return { allowed: checked.value.status !== 'blocked', reasons: checked.value.factIssues.length ? ['MISSING_FACT'] : checked.value.confirmationReasons };
    },
  };
}
