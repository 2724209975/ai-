/** In-memory G1 reference implementation. Production persistence belongs to G0/03 integration. */
import { createHash, randomBytes } from 'node:crypto';
import type { Event, MockPlatformAdapter, SendEnvelope, SendResult } from '../../platform/mock/adapter.mts';
import { defaultPolicy, routeReply, type Policy, type Risk } from '../policy/evaluate.mts';

export type Part = { replyPartId: string; sequence: number; type: 'text'; content: string };
export type Alternative = { alternativeId: string; strategySummary: string; parts: Part[] };
export type ProposedAlternative = { key: string; strategySummary: string; parts: { key: string; sequence: number; type: 'text'; content: string }[] };
export type Context = { id: string; conversationId: string; generation: number; policyVersion: number; hash: string; messageRefs: string[]; factRefs: string[]; analysisRefs: string[]; messages: { id: string; text: string; actor: 'contact' | 'owner' | 'agent' | 'unknown' }[] };
export type Draft = { shouldReply: boolean; risks: Risk[]; alternatives: ProposedAlternative[]; generatorVersion: string; promptVersion?: string; timing: 'now' | 'wait' | 'no_reply'; factVersions?: Record<string, number>; analysisVersions?: Record<string, number>; skillVersions?: Record<string, number> };
export type DataPort = { appendObservedMessage(event: Event): Promise<{ id: string; inserted: boolean }>; buildContext(contactId: string, conversationId: string, generation: number, policy: Policy): Promise<Context> };
export type IntelligencePort = { propose(context: Context, policy: Policy): Promise<Draft>; checkEdited?(contextSnapshotId: string, policy: Policy, editedParts: readonly { type: 'text'; content: string }[]): { allowed: boolean; reasons: string[] } };
export type PlanStatus = 'AWAITING_CONFIRMATION' | 'APPROVED' | 'SENDING' | 'PARTIALLY_SENT' | 'SENT' | 'INVALIDATED' | 'REJECTED' | 'FAILED' | 'RESULT_UNKNOWN';
export type SendStatus = 'CREATED' | 'SUBMITTING' | 'SUBMITTED' | 'DELIVERED' | 'CANCELLED_PRE_SUBMIT' | 'FAILED_DEFINITE' | 'RESULT_UNKNOWN';
export type SendTask = { id: string; planId: string; replyPartId: string; sequence: number; sendKey: string; content: string; status: SendStatus; receipt?: SendResult };
export type Plan = { id: string; version: number; conversationId: string; contactId: string; contextSnapshotId: string; generation: number; policyVersion: number; triggerMessageIds: string[]; factVersions: Record<string, number>; analysisVersions: Record<string, number>; skillVersions: Record<string, number>; risks: Risk[]; alternatives: Alternative[]; status: PlanStatus; invalidationReasons: string[]; task?: { id: string; version: number; status: 'PENDING' | 'RESOLVED' | 'INVALIDATED' | 'REJECTED'; reasonCodes: string[] }; sends: SendTask[]; approvedAlternativeId?: string; finalContentHash?: string };
type Conversation = { contactId: string; conversationId: string; accountId: string; externalContactRef: string; policy: Policy; revision: number; generation: number; state: string; pauseReasons: string[]; lastInboundMessageId?: string; collection?: { startedAt: number; dueAt: number; messageIds: string[] }; generatingGeneration?: number; unresolvedSendId?: string; plans: Plan[]; seen: Set<string> };

