import type { Draft } from '../../orchestration/conversations/engine.mts';
import type { PersistentContext, PersistentIntelligence } from '../../orchestration/postgres/confirmed-service.mts';
import type { Policy, Risk } from '../../orchestration/policy/evaluate.mts';
import type { PgDataProvider } from '../../data/postgres/provider.mts';
import type { PgPool } from '../../infrastructure/postgres/transaction.mts';
import { createFakeIntelligencePort } from '../index.mts';
import { adaptDataContextProjection } from '../understanding/context-adapter.mts';
import { prepareReplyForOrchestration } from './orchestration-handoff.mts';
import { createTextCandidateGateway, type TextModelMeasurement, type TextModelProvider } from '../generation/text-provider-contract.mts';
import type { PolicyProjection, RiskCategory } from '../types.mts';
import { generationFromText } from '../pipeline-v2/providers.mts';

function projectedPolicy(policy: Policy): PolicyProjection {
  return { contactId: policy.contactId, version: policy.version, goal: policy.goal,
    sendMode: policy.sendMode, agentEnabled: policy.agentEnabled,
    activeContactEnabled: policy.activeContactEnabled, activeConfessionEnabled: policy.activeConfessionEnabled,
    restrictions: [...policy.restrictions], stylePreferences: [...(policy.stylePreferences ?? [])] };
}

const riskMap: Record<RiskCategory, Risk> = {
  STOP_REQUEST: 'stop_request', REJECTION: 'stop_request', ACTIVE_CONTACT: 'ordinary',
  CONFESSION: 'confession', RELATIONSHIP_COMMITMENT: 'relationship_decision',
  CONCRETE_MEETING: 'meeting_commitment', MONEY_OR_LEGAL: 'major_commitment',
  SENSITIVE_DATA: 'sensitive', MISSING_FACT: 'unknown_fact',
};

/** 02 passes the full 03 projection; 04 checks its scope and versions before use. */
function scopedContext(context: PersistentContext, policy: Policy) {
  const full = adaptDataContextProjection(context);
  if (full.contactId !== policy.contactId || full.snapshot.policyVersion !== policy.version ||
    !Number.isSafeInteger(context.dependencyEpoch) || context.dependencyEpoch < 0) throw new Error('STALE_CONTEXT');
  return full;
}

/** Shape consumed by 02 PgConfirmedService; 04 never receives a send capability. */
function intelligenceFromPort(ai: ReturnType<typeof createFakeIntelligencePort>, generatorPrefix: string): PersistentIntelligence {
  return {
    async propose(context, policy): Promise<Draft> {
      const full = scopedContext(context, policy);
      const prepared = await prepareReplyForOrchestration(ai, full, projectedPolicy(policy));
      if (!prepared.ok) {
        const code = prepared.error.code;
        if (code === 'MEDIA_UNCERTAIN' || code === 'UNSUPPORTED_CAPABILITY') return { shouldReply: false, risks: ['media_uncertain'], alternatives: [], generatorVersion: generatorPrefix, timing: 'no_reply' };
        if (code === 'MISSING_FACT') return { shouldReply: false, risks: ['unknown_fact'], alternatives: [], generatorVersion: generatorPrefix, timing: 'no_reply' };
        throw new Error(code);
      }
      const { decision, proposal } = prepared.value;
      const risks = [...new Set(decision.riskCategories.map(risk => riskMap[risk]))];
      if (decision.requiredFacts.length && !risks.includes('unknown_fact')) risks.push('unknown_fact');
      if (!proposal) return { shouldReply: false, risks, alternatives: [], generatorVersion: decision.generatorVersion, timing: decision.timing === 'wait' ? 'wait' : 'no_reply' };
      return { shouldReply: true, risks, generatorVersion: proposal.generatorVersion, promptVersion: proposal.promptVersion, timing: 'now',
        alternatives: proposal.alternatives.map(a => ({ key: a.clientAlternativeKey, strategySummary: a.strategySummary,
          parts: a.parts.map(p => ({ key: p.clientPartKey, sequence: p.sequence, type: p.type, content: p.content })) })),
        factVersions: Object.fromEntries(full.snapshot.factRefs.map(r => [r.id, r.version])),
        analysisVersions: Object.fromEntries(full.snapshot.analysisRefs.map(r => [r.id, r.version])) };
    },
    async checkEdited(context, policy, parts) {
      try {
        const full = scopedContext(context, policy);
        const decision = ai.makeDecision({ context: full, policy: projectedPolicy(policy) });
        if (!decision.ok) return { allowed: false, reasons: [decision.error.code] };
        if (!decision.value.shouldReply) return { allowed: false, reasons: decision.value.confirmationReasons.length ? decision.value.confirmationReasons : ['POLICY_BLOCKED'] };
        const checked = ai.checkReply({ context: full, policy: projectedPolicy(policy), decision: decision.value,
          parts: parts.map((p, i) => ({ clientPartKey: `edited-${i + 1}`, sequence: i + 1, type: p.type, content: p.content })) });
        if (!checked.ok) return { allowed: false, reasons: [checked.error.code] };
        if (checked.value.status === 'blocked') return { allowed: false, reasons: [checked.value.factIssues.length ? 'MISSING_FACT' : 'POLICY_BLOCKED', ...checked.value.confirmationReasons] };
        return { allowed: true, reasons: checked.value.confirmationReasons };
      } catch (error) {
        return { allowed: false, reasons: [error instanceof Error ? error.message : 'VALIDATION_FAILED'] };
      }
    },
  };
}

export function createPersistentFakeIntelligence(): PersistentIntelligence {
  return { ...intelligenceFromPort(createFakeIntelligencePort(), 'fake-deterministic-1'), v2Generations: [] };
}

/** Same decision, checks and persistence as the fake path; only candidate text comes from the model.
 * A model that fails to answer yields MODEL_UNAVAILABLE, which 02 turns into a paused contact. */
export function createTextModelIntelligence(provider: TextModelProvider, observe?: (measurement: TextModelMeasurement) => void): PersistentIntelligence {
  return { ...intelligenceFromPort(createFakeIntelligencePort(createTextCandidateGateway(provider, observe)), 'fake-deterministic-1'), v2Generations: [generationFromText(provider)] };
}

/** Compatibility wrapper used by the composition roots. */
export function createPgTextModelIntelligence(options: { provider: TextModelProvider; observe?: (measurement: TextModelMeasurement) => void }): PersistentIntelligence {
  return createTextModelIntelligence(options.provider, options.observe);
}

/** Compatibility alias for 07 CLI; pool/data are no longer read by 04. */
export function createPgPersistentFakeIntelligence(_legacyOptions?: { pool: PgPool; data: PgDataProvider }): PersistentIntelligence {
  return createPersistentFakeIntelligence();
}
