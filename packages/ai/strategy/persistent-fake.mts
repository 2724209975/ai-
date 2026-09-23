import type { Draft } from '../../orchestration/conversations/engine.mts';
import type { PersistentIntelligence } from '../../orchestration/postgres/confirmed-service.mts';
import type { Policy, Risk } from '../../orchestration/policy/evaluate.mts';
import type { PgDataProvider } from '../../data/postgres/provider.mts';
import { withTransaction, type PgPool } from '../../infrastructure/postgres/transaction.mts';
import { createFakeIntelligencePort } from '../index.mts';
import { adaptDataContextProjection, type DataContextProjectionInput } from '../understanding/context-adapter.mts';
import { prepareReplyForOrchestration } from './orchestration-handoff.mts';
import type { PolicyProjection, RiskCategory } from '../types.mts';

type PgProjection = Awaited<ReturnType<PgDataProvider['buildContext']>>;
export type ScopedProjectionLoader = (snapshotId: string, policy: Policy) => Promise<DataContextProjectionInput | PgProjection>;
/** The smallest 02 → 04 envelope: the immutable snapshot reference 04 must re-verify on its own. */
type SnapshotEnvelope = { snapshot: { id: string; conversationId: string; generation: number; policyVersion: number; hash: string;
  messageRefs: readonly { id: string }[]; factRefs: readonly { id: string }[]; analysisRefs: readonly { id: string }[] } };

function projectedPolicy(policy: Policy): PolicyProjection {
  return { contactId: policy.contactId, version: policy.version, goal: policy.goal,
    sendMode: policy.sendMode, agentEnabled: policy.agentEnabled,
    activeContactEnabled: policy.activeContactEnabled, activeConfessionEnabled: policy.activeConfessionEnabled,
    restrictions: [...policy.restrictions], stylePreferences: [] };
}

const riskMap: Record<RiskCategory, Risk> = {
  STOP_REQUEST: 'stop_request', REJECTION: 'stop_request', ACTIVE_CONTACT: 'ordinary',
  CONFESSION: 'confession', RELATIONSHIP_COMMITMENT: 'relationship_decision',
  CONCRETE_MEETING: 'meeting_commitment', MONEY_OR_LEGAL: 'major_commitment',
  SENSITIVE_DATA: 'sensitive', MISSING_FACT: 'unknown_fact',
};

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 02 hands 04 the projection it just built. 04 re-reads the snapshot in its own transaction and
 * refuses any envelope whose identity, hash, versions or references no longer match, so a forged
 * or lossy 02 envelope can never replace 03's stored snapshot. */
async function scopedContext(context: SnapshotEnvelope, policy: Policy, load: ScopedProjectionLoader) {
  const envelope = context.snapshot;
  const full = adaptDataContextProjection(await load(envelope.id, policy));
  if (full.contactId !== policy.contactId || full.snapshot.id !== envelope.id || full.snapshot.conversationId !== envelope.conversationId ||
    full.snapshot.generation !== envelope.generation || full.snapshot.policyVersion !== envelope.policyVersion ||
    full.snapshot.policyVersion !== policy.version || full.snapshot.hash !== envelope.hash ||
    !sameIds(full.snapshot.messageRefs, envelope.messageRefs.map(r => r.id)) || !sameIds(full.snapshot.factRefs.map(r => r.id), envelope.factRefs.map(r => r.id)) ||
    !sameIds(full.snapshot.analysisRefs.map(r => r.id), envelope.analysisRefs.map(r => r.id))) throw new Error('STALE_CONTEXT');
  return full;
}

/** Shape consumed by 02 PgConfirmedService; 04 never receives a send capability. */
export function createPersistentFakeIntelligence(load: ScopedProjectionLoader): PersistentIntelligence {
  const ai = createFakeIntelligencePort();
  return {
    async propose(context, policy): Promise<Draft> {
      const full = await scopedContext(context, policy, load);
      const prepared = await prepareReplyForOrchestration(ai, full, projectedPolicy(policy));
      if (!prepared.ok) {
        const code = prepared.error.code;
        if (code === 'MEDIA_UNCERTAIN' || code === 'UNSUPPORTED_CAPABILITY') return { shouldReply: false, risks: ['media_uncertain'], alternatives: [], generatorVersion: 'fake-deterministic-1', timing: 'no_reply' };
        if (code === 'MISSING_FACT') return { shouldReply: false, risks: ['unknown_fact'], alternatives: [], generatorVersion: 'fake-deterministic-1', timing: 'no_reply' };
        throw new Error(code);
      }
      const { decision, proposal } = prepared.value;
      const risks = [...new Set(decision.riskCategories.map(risk => riskMap[risk]))];
      if (decision.requiredFacts.length && !risks.includes('unknown_fact')) risks.push('unknown_fact');
      if (!proposal) return { shouldReply: false, risks, alternatives: [], generatorVersion: decision.generatorVersion, timing: decision.timing === 'wait' ? 'wait' : 'no_reply' };
      return { shouldReply: true, risks, generatorVersion: proposal.generatorVersion, timing: 'now',
        alternatives: proposal.alternatives.map(a => ({ key: a.clientAlternativeKey, strategySummary: a.strategySummary,
          parts: a.parts.map(p => ({ key: p.clientPartKey, sequence: p.sequence, type: p.type, content: p.content })) })),
        factVersions: Object.fromEntries(full.snapshot.factRefs.map(r => [r.id, r.version])),
        analysisVersions: Object.fromEntries(full.snapshot.analysisRefs.map(r => [r.id, r.version])) };
    },
    async checkEdited(context, policy, parts) {
      try {
        const full = await scopedContext(context, policy, load);
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

/** Uses 03's current epoch and readContextProjection in one read transaction. */
export function createPgPersistentFakeIntelligence(options: { pool: PgPool; data: PgDataProvider }): PersistentIntelligence {
  return createPersistentFakeIntelligence((snapshotId, policy) => withTransaction(options.pool, async tx => {
    const epoch = await options.data.getDependencyEpoch(tx, policy.contactId, policy.contactId);
    return options.data.readContextProjection(tx, { callerContactId: policy.contactId, contactId: policy.contactId,
      snapshotId, allowedScopes: policy.factScopes, expectedDependencyEpoch: epoch });
  }));
}
