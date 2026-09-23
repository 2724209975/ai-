/** G1-only bridge across 01/03/04 prototypes. It does not provide durable transactions. */
import type { Event } from '../../platform/mock/adapter.mts';
import type { MemoryDataContextStore } from '../../data/context/store.mts';
import { createFakeIntelligencePort } from '../../ai/index.mts';
import type { PolicyProjection, RiskCategory, ScopedContext, ReplyDecision } from '../../ai/types.mts';
import type { Context, DataPort, Draft, IntelligencePort } from '../conversations/engine.mts';
import type { Policy, Risk } from '../policy/evaluate.mts';

function policyProjection(policy: Policy): PolicyProjection {
  return { contactId: policy.contactId, version: policy.version, goal: policy.goal,
    sendMode: policy.sendMode, agentEnabled: policy.agentEnabled,
    activeContactEnabled: policy.activeContactEnabled, activeConfessionEnabled: policy.activeConfessionEnabled,
    restrictions: [...policy.restrictions], stylePreferences: [] };
}
function risk(category: RiskCategory): Risk {
  const map: Record<RiskCategory, Risk> = {
    STOP_REQUEST: 'stop_request', REJECTION: 'stop_request', ACTIVE_CONTACT: 'ordinary',
    CONFESSION: 'confession', RELATIONSHIP_COMMITMENT: 'relationship_decision',
    CONCRETE_MEETING: 'meeting_commitment', MONEY_OR_LEGAL: 'major_commitment',
    SENSITIVE_DATA: 'sensitive', MISSING_FACT: 'unknown_fact',
  };
  return map[category];
}
function scopedProjection(contactId: string, result: ReturnType<MemoryDataContextStore['buildContext']>): ScopedContext {
  const { snapshot, messages, facts, analyses } = result;
  return {
    contactId,
    snapshot: { id: snapshot.id, conversationId: snapshot.conversationId, generation: snapshot.generation,
      cutoffMessageId: snapshot.cutoffMessageId ?? null, cutoffTime: snapshot.cutoffTime,
      messageRefs: snapshot.messageRefs.map(r => r.id), summaryRefs: snapshot.summaryRefs.map(r => r.id),
      factRefs: snapshot.factRefs.map(r => ({ ...r })), analysisRefs: snapshot.analysisRefs.map(r => ({ ...r })),
      policyVersion: snapshot.policyVersion, hash: snapshot.hash },
    messages: messages.map(m => ({ id: m.id, contactId: m.contactId, actor: m.actor,
      type: m.type, text: m.type === 'text' ? m.contentRef ?? null : null,
      sentAt: m.sentAt, isAgentGenerated: m.isAgentGenerated, mode: m.mode, evidenceRef: `${m.platformAccountId}:${m.platformMessageId}` })),
    facts: facts.map(f => ({ id: f.id, contactId: f.scope === 'global' ? null : f.scope,
      version: f.version, subject: f.subject, content: f.content ?? '',
      confirmationStatus: f.confirmationStatus, validFrom: f.validFrom, validUntil: f.validUntil ?? null,
      deletionStatus: f.deletionStatus, evidenceRefs: f.evidenceRefs.map(r => r.id) })),
    analyses: analyses.map(a => ({ id: a.id, contactId: a.contactId, version: a.version,
      status: a.status === 'valid' ? 'valid' : 'invalidated', taxonomyVersion: 'draft-1',
      observation: '', strategyHint: null, evidenceRefs: a.dependencySet.map(r => r.id), uncertainty: '开发夹具' })),
  };
}

