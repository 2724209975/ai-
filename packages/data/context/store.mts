/** 03's dependency-free, in-memory contract prototype. Not durable production storage. */
import { createHash, randomBytes } from 'node:crypto';

export type Mode = 'live' | 'import' | 'trial' | 'replay';
export type Actor = 'owner' | 'contact' | 'agent' | 'system' | 'platform' | 'unknown';
export type MessageType = 'text' | 'image' | 'voice' | 'sticker_static' | 'sticker_animated' | 'unsupported';
export type FactSource = 'owner-confirmed' | 'owner-message-candidate' | 'model-inference' | 'agent-generated';
export type Ref = Readonly<{ id: string; version: number }>;

export type Contact = Readonly<{ id: string; conversationId: string; platformAccountId: string; externalContactRef: string; displayName: string; enrollmentStatus: 'enrolled' | 'discovered'; version: number; createdAt: string; updatedAt: string }>;
export type Message = Readonly<{ id: string; contactId: string; conversationId: string; platformAccountId: string; platformMessageId: string; platformEventId: string; actor: Actor; type: MessageType; contentRef?: string; mediaId?: string; quotedMessageId?: string; sentAt: string; receivedAt: string; provenance: string; isAgentGenerated: boolean; mode: Mode; version: number; createdAt: string; updatedAt: string; deletionStatus: 'active' | 'deleted' }>;
export type Fact = Readonly<{ id: string; subject: string; scope: 'global' | string; content: string | null; sourceCategory: FactSource; evidenceRefs: readonly Ref[]; validFrom: string; validUntil?: string; confirmationStatus: 'candidate' | 'confirmed'; deletionStatus: 'active' | 'deleted'; version: number; createdAt: string; updatedAt: string }>;
export type Analysis = Readonly<{ id: string; contactId: string; analysisVersion: string; cutoff: string; claims: readonly unknown[]; dependencySet: readonly Ref[]; status: 'valid' | 'invalid'; version: number; createdAt: string; updatedAt: string }>;
export type ContextSnapshot = Readonly<{ id: string; conversationId: string; contactId: string; generation: number; cutoffMessageId?: string; cutoffTime: string; messageRefs: readonly Ref[]; summaryRefs: readonly Ref[]; factRefs: readonly Ref[]; analysisRefs: readonly Ref[]; policyVersion: number; hash: string; createdAt: string; updatedAt: string }>;
export type ContextProjection = Readonly<{ snapshot: ContextSnapshot; messages: readonly Message[]; facts: readonly Fact[]; analyses: readonly Analysis[] }>;
export type Invalidation = Readonly<{ sequence: number; eventType: 'FactChanged' | 'EvidenceInvalidated' | 'AnalysisChanged'; contactId?: string; ref: Ref; affectedSnapshotIds: readonly string[]; occurredAt: string }>;
export type OriginCorrection = Readonly<{ messageId: string; oldActor: 'unknown'; newActor: 'owner' | 'agent'; evidenceRef: string; messageVersion: number; correctedAt: string }>;

type AppendMessage = Omit<Message, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'deletionStatus'>;
type CreateFact = Pick<Fact, 'subject' | 'scope' | 'content' | 'sourceCategory' | 'evidenceRefs' | 'validFrom' | 'validUntil'>;
type BuildContext = { callerContactId: string; contactId: string; cutoffMessageId?: string; cutoffTime: string; generation: number; allowedScopes: readonly string[]; policyVersion: number; mode?: 'live' | 'import' };

export class DataError extends Error {
  readonly code: 'VALIDATION_FAILED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT_VERSION' | 'STALE_CONTEXT';
  constructor(code: DataError['code'], message = code) { super(message); this.code = code; }
}

