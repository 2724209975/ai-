import type { Actor, MediaInterpretationDraft, MessageProjection, Mode, ScopedContext } from '../types.mts';
import type { PgDataProvider } from '../../data/postgres/provider.mts';

type Ref = Readonly<{ id: string; version: number }>;
/** Shared read shape of 03's memory and PostgreSQL projections. */
export type DataContextProjectionInput = Readonly<{
  snapshot: Readonly<{ id: string; contactId: string; conversationId: string; generation: number; cutoffMessageId?: string | null; cutoffTime: string; messageRefs: readonly Ref[]; summaryRefs: readonly Ref[]; factRefs: readonly Ref[]; analysisRefs: readonly Ref[]; policyVersion: number; hash: string }>;
  messages: readonly Readonly<{ id: string; contactId: string; actor: string; type: string; contentRef?: string | null; sentAt: string; isAgentGenerated: boolean; mode: string; platformAccountId: string; platformMessageId: string; mediaId?: string | null }>[];
  facts: readonly Readonly<{ id: string; scope: string; version: number; subject: string; content: string | null; confirmationStatus: string; validFrom: string; validUntil?: string | null; deletionStatus: string; evidenceRefs: readonly Ref[] }>[];
  analyses: readonly Readonly<{ id: string; contactId: string; version: number; cutoff: string; status: string; dependencySet: readonly Ref[] }>[];
}>;

const actors: readonly Actor[] = ['owner', 'contact', 'agent', 'system', 'platform', 'unknown'];
const types: readonly MessageProjection['type'][] = ['text', 'image', 'voice', 'sticker_static', 'sticker_animated', 'unsupported'];
const modes: readonly Mode[] = ['live', 'import', 'trial', 'replay'];

/** 04-side adapter for 03's already scoped, immutable memory or PG projection. No extra lookup. */
export function adaptDataContextProjection(projection: DataContextProjectionInput | Awaited<ReturnType<PgDataProvider['buildContext']>>, mediaById: ReadonlyMap<string, MediaInterpretationDraft> = new Map()): ScopedContext {
  const { snapshot, messages, facts, analyses } = projection as DataContextProjectionInput;
  if (messages.some(m => !actors.includes(m.actor as Actor) || !types.includes(m.type as MessageProjection['type']) || !modes.includes(m.mode as Mode)) ||
    facts.some(f => !['confirmed', 'candidate', 'inferred'].includes(f.confirmationStatus) || !['active', 'deleted'].includes(f.deletionStatus)) ||
    analyses.some(a => !['valid', 'invalid'].includes(a.status))) {
    throw new Error('VALIDATION_FAILED');
  }
  return {
    contactId: snapshot.contactId,
    snapshot: {
      id: snapshot.id, conversationId: snapshot.conversationId, generation: snapshot.generation,
      cutoffMessageId: snapshot.cutoffMessageId ?? null, cutoffTime: snapshot.cutoffTime,
      messageRefs: snapshot.messageRefs.map(r => r.id), summaryRefs: snapshot.summaryRefs.map(r => r.id),
      factRefs: snapshot.factRefs.map(r => ({ ...r })), analysisRefs: snapshot.analysisRefs.map(r => ({ ...r })),
      policyVersion: snapshot.policyVersion, hash: snapshot.hash,
    },
    messages: messages.map(m => ({
      id: m.id, contactId: m.contactId, actor: m.actor as Actor, type: m.type as MessageProjection['type'],
      text: m.type === 'text' ? m.contentRef ?? null : null, sentAt: m.sentAt,
      isAgentGenerated: m.isAgentGenerated, mode: m.mode as Mode,
      evidenceRef: `${m.platformAccountId}:${m.platformMessageId}`, mediaId: m.mediaId ?? undefined,
      mediaInterpretation: m.mediaId ? mediaById.get(m.mediaId) : undefined,
    })),
    facts: facts.map(f => ({
      id: f.id, contactId: f.scope === 'global' ? null : f.scope, version: f.version,
      subject: f.subject, content: f.content ?? '', confirmationStatus: f.confirmationStatus as 'confirmed' | 'candidate' | 'inferred',
      validFrom: f.validFrom, validUntil: f.validUntil ?? null, deletionStatus: f.deletionStatus as 'active' | 'deleted',
      evidenceRefs: f.evidenceRefs.map(r => r.id),
    })),
    analyses: analyses.map(a => ({
      id: a.id, contactId: a.contactId, version: a.version, cutoff: a.cutoff,
      status: a.status === 'valid' ? 'valid' as const : 'invalidated' as const, taxonomyVersion: 'draft-1',
      observation: '', strategyHint: null, evidenceRefs: a.dependencySet.map(r => r.id),
      uncertainty: '03 当前投影未提供可供 04 安全引用的结构化策略主张',
    })),
  };
}