export function createMockIntegrationPorts(store: MemoryDataContextStore, contactIdsByConversation: ReadonlyMap<string, string>, now: () => number = Date.now): { data: DataPort; intelligence: IntelligencePort } {
  const scoped = new Map<string, ScopedContext>();
  const decisions = new Map<string, ReplyDecision>();
  const ai = createFakeIntelligencePort();
  const data: DataPort = {
    async appendObservedMessage(event: Event) {
      const p = event.payload as Record<string, unknown>;
      const ref = p.conversationRef as { accountId: string; conversationId: string };
      const actor = p.actor;
      if (!ref || !['owner', 'contact', 'agent', 'unknown'].includes(String(actor))) throw new Error('VALIDATION_FAILED');
      const contactId = contactIdsByConversation.get(ref.conversationId);
      if (!contactId) throw new Error('NOT_FOUND');
      const result = store.appendObservedMessage({ contactId, conversationId: ref.conversationId,
        platformAccountId: ref.accountId, platformMessageId: String(p.platformMessageId), platformEventId: String(p.platformEventId),
        actor: actor as 'owner' | 'contact' | 'agent' | 'unknown', type: p.type as 'text' | 'image' | 'voice' | 'sticker_static' | 'sticker_animated' | 'unsupported',
        contentRef: p.contentRef as string | undefined, mediaId: p.mediaId as string | undefined,
        quotedMessageId: p.quotedMessageId as string | undefined,
        sentAt: String(p.sentAt), receivedAt: String(p.receivedAt),
        provenance: JSON.stringify(p.provenance ?? {}), isAgentGenerated: actor === 'agent',
        mode: p.mode as 'live' | 'import' | 'trial' | 'replay' });
      return { id: result.message.id, inserted: !result.duplicate };
    },
    async buildContext(contactId, conversationId, generation, policy): Promise<Context> {
      const result = store.buildContext({ callerContactId: contactId, contactId,
        cutoffTime: new Date(now()).toISOString(), generation, allowedScopes: policy.factScopes,
        policyVersion: policy.version, mode: 'live' });
      if (result.snapshot.conversationId !== conversationId) throw new Error('VALIDATION_FAILED');
      const projected = scopedProjection(contactId, result);
      scoped.set(result.snapshot.id, projected);
      return { id: result.snapshot.id, conversationId, generation, policyVersion: policy.version,
        hash: result.snapshot.hash, messageRefs: result.snapshot.messageRefs.map(r => r.id),
        factRefs: result.snapshot.factRefs.map(r => r.id), analysisRefs: result.snapshot.analysisRefs.map(r => r.id),
        messages: result.messages.map(m => ({ id: m.id, text: m.contentRef ?? '', actor: m.actor as 'contact' | 'owner' | 'agent' | 'unknown' })) };
    },
  };
  const intelligence: IntelligencePort = {
    async propose(context, policy): Promise<Draft> {
      const full = scoped.get(context.id); if (!full || full.snapshot.hash !== context.hash) throw new Error('VALIDATION_FAILED');
      const projectedPolicy = policyProjection(policy);
      const decisionResult = ai.makeDecision({ context: full, policy: projectedPolicy });
      if (!decisionResult.ok) {
        if (decisionResult.error.code === 'MEDIA_UNCERTAIN' || decisionResult.error.code === 'UNSUPPORTED_CAPABILITY') return { shouldReply: false, risks: ['media_uncertain'], alternatives: [], generatorVersion: 'fake-1', timing: 'no_reply' };
        throw new Error(decisionResult.error.code);
      }
      const decision = decisionResult.value; decisions.set(context.id, decision);
      const risks = decision.riskCategories.map(risk);
      if (decision.requiredFacts.length && !risks.includes('unknown_fact')) risks.push('unknown_fact');
      if (!decision.shouldReply) return { shouldReply: false, risks, alternatives: [], generatorVersion: decision.generatorVersion, timing: decision.timing === 'wait' ? 'wait' : 'no_reply' };
      const proposalResult = await ai.proposeReply({ context: full, policy: projectedPolicy, decision });
      if (!proposalResult.ok) throw new Error(proposalResult.error.code);
      const proposal = proposalResult.value;
      if (proposal.contextSnapshotId !== context.id || proposal.conversationId !== context.conversationId) throw new Error('VALIDATION_FAILED');
      return { shouldReply: true, risks, timing: 'now', generatorVersion: proposal.generatorVersion,
        alternatives: proposal.alternatives.map(a => ({ key: a.clientAlternativeKey, strategySummary: a.strategySummary,
          parts: a.parts.map(p => ({ key: p.clientPartKey, sequence: p.sequence, type: p.type, content: p.content })) })),
        factVersions: Object.fromEntries(full.snapshot.factRefs.map(r => [r.id, r.version])),
        analysisVersions: Object.fromEntries(full.snapshot.analysisRefs.map(r => [r.id, r.version])) };
    },
    checkEdited(contextSnapshotId, policy, editedParts) {
      const full = scoped.get(contextSnapshotId); const decision = decisions.get(contextSnapshotId);
      if (!full || !decision) return { allowed: false, reasons: ['STALE_PLAN'] };
      const check = ai.checkReply({ context: full, policy: policyProjection(policy), decision,
        parts: editedParts.map((p, index) => ({ clientPartKey: `edited-${index}`, sequence: index + 1, type: p.type, content: p.content })) });
      if (!check.ok) return { allowed: false, reasons: [check.error.code] };
      return { allowed: check.value.status !== 'blocked', reasons: check.value.confirmationReasons };
    },
  };
  return { data, intelligence };
}