function fail(code: DataError['code']): never { throw new DataError(code); }
function required(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0; }
function timestamp(v: unknown): v is string { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(v) && Number.isFinite(Date.parse(v)); }
function id(now: number): string {
  const b = randomBytes(16); b.writeUIntBE(Math.max(0, Math.trunc(now)), 0, 6);
  b[6] = (b[6]! & 15) | 0x70; b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
function hash(v: unknown): string { return createHash('sha256').update(stable(v)).digest('hex'); }
function copy<T>(v: T): T { return structuredClone(v); }
function frozen<T>(v: T): T {
  if (v && typeof v === 'object') { Object.freeze(v); for (const x of Object.values(v)) frozen(x); }
  return v;
}
function out<T>(v: T): Readonly<T> { return frozen(copy(v)); }

/** Only a scoped caller may read a contact's messages/facts or resolve a context. */
export class MemoryDataContextStore {
  private readonly clock: () => number;
  #contacts = new Map<string, Contact>();
  #messages = new Map<string, Message>();
  #messageKeys = new Map<string, string>();
  #eventKeys = new Map<string, string>();
  #initialMessageHashes = new Map<string, string>();
  #facts = new Map<string, Fact>();
  #analyses = new Map<string, Analysis>();
  #snapshots = new Map<string, ContextSnapshot>();
  #invalid = new Set<string>();
  #events: Invalidation[] = [];
  #originCorrections: OriginCorrection[] = [];
  constructor(clock: () => number = Date.now) { this.clock = clock; }
  #now(): string { return new Date(this.clock()).toISOString(); }
  #contact(contactId: string): Contact { const c = this.#contacts.get(contactId); if (!c) fail('NOT_FOUND'); return c; }
  #authorize(callerContactId: string, contactId: string): Contact {
    if (!required(callerContactId) || callerContactId !== contactId) fail('FORBIDDEN');
    return this.#contact(contactId);
  }
  #emit(eventType: Invalidation['eventType'], ref: Ref, contactId?: string): void {
    const affectedSnapshotIds: string[] = [];
    for (const s of this.#snapshots.values()) {
      if (contactId && s.contactId !== contactId) continue;
      if (eventType === 'FactChanged' || eventType === 'AnalysisChanged' || [...s.messageRefs, ...s.factRefs, ...s.analysisRefs].some(r => r.id === ref.id)) {
        this.#invalid.add(s.id); affectedSnapshotIds.push(s.id);
      }
    }
    this.#events.push({ sequence: this.#events.length + 1, eventType, contactId, ref: copy(ref), affectedSnapshotIds, occurredAt: this.#now() });
  }
  listInvalidations(afterSequence = 0): readonly Invalidation[] { return out(this.#events.filter(e => e.sequence > afterSequence)); }
  listOriginCorrections(callerContactId: string, contactId: string): readonly OriginCorrection[] {
    this.#authorize(callerContactId, contactId);
    return out(this.#originCorrections.filter(c => this.#messages.get(c.messageId)?.contactId === contactId));
  }

  createContact(input: { id?: string; conversationId: string; platformAccountId: string; externalContactRef: string; displayName: string; enrollmentStatus: Contact['enrollmentStatus'] }): Contact {
    if (![input.conversationId, input.platformAccountId, input.externalContactRef, input.displayName].every(required)) fail('VALIDATION_FAILED');
    if (![...this.#contacts.values()].every(c => c.platformAccountId !== input.platformAccountId || c.externalContactRef !== input.externalContactRef)) fail('CONFLICT_VERSION');
    const t = this.#now(); const c: Contact = { ...input, id: input.id ?? id(this.clock()), version: 1, createdAt: t, updatedAt: t };
    if (this.#contacts.has(c.id)) fail('CONFLICT_VERSION'); this.#contacts.set(c.id, copy(c)); return out(c);
  }
  appendObservedMessage(input: AppendMessage): { message: Message; duplicate: boolean } {
    const c = this.#contact(input.contactId);
    if (c.conversationId !== input.conversationId || c.platformAccountId !== input.platformAccountId || !required(input.platformMessageId) || !required(input.platformEventId) || !timestamp(input.sentAt) || !timestamp(input.receivedAt) || !required(input.provenance)) fail('VALIDATION_FAILED');
    if (!['live', 'import', 'trial', 'replay'].includes(input.mode) || !['owner', 'contact', 'agent', 'system', 'platform', 'unknown'].includes(input.actor) || !['text', 'image', 'voice', 'sticker_static', 'sticker_animated', 'unsupported'].includes(input.type)) fail('VALIDATION_FAILED');
    if (input.isAgentGenerated !== (input.actor === 'agent')) fail('VALIDATION_FAILED');
    const key = stable([input.mode, input.platformAccountId, input.conversationId, input.platformMessageId]);
    const eventKey = stable([input.mode, input.platformAccountId, input.conversationId, input.platformEventId]);
    const priorId = this.#messageKeys.get(key) ?? this.#eventKeys.get(eventKey);
    if (priorId) {
      const prior = this.#messages.get(priorId)!;
      if (prior.platformMessageId !== input.platformMessageId || this.#initialMessageHashes.get(priorId) !== hash({ ...input, platformEventId: undefined })) fail('CONFLICT_VERSION');
      this.#eventKeys.set(eventKey, priorId);
      return { message: out(prior), duplicate: true };
    }
    const t = this.#now(); const m: Message = { ...copy(input), id: id(this.clock()), version: 1, createdAt: t, updatedAt: t, deletionStatus: 'active' };
    this.#messages.set(m.id, m); this.#messageKeys.set(key, m.id); this.#eventKeys.set(eventKey, m.id); this.#initialMessageHashes.set(m.id, hash({ ...input, platformEventId: undefined }));
    return { message: out(m), duplicate: false };
  }
  queryMessages(input: { callerContactId: string; contactId: string; cutoffTime: string; cutoffMessageId?: string; mode?: 'live' | 'import'; limit?: number }): readonly Message[] {
    const c = this.#authorize(input.callerContactId, input.contactId);
    if (!timestamp(input.cutoffTime) || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))) fail('VALIDATION_FAILED');
    const cutoff = input.cutoffMessageId ? this.#messages.get(input.cutoffMessageId) : undefined;
    if (input.cutoffMessageId && (!cutoff || cutoff.contactId !== c.id || cutoff.sentAt > input.cutoffTime)) fail('NOT_FOUND');
    const compare = (a: Message, b: Message) => a.sentAt.localeCompare(b.sentAt) || a.platformEventId.localeCompare(b.platformEventId) || a.platformMessageId.localeCompare(b.platformMessageId) || a.id.localeCompare(b.id);
    const rows = [...this.#messages.values()].filter(m => m.contactId === c.id && m.conversationId === c.conversationId && m.deletionStatus === 'active' && (m.mode === 'live' || (input.mode === 'import' && m.mode === 'import')) && m.sentAt <= input.cutoffTime && (!cutoff || compare(m, cutoff) <= 0)).sort(compare);
    return out(input.limit ? rows.slice(-input.limit) : rows);
  }
  createFact(input: CreateFact): Fact {
    if (!required(input.subject) || !required(input.scope) || !required(input.content) || !timestamp(input.validFrom) || (input.validUntil && (!timestamp(input.validUntil) || input.validUntil <= input.validFrom)) || !['owner-confirmed', 'owner-message-candidate', 'model-inference', 'agent-generated'].includes(input.sourceCategory)) fail('VALIDATION_FAILED');
    if (input.scope !== 'global') this.#contact(input.scope);
    if (input.sourceCategory === 'agent-generated') fail('VALIDATION_FAILED');
    if (input.scope === 'global' && input.evidenceRefs.length) fail('VALIDATION_FAILED');
    if (input.sourceCategory === 'owner-message-candidate' && input.evidenceRefs.length === 0) fail('VALIDATION_FAILED');
    for (const ref of input.evidenceRefs) {
      const m = this.#messages.get(ref.id);
      if (!m || m.version !== ref.version || m.contactId !== input.scope || m.deletionStatus !== 'active' || m.actor === 'agent' || m.actor === 'unknown' || (input.sourceCategory === 'owner-message-candidate' && m.actor !== 'owner') || m.mode === 'trial' || m.mode === 'replay') fail('VALIDATION_FAILED');
    }
    const t = this.#now(); const f: Fact = { ...copy(input), id: id(this.clock()), confirmationStatus: input.sourceCategory === 'owner-confirmed' ? 'confirmed' : 'candidate', deletionStatus: 'active', version: 1, createdAt: t, updatedAt: t };
    this.#facts.set(f.id, f); this.#emit('FactChanged', { id: f.id, version: f.version }, f.scope === 'global' ? undefined : f.scope); return out(f);
  }
  queryFacts(input: { callerContactId: string; contactId: string; asOf: string; allowedScopes: readonly string[] }): readonly Fact[] {
    this.#authorize(input.callerContactId, input.contactId);
    if (!timestamp(input.asOf) || !Array.isArray(input.allowedScopes)) fail('VALIDATION_FAILED');
    const allowed = new Set(input.allowedScopes.filter(s => s === 'global' || s === input.contactId));
    return out([...this.#facts.values()].filter(f => allowed.has(f.scope) && (f.scope === 'global' || f.scope === input.contactId) && f.confirmationStatus === 'confirmed' && f.deletionStatus === 'active' && f.validFrom <= input.asOf && (!f.validUntil || input.asOf < f.validUntil)).sort((a, b) => a.id.localeCompare(b.id)));
  }
  searchFacts(input: { callerContactId: string; contactId: string; asOf: string; allowedScopes: readonly string[]; query: string }): readonly Fact[] {
    if (!required(input.query)) fail('VALIDATION_FAILED');
    const scoped = this.queryFacts(input);
    return out(scoped.filter(f => f.content?.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())));
  }
  confirmFact(input: { factId: string; expectedVersion: number; ownerConfirmed: true }): Fact {
    const f = this.#facts.get(input.factId); if (!f) fail('NOT_FOUND');
    if (f.version !== input.expectedVersion) fail('CONFLICT_VERSION');
    if (f.deletionStatus !== 'active' || f.sourceCategory === 'model-inference' || f.sourceCategory === 'agent-generated' || input.ownerConfirmed !== true) fail('VALIDATION_FAILED');
    const next: Fact = { ...f, confirmationStatus: 'confirmed', version: f.version + 1, updatedAt: this.#now() }; this.#facts.set(f.id, next); this.#emit('FactChanged', { id: f.id, version: next.version }, f.scope === 'global' ? undefined : f.scope); return out(next);
  }
  correctFact(input: { factId: string; expectedVersion: number; content: string; validUntil?: string }): Fact {
    const f = this.#facts.get(input.factId); if (!f) fail('NOT_FOUND'); if (f.version !== input.expectedVersion) fail('CONFLICT_VERSION');
    if (f.deletionStatus !== 'active' || !required(input.content) || (input.validUntil && (!timestamp(input.validUntil) || input.validUntil <= f.validFrom))) fail('VALIDATION_FAILED');
    const next: Fact = { ...f, content: input.content, validUntil: input.validUntil, version: f.version + 1, updatedAt: this.#now() }; this.#facts.set(f.id, next); this.#invalidateFactAnalyses(f.id); this.#emit('FactChanged', { id: f.id, version: next.version }, f.scope === 'global' ? undefined : f.scope); return out(next);
  }
  deleteFact(input: { factId: string; expectedVersion: number }): Fact {
    const f = this.#facts.get(input.factId); if (!f) fail('NOT_FOUND'); if (f.version !== input.expectedVersion) fail('CONFLICT_VERSION');
    const next: Fact = { ...f, content: null, evidenceRefs: [], deletionStatus: 'deleted', version: f.version + 1, updatedAt: this.#now() }; this.#facts.set(f.id, next); this.#invalidateFactAnalyses(f.id); this.#emit('FactChanged', { id: f.id, version: next.version }, f.scope === 'global' ? undefined : f.scope); return out(next);
  }
  expireFact(input: { factId: string; expectedVersion: number; effectiveAt: string }): Fact {
    const f = this.#facts.get(input.factId); if (!f) fail('NOT_FOUND'); if (f.version !== input.expectedVersion) fail('CONFLICT_VERSION');
    if (f.deletionStatus !== 'active' || !timestamp(input.effectiveAt) || input.effectiveAt <= f.validFrom || input.effectiveAt > this.#now()) fail('VALIDATION_FAILED');
    const next: Fact = { ...f, validUntil: input.effectiveAt, version: f.version + 1, updatedAt: this.#now() }; this.#facts.set(f.id, next); this.#invalidateFactAnalyses(f.id); this.#emit('FactChanged', { id: f.id, version: next.version }, f.scope === 'global' ? undefined : f.scope); return out(next);
  }
  resolveMessageOrigin(input: { callerContactId: string; contactId: string; messageId: string; expectedVersion: number; newActor: 'owner' | 'agent'; evidenceRef: string }): Message {
    this.#authorize(input.callerContactId, input.contactId);
    const m = this.#messages.get(input.messageId); if (!m || m.contactId !== input.contactId) fail('NOT_FOUND');
    if (m.version !== input.expectedVersion) fail('CONFLICT_VERSION');
    if (m.actor !== 'unknown' || !['owner', 'agent'].includes(input.newActor) || !required(input.evidenceRef) || m.deletionStatus !== 'active') fail('VALIDATION_FAILED');
    const t = this.#now(); const next: Message = { ...m, actor: input.newActor, isAgentGenerated: input.newActor === 'agent', version: m.version + 1, updatedAt: t };
    this.#messages.set(m.id, next);
    this.#originCorrections.push({ messageId: m.id, oldActor: 'unknown', newActor: input.newActor, evidenceRef: input.evidenceRef, messageVersion: next.version, correctedAt: t });
    for (const a of [...this.#analyses.values()]) if (a.dependencySet.some(r => r.id === m.id) && a.status === 'valid') this.invalidateAnalysis(a.id);
    this.#emit('EvidenceInvalidated', { id: m.id, version: next.version }, m.contactId);
    return out(next);
  }
  deleteMessage(input: { callerContactId: string; contactId: string; messageId: string; expectedVersion: number }): Message {
    this.#authorize(input.callerContactId, input.contactId);
    const m = this.#messages.get(input.messageId); if (!m || m.contactId !== input.contactId) fail('NOT_FOUND'); if (m.version !== input.expectedVersion) fail('CONFLICT_VERSION');
    const next: Message = { ...m, contentRef: undefined, mediaId: undefined, deletionStatus: 'deleted', version: m.version + 1, updatedAt: this.#now() }; this.#messages.set(m.id, next);
    for (const f of [...this.#facts.values()]) if (f.evidenceRefs.some(r => r.id === m.id) && f.deletionStatus === 'active') this.deleteFact({ factId: f.id, expectedVersion: f.version });
    for (const a of [...this.#analyses.values()]) if (a.dependencySet.some(r => r.id === m.id) && a.status === 'valid') this.invalidateAnalysis(a.id);
    this.#emit('EvidenceInvalidated', { id: m.id, version: next.version }, m.contactId); return out(next);
  }
  storeAnalysisSnapshot(input: { contactId: string; analysisVersion: string; cutoff: string; claims: readonly unknown[]; dependencySet: readonly Ref[] }): Analysis {
    this.#contact(input.contactId); if (!required(input.analysisVersion) || !timestamp(input.cutoff)) fail('VALIDATION_FAILED');
    for (const ref of input.dependencySet) {
      const m = this.#messages.get(ref.id); const f = this.#facts.get(ref.id);
      if (m && (m.contactId !== input.contactId || m.version !== ref.version || m.deletionStatus !== 'active' || m.sentAt > input.cutoff || m.actor === 'agent')) fail('VALIDATION_FAILED');
      if (f && (f.scope !== 'global' && f.scope !== input.contactId || f.version !== ref.version || f.deletionStatus !== 'active' || f.confirmationStatus !== 'confirmed' || f.validFrom > input.cutoff || (f.validUntil && input.cutoff >= f.validUntil))) fail('VALIDATION_FAILED');
      if (!m && !f) fail('VALIDATION_FAILED');
    }
    const t = this.#now(); const a: Analysis = { ...copy(input), id: id(this.clock()), status: 'valid', version: 1, createdAt: t, updatedAt: t };
    this.#analyses.set(a.id, a); this.#emit('AnalysisChanged', { id: a.id, version: a.version }, a.contactId); return out(a);
  }
  invalidateAnalysis(analysisId: string): Analysis {
    const a = this.#analyses.get(analysisId); if (!a) fail('NOT_FOUND'); if (a.status === 'invalid') return out(a);
    const next: Analysis = { ...a, status: 'invalid', version: a.version + 1, updatedAt: this.#now() }; this.#analyses.set(a.id, next); this.#emit('AnalysisChanged', { id: a.id, version: next.version }, a.contactId); return out(next);
  }
  #invalidateFactAnalyses(factId: string): void {
    for (const a of [...this.#analyses.values()]) if (a.status === 'valid' && a.dependencySet.some(r => r.id === factId)) this.invalidateAnalysis(a.id);
  }
  buildContext(input: BuildContext): ContextProjection {
    const c = this.#authorize(input.callerContactId, input.contactId);
    if (!Number.isSafeInteger(input.generation) || input.generation < 0 || !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1 || !timestamp(input.cutoffTime)) fail('VALIDATION_FAILED');
    const messages = this.queryMessages({ ...input, mode: input.mode });
    const facts = this.queryFacts({ ...input, asOf: input.cutoffTime });
    const analyses = [...this.#analyses.values()].filter(a => a.contactId === c.id && a.status === 'valid' && a.cutoff <= input.cutoffTime && a.dependencySet.every(r => this.#messages.get(r.id)?.version === r.version || this.#facts.get(r.id)?.version === r.version)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const lastAnalysis = analyses[0];
    const t = this.#now(); const refs = (rows: readonly { id: string; version: number }[]) => rows.map(r => ({ id: r.id, version: r.version }));
    const core = { contactId: c.id, conversationId: c.conversationId, generation: input.generation, cutoffMessageId: input.cutoffMessageId, cutoffTime: input.cutoffTime, messageRefs: refs(messages), summaryRefs: [], factRefs: refs(facts), analysisRefs: lastAnalysis ? refs([lastAnalysis]) : [], policyVersion: input.policyVersion };
    const snapshot: ContextSnapshot = { ...core, id: id(this.clock()), hash: hash({ ...core, messageContent: messages.map(m => [m.id, m.contentRef, m.mediaId]), factContent: facts.map(f => [f.id, f.content]) }), createdAt: t, updatedAt: t };
    this.#snapshots.set(snapshot.id, snapshot);
    return this.readContextProjection({ callerContactId: input.callerContactId, contactId: input.contactId, snapshotId: snapshot.id, allowedScopes: input.allowedScopes });
  }
  readContextProjection(input: { callerContactId: string; contactId: string; snapshotId: string; allowedScopes: readonly string[] }): ContextProjection {
    this.#authorize(input.callerContactId, input.contactId);
    if (!Array.isArray(input.allowedScopes)) fail('VALIDATION_FAILED');
    const snapshot = this.#snapshots.get(input.snapshotId); if (!snapshot || snapshot.contactId !== input.contactId) fail('NOT_FOUND');
    if (this.#invalid.has(snapshot.id)) fail('STALE_CONTEXT');
    const messages = snapshot.messageRefs.map(r => this.#messages.get(r.id)).filter((m): m is Message => !!m);
    const facts = snapshot.factRefs.map(r => this.#facts.get(r.id)).filter((f): f is Fact => !!f);
    const analyses = snapshot.analysisRefs.map(r => this.#analyses.get(r.id)).filter((a): a is Analysis => !!a);
    const allowed = new Set(input.allowedScopes.filter(s => s === 'global' || s === input.contactId));
    if (messages.length !== snapshot.messageRefs.length || facts.length !== snapshot.factRefs.length || analyses.length !== snapshot.analysisRefs.length || messages.some((m, i) => m.version !== snapshot.messageRefs[i]!.version || m.deletionStatus !== 'active') || facts.some((f, i) => f.version !== snapshot.factRefs[i]!.version || f.deletionStatus !== 'active' || f.confirmationStatus !== 'confirmed' || !allowed.has(f.scope) || (f.validUntil && f.validUntil <= this.#now())) || analyses.some((a, i) => a.version !== snapshot.analysisRefs[i]!.version || a.status !== 'valid')) fail('STALE_CONTEXT');
    return out({ snapshot, messages, facts, analyses });
  }
  isContextCurrent(snapshotId: string, allowedScopes: readonly string[]): boolean {
    const s = this.#snapshots.get(snapshotId); if (!s) return false;
    try { this.readContextProjection({ callerContactId: s.contactId, contactId: s.contactId, snapshotId, allowedScopes }); return true; } catch { return false; }
  }
}