function uid(now: number): string {
  const b = randomBytes(16); b.writeUIntBE(Math.max(0, Math.trunc(now)), 0, 6);
  b[6] = (b[6]! & 15) | 0x70; b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function contentHash(parts: readonly { type: string; content: string }[]): string {
  return createHash('sha256').update(JSON.stringify(parts.map(p => ({ type: p.type, content: p.content })))).digest('hex');
}
export class OrchestrationError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export class Orchestrator {
  readonly #rows = new Map<string, Conversation>();
  readonly #idempotency = new Map<string, { planId: string; fingerprint: string }>();
  readonly #data: DataPort; readonly #ai: IntelligencePort; readonly #platform: MockPlatformAdapter;
  readonly #authority: object; readonly #now: () => number; readonly #aggregationWindowMs: number; readonly #maxAggregationMs: number;
  #globalPaused = false; #globalEpoch = 0;
  constructor(options: { data: DataPort; intelligence: IntelligencePort; platform: MockPlatformAdapter; authority: object; now?: () => number; aggregationWindowMs?: number; maxAggregationMs?: number }) {
    this.#data = options.data; this.#ai = options.intelligence; this.#platform = options.platform;
    this.#authority = options.authority; this.#now = options.now ?? Date.now;
    this.#aggregationWindowMs = options.aggregationWindowMs ?? 0;
    this.#maxAggregationMs = options.maxAggregationMs ?? 30_000;
    if (!Number.isFinite(this.#aggregationWindowMs) || this.#aggregationWindowMs < 0 || !Number.isFinite(this.#maxAggregationMs) || this.#maxAggregationMs < this.#aggregationWindowMs) throw new OrchestrationError('VALIDATION_FAILED');
  }
  enrollContact(input: { contactId: string; conversationId: string; accountId: string; externalContactRef: string; timezone: string; goal: string }): Policy {
    if (this.#rows.has(input.conversationId)) throw new OrchestrationError('CONFLICT_VERSION');
    if (input.accountId !== this.#platform.accountId || !input.externalContactRef) throw new OrchestrationError('VALIDATION_FAILED');
    const policy = defaultPolicy(input.contactId, input.timezone, input.goal);
    this.#rows.set(input.conversationId, { contactId: input.contactId, conversationId: input.conversationId, accountId: input.accountId, externalContactRef: input.externalContactRef, policy, revision: 1, generation: 1, state: 'READY_CONFIRM', pauseReasons: [], plans: [], seen: new Set() });
    return structuredClone(policy);
  }
  #row(conversationId: string): Conversation { const row = this.#rows.get(conversationId); if (!row) throw new OrchestrationError('NOT_FOUND'); return row; }
  getConversation(conversationId: string) {
    const r = this.#row(conversationId);
    return structuredClone({ conversationId, contactId: r.contactId, policy: r.policy, control: { state: r.state, pauseReasons: r.pauseReasons, revision: r.revision, generation: r.generation, unresolvedSendId: r.unresolvedSendId }, plans: r.plans,
      allowedActions: this.#globalPaused ? [] : r.pauseReasons.length ? ['resumeContact'] : r.plans.some(p => p.task?.status === 'PENDING') ? ['confirmPlan', 'rejectPlan', 'pauseContact'] : ['pauseContact'] });
  }
  listPending() { return [...this.#rows.values()].flatMap(r => r.plans.filter(p => p.task?.status === 'PENDING').map(p => structuredClone(p))); }
  updatePolicy(conversationId: string, patch: Partial<Omit<Policy, 'contactId' | 'version'>>, expectedVersion: number): Policy {
    const r = this.#row(conversationId); if (r.policy.version !== expectedVersion) throw new OrchestrationError('CONFLICT_VERSION');
    const next = { ...r.policy, ...patch, contactId: r.contactId, version: r.policy.version + 1 };
    if (!['confirm', 'auto'].includes(next.sendMode) || !next.timezone || !next.goal) throw new OrchestrationError('VALIDATION_FAILED');
    r.policy = next; this.#invalidate(r, 'POLICY_CHANGED'); r.state = r.pauseReasons.length ? r.state : next.agentEnabled ? (next.sendMode === 'auto' ? 'READY_AUTO' : 'READY_CONFIRM') : 'DISABLED';
    return structuredClone(next);
  }
  #invalidate(r: Conversation, reason: string) {
    r.generation++; r.revision++;
    if (reason !== 'NEW_MESSAGE') r.collection = undefined;
    for (const p of r.plans) if (!['SENT', 'INVALIDATED', 'REJECTED', 'FAILED', 'RESULT_UNKNOWN'].includes(p.status)) {
      p.invalidationReasons.push(reason);
      if (p.sends.some(s => ['SUBMITTED', 'DELIVERED'].includes(s.status))) p.status = 'PARTIALLY_SENT'; else p.status = 'INVALIDATED';
      p.version++; if (p.task?.status === 'PENDING') { p.task.status = 'INVALIDATED'; p.task.version++; }
      for (const s of p.sends) if (s.status === 'CREATED') s.status = 'CANCELLED_PRE_SUBMIT';
    }
  }
  async ingestPlatformEvent(event: Event): Promise<Plan | undefined> {
    if (event.eventType === 'PlatformReceiptObserved') { this.applyReceipt(event); return; }
    const payload = event.payload as Record<string, unknown>;
    const ref = payload.conversationRef as { accountId: string; conversationId: string; externalContactRef: string } | undefined;
    if (!ref || event.aggregateId !== ref.conversationId || ref.accountId !== this.#platform.accountId) throw new OrchestrationError('VALIDATION_FAILED');
    const r = this.#rows.get(ref.conversationId); if (!r) return; // Outside enrollment: no AI/data side effect.
    if (ref.externalContactRef !== r.externalContactRef) throw new OrchestrationError('VALIDATION_FAILED');
    if ((event.eventType === 'PlatformInboundObserved' && !['contact', 'unknown'].includes(String(payload.actor)))
      || (event.eventType === 'PlatformOwnerMessageObserved' && payload.actor !== 'owner')
      || (event.eventType === 'PlatformAgentEchoObserved' && payload.actor !== 'agent')) throw new OrchestrationError('VALIDATION_FAILED');
    const key = `${ref.accountId}:${ref.conversationId}:${String(payload.mode ?? 'live')}:${String(payload.platformMessageId ?? event.eventId)}:${String(payload.mutation ?? 'message')}`;
    if (r.seen.has(key)) return;
    r.seen.add(key); // In production, inbox insert and all state changes are one transaction.
    if (event.eventType === 'PlatformAgentEchoObserved') { try { await this.#data.appendObservedMessage(event); } catch (error) { r.seen.delete(key); throw error; } return; }
    if (event.eventType !== 'PlatformInboundObserved' && event.eventType !== 'PlatformOwnerMessageObserved' && event.eventType !== 'PlatformSelfMessageUnattributed') return;
    let stored: { id: string; inserted: boolean };
    try { stored = await this.#data.appendObservedMessage(event); } catch (error) { r.seen.delete(key); throw error; }
    if (!stored.inserted) return;
    if (payload.mode !== 'live') return; // Historical/trial data never enters live conversation control.
    this.#invalidate(r, event.eventType === 'PlatformInboundObserved' ? 'NEW_MESSAGE' : 'OWNER_ORIGIN');
    if (event.eventType !== 'PlatformInboundObserved' || payload.actor === 'unknown') {
      if (!r.pauseReasons.includes('OWNER_ORIGIN')) r.pauseReasons.push('OWNER_ORIGIN');
      r.state = 'PAUSED_OWNER'; return;
    }
    if (payload.mode !== 'live' || !r.policy.agentEnabled || this.#globalPaused || r.pauseReasons.length) return;
    r.lastInboundMessageId = stored.id;
    const at = this.#now();
    const collection = r.collection ?? { startedAt: at, dueAt: at, messageIds: [] };
    collection.messageIds.push(stored.id);
    collection.dueAt = Math.min(at + this.#aggregationWindowMs, collection.startedAt + this.#maxAggregationMs);
    r.collection = collection;
    if (this.#aggregationWindowMs > 0 && collection.dueAt > at) { r.state = 'COLLECTING'; return; }
    return this.flushDue(r.conversationId);
  }
  /** Scheduler calls this with a virtual or real clock; repeated claims do not generate twice. */
  async flushDue(conversationId: string): Promise<Plan | undefined> {
    const r = this.#row(conversationId); const collection = r.collection;
    if (!collection || collection.dueAt > this.#now() || this.#globalPaused || r.pauseReasons.length || !r.policy.agentEnabled) return;
    const generation = r.generation; const policyVersion = r.policy.version;
    if (r.generatingGeneration === generation) return;
    r.generatingGeneration = generation; r.state = 'GENERATING';
    const triggerMessageIds = [...collection.messageIds];
    r.collection = undefined;
    try { return await this.#generate(r, generation, policyVersion, triggerMessageIds); }
    finally { if (r.generatingGeneration === generation) r.generatingGeneration = undefined; }
  }
  async #generate(r: Conversation, generation: number, policyVersion: number, triggerMessageIds: string[]): Promise<Plan | undefined> {
    let context: Context;
    try { context = await this.#data.buildContext(r.contactId, r.conversationId, generation, structuredClone(r.policy)); }
    catch (error) { if (r.generation === generation && r.policy.version === policyVersion) { r.state = 'PAUSED_FAILURE'; if (!r.pauseReasons.includes('CONTEXT_FAILURE')) r.pauseReasons.push('CONTEXT_FAILURE'); } throw error; }
    if (context.conversationId !== r.conversationId || context.generation !== generation || context.policyVersion !== policyVersion) throw new OrchestrationError('VALIDATION_FAILED');
    let draft: Draft;
    try { draft = await this.#ai.propose(structuredClone(context), structuredClone(r.policy)); }
    catch (error) { if (r.generation !== generation || r.policy.version !== policyVersion) return; r.state = 'PAUSED_FAILURE'; if (!r.pauseReasons.includes('MODEL_FAILURE')) r.pauseReasons.push('MODEL_FAILURE'); throw error; }
    if (r.generation !== generation || r.policy.version !== policyVersion || this.#globalPaused || r.pauseReasons.length) return;
    if (draft.risks.includes('stop_request') || draft.risks.includes('unknown_fact') || draft.risks.includes('media_uncertain')) {
      const reason = draft.risks.includes('stop_request') ? 'STOP_REQUEST' : draft.risks.includes('unknown_fact') ? 'MISSING_FACT' : 'MEDIA_UNCERTAIN';
      r.pauseReasons.push(reason); r.state = reason === 'STOP_REQUEST' ? 'PAUSED_STOP_REQUEST' : reason === 'MISSING_FACT' ? 'PAUSED_MISSING_FACT' : 'PAUSED_MEDIA'; return;
    }
    if (!draft.shouldReply || draft.timing !== 'now') { r.state = r.policy.sendMode === 'auto' ? 'READY_AUTO' : 'READY_CONFIRM'; return; }
    if (draft.alternatives.length < 1 || draft.alternatives.length > 3 || draft.alternatives.some(a => !a.key || a.parts.length < 1 || a.parts.some((p, index) => p.type !== 'text' || !p.content.trim() || p.sequence !== index + 1 || !p.key))) throw new OrchestrationError('VALIDATION_FAILED');
    // G1 has no independent risk/fact verifier. Model-provided risk labels cannot authorize auto send.
    const preliminary = routeReply(r.policy, draft.risks);
    const route = preliminary.kind === 'auto' ? { kind: 'confirm' as const, reasons: ['AUTO_REVIEW_UNAVAILABLE'] } : preliminary;
    if (route.kind === 'block') { r.pauseReasons.push(...route.reasons); r.state = 'PAUSED_STOP_REQUEST'; return; }
    const alternatives: Alternative[] = draft.alternatives.map(a => ({ alternativeId: uid(this.#now()), strategySummary: a.strategySummary, parts: a.parts.map(part => ({ replyPartId: uid(this.#now()), sequence: part.sequence, type: part.type, content: part.content })) }));
    const plan: Plan = { id: uid(this.#now()), version: 1, conversationId: r.conversationId, contactId: r.contactId, contextSnapshotId: context.id, generation, policyVersion, triggerMessageIds, factVersions: draft.factVersions ?? {}, analysisVersions: draft.analysisVersions ?? {}, skillVersions: draft.skillVersions ?? {}, risks: structuredClone(draft.risks), alternatives, status: route.kind === 'confirm' ? 'AWAITING_CONFIRMATION' : 'APPROVED', invalidationReasons: [], sends: [] };
    if (route.kind === 'confirm') { plan.task = { id: uid(this.#now()), version: 1, status: 'PENDING', reasonCodes: route.reasons }; r.state = 'AWAITING_CONFIRMATION'; }
    else { this.#createSends(plan, plan.alternatives[0]!); r.state = 'SCHEDULED'; }
    r.plans.push(plan); return structuredClone(plan);
  }
  #createSends(plan: Plan, alternative: Alternative, edited?: readonly { type: 'text'; content: string }[]) {
    const parts = edited ?? alternative.parts;
    plan.approvedAlternativeId = alternative.alternativeId; plan.finalContentHash = contentHash(parts);
    plan.sends = parts.map((p, index) => ({ id: uid(this.#now()), planId: plan.id, replyPartId: alternative.parts[index]!.replyPartId, sequence: index + 1, sendKey: uid(this.#now()), content: p.content, status: 'CREATED' }));
  }
  confirmPlan(command: { conversationId: string; planId: string; taskVersion: number; planVersion: number; alternativeId: string; editedParts: { type: 'text'; content: string }[]; contentHash: string; idempotencyKey: string }): Plan {
    const r = this.#row(command.conversationId); const idemKey = `${r.contactId}:${command.idempotencyKey}`;
    if (!command.idempotencyKey) throw new OrchestrationError('VALIDATION_FAILED');
    const fingerprint = createHash('sha256').update(JSON.stringify({ planId: command.planId, taskVersion: command.taskVersion, planVersion: command.planVersion, alternativeId: command.alternativeId, editedParts: command.editedParts, contentHash: command.contentHash })).digest('hex');
    const prior = this.#idempotency.get(idemKey); if (prior) { if (prior.planId !== command.planId || prior.fingerprint !== fingerprint) throw new OrchestrationError('CONFLICT_VERSION'); return structuredClone(r.plans.find(p => p.id === prior.planId)!); }
    const p = r.plans.find(x => x.id === command.planId); if (!p) throw new OrchestrationError('NOT_FOUND');
    if (this.#globalPaused || r.pauseReasons.length) throw new OrchestrationError('PAUSED');
    if (p.status !== 'AWAITING_CONFIRMATION' || p.version !== command.planVersion || p.task?.status !== 'PENDING' || p.task.version !== command.taskVersion || p.generation !== r.generation || p.policyVersion !== r.policy.version) throw new OrchestrationError('STALE_PLAN');
    const alternative = p.alternatives.find(a => a.alternativeId === command.alternativeId);
    if (!alternative || command.editedParts.length !== alternative.parts.length || command.editedParts.some(x => x.type !== 'text' || !x.content.trim()) || contentHash(command.editedParts) !== command.contentHash) throw new OrchestrationError('VALIDATION_FAILED');
    const editedCheck = this.#ai.checkEdited?.(p.contextSnapshotId, structuredClone(r.policy), command.editedParts);
    if (editedCheck && !editedCheck.allowed) throw new OrchestrationError(editedCheck.reasons.includes('MISSING_FACT') ? 'MISSING_FACT' : 'POLICY_BLOCKED');
    this.#createSends(p, alternative, command.editedParts); p.status = 'APPROVED'; p.version++; p.task.status = 'RESOLVED'; p.task.version++; r.state = 'SCHEDULED';
    this.#idempotency.set(idemKey, { planId: p.id, fingerprint }); return structuredClone(p);
  }
  rejectPlan(conversationId: string, planId: string, taskVersion: number) {
    const r = this.#row(conversationId); const p = r.plans.find(x => x.id === planId);
    if (!p || p.task?.status !== 'PENDING' || p.task.version !== taskVersion) throw new OrchestrationError('STALE_PLAN');
    p.task.status = 'REJECTED'; p.task.version++; p.status = 'REJECTED'; p.version++;
    r.state = r.policy.sendMode === 'auto' ? 'PAUSED_POLICY' : 'READY_CONFIRM';
    if (r.policy.sendMode === 'auto' && !r.pauseReasons.includes('CONFIRMATION_REJECTED')) r.pauseReasons.push('CONFIRMATION_REJECTED');
  }
  pauseContact(conversationId: string, reason = 'OWNER_PAUSE') { const r = this.#row(conversationId); if (!r.pauseReasons.includes(reason)) r.pauseReasons.push(reason); this.#invalidate(r, reason); r.state = 'PAUSED_POLICY'; }
  resumeContact(conversationId: string, reason = 'OWNER_PAUSE') {
    const r = this.#row(conversationId); if (r.unresolvedSendId) throw new OrchestrationError('SEND_RESULT_UNKNOWN');
    r.pauseReasons = r.pauseReasons.filter(x => x !== reason); this.#invalidate(r, 'RESUME_REBASE');
    r.state = r.pauseReasons.length ? 'PAUSED_POLICY' : r.policy.sendMode === 'auto' ? 'READY_AUTO' : 'READY_CONFIRM';
  }
  pauseAll() { this.#globalPaused = true; this.#globalEpoch++; for (const r of this.#rows.values()) { this.#invalidate(r, 'GLOBAL_PAUSE'); r.state = 'PAUSED_POLICY'; } }
  resumeAll() { this.#globalPaused = false; this.#globalEpoch++; for (const r of this.#rows.values()) { this.#invalidate(r, 'GLOBAL_RESUME_REBASE'); r.state = r.pauseReasons.length ? 'PAUSED_POLICY' : r.policy.sendMode === 'auto' ? 'READY_AUTO' : 'READY_CONFIRM'; } }
  /** Called by 03/05 event handlers after validating source/dependency ownership. */
  invalidateDependency(conversationId: string, reason: 'FACT_CHANGED' | 'ANALYSIS_CHANGED' | 'SKILL_CHANGED' | 'EVIDENCE_INVALIDATED') { this.#invalidate(this.#row(conversationId), reason); }
  async dispatchNext(conversationId: string): Promise<SendTask | undefined> {
    const r = this.#row(conversationId); const p = r.plans.find(x => ['APPROVED', 'SENDING', 'PARTIALLY_SENT'].includes(x.status) && x.sends.some(s => s.status === 'CREATED'));
    if (!p) return;
    const task = p.sends.find(s => s.status === 'CREATED')!;
    const check = () => !this.#globalPaused && !r.pauseReasons.length && !r.unresolvedSendId && r.policy.agentEnabled && p.generation === r.generation && p.policyVersion === r.policy.version && p.status !== 'INVALIDATED' && p.status !== 'RESULT_UNKNOWN' && p.finalContentHash === contentHash(p.sends.map(s => ({ type: 'text', content: s.content }))) && p.sends.filter(s => s.sequence < task.sequence).every(s => ['SUBMITTED', 'DELIVERED'].includes(s.status)) && (r.policy.sendMode === 'auto' ? routeReply(r.policy, p.risks).kind === 'auto' || p.task?.status === 'RESOLVED' : p.task?.status === 'RESOLVED');
    if (!check()) { task.status = 'CANCELLED_PRE_SUBMIT'; p.status = 'INVALIDATED'; p.version++; throw new OrchestrationError('STALE_PLAN'); }
    task.status = 'SUBMITTING'; p.status = 'SENDING'; p.version++;
    const envelope: SendEnvelope = { sendTaskId: task.id, sendKey: task.sendKey, conversationRef: { accountId: r.accountId, conversationId: r.conversationId, externalContactRef: r.externalContactRef }, partType: 'text', content: task.content, deadline: new Date(this.#now() + 30_000).toISOString(), mode: 'live', correlationId: uid(this.#now()) };
    const epoch = this.#globalEpoch;
    try {
      const result = await this.#platform.submitSend(envelope, this.#authority, async () => check() && epoch === this.#globalEpoch && task.status === 'SUBMITTING');
      task.receipt = result; task.status = result.status === 'RESULT_UNKNOWN' ? 'RESULT_UNKNOWN' : result.status === 'FAILED_DEFINITE' ? 'FAILED_DEFINITE' : result.status === 'DELIVERED' ? 'DELIVERED' : 'SUBMITTED';
      if (task.status === 'RESULT_UNKNOWN') { r.unresolvedSendId = task.id; if (!r.pauseReasons.includes('UNKNOWN_SEND')) r.pauseReasons.push('UNKNOWN_SEND'); r.state = 'PAUSED_UNKNOWN_SEND'; p.status = 'RESULT_UNKNOWN'; for (const later of p.sends) if (later.status === 'CREATED') later.status = 'CANCELLED_PRE_SUBMIT'; }
      else if (task.status === 'FAILED_DEFINITE') { p.status = 'FAILED'; if (!r.pauseReasons.includes('SEND_FAILURE')) r.pauseReasons.push('SEND_FAILURE'); r.state = 'PAUSED_FAILURE'; for (const later of p.sends) if (later.status === 'CREATED') later.status = 'CANCELLED_PRE_SUBMIT'; }
      else if (p.sends.every(s => ['SUBMITTED', 'DELIVERED'].includes(s.status))) {
        p.status = 'SENT';
        if (r.generation === p.generation && !r.pauseReasons.length && !this.#globalPaused) {
          if (r.policy.sendMode === 'auto' && p.task) { r.pauseReasons.push('AWAITING_MANUAL_RESUME'); r.state = 'PAUSED_POLICY'; }
          else r.state = r.policy.sendMode === 'auto' ? 'READY_AUTO' : 'READY_CONFIRM';
        }
      }
      else if (task.status === 'SUBMITTED' || task.status === 'DELIVERED') p.status = 'PARTIALLY_SENT';
    } catch (error) {
      if (task.status === 'SUBMITTING') {
        const code = error instanceof Error && 'info' in error ? (error as { info: { code: string } }).info.code : 'SEND_RESULT_UNKNOWN';
        if (['POLICY_BLOCKED', 'STALE_PLAN', 'UNSUPPORTED_CAPABILITY', 'PLATFORM_UNAVAILABLE', 'VALIDATION_FAILED'].includes(code)) { task.status = 'CANCELLED_PRE_SUBMIT'; p.status = 'INVALIDATED'; p.invalidationReasons.push(code); }
        else { task.status = 'RESULT_UNKNOWN'; p.status = 'RESULT_UNKNOWN'; r.unresolvedSendId = task.id; if (!r.pauseReasons.includes('UNKNOWN_SEND')) r.pauseReasons.push('UNKNOWN_SEND'); r.state = 'PAUSED_UNKNOWN_SEND'; for (const later of p.sends) if (later.status === 'CREATED') later.status = 'CANCELLED_PRE_SUBMIT'; }
      }
      throw error;
    }
    p.version++; return structuredClone(task);
  }
  applyReceipt(event: Event) {
    if (event.eventType !== 'PlatformReceiptObserved') return;
    const result = event.payload as unknown as SendResult & { sendKey: string };
    const r = this.#rows.get(event.aggregateId); if (!r) return;
    const p = r.plans.find(x => x.sends.some(s => s.id === result.sendTaskId && s.sendKey === result.sendKey)); if (!p) return;
    const s = p.sends.find(x => x.id === result.sendTaskId)!;
    const conflict = (): never => { if (!r.pauseReasons.includes('RECEIPT_CONFLICT')) r.pauseReasons.push('RECEIPT_CONFLICT'); r.state = 'PAUSED_FAILURE'; this.#invalidate(r, 'RECEIPT_CONFLICT'); throw new OrchestrationError('CONFLICT_VERSION'); };
    if (result.status === 'FAILED_DEFINITE' && ['SUBMITTED', 'DELIVERED'].includes(s.status)) conflict();
    if (s.status === 'DELIVERED' || (s.status === 'SUBMITTED' && result.status === 'SUBMITTED')) {
      if (result.platformMessageId && s.receipt?.platformMessageId && result.platformMessageId !== s.receipt.platformMessageId) conflict();
      return;
    }
    if (s.status === 'RESULT_UNKNOWN' && !['SUBMITTED', 'DELIVERED'].includes(result.status)) return;
    if (result.status === 'DELIVERED' || result.status === 'SUBMITTED') {
      if (!['SUBMITTING', 'SUBMITTED', 'RESULT_UNKNOWN'].includes(s.status)) conflict();
      if (result.platformMessageId && s.receipt?.platformMessageId && result.platformMessageId !== s.receipt.platformMessageId) conflict();
      const wasUnknown = s.status === 'RESULT_UNKNOWN';
      s.status = result.status; s.receipt = result;
      if (r.unresolvedSendId === s.id) {
        r.unresolvedSendId = undefined; r.pauseReasons = r.pauseReasons.filter(x => x !== 'UNKNOWN_SEND');
        if (!r.pauseReasons.includes('AWAITING_MANUAL_RESUME')) r.pauseReasons.push('AWAITING_MANUAL_RESUME');
        r.state = 'PAUSED_POLICY';
      } else if (wasUnknown) conflict();
      if (p.sends.every(x => ['SUBMITTED', 'DELIVERED'].includes(x.status))) p.status = 'SENT';
      p.version++;
    }
  }
}
