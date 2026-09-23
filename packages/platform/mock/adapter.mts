/** Offline mock only. Public literals are defined in packages/contracts v0.3.0. */
import { createHash, randomBytes } from 'node:crypto';

type Platform = 'wechat' | 'qq';
type Actor = 'owner' | 'contact' | 'agent' | 'unknown';
type PartType = 'text' | 'sticker_static' | 'sticker_animated';
type Status = 'SUBMITTING' | 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE' | 'RESULT_UNKNOWN';
export type ConversationRef = { accountId: string; conversationId: string; externalContactRef: string };
export type SendEnvelope = {
  sendTaskId: string; sendKey: string; conversationRef: ConversationRef;
  partType: PartType; content?: string; mediaRef?: string; replyTo?: string;
  deadline: string; mode: 'live' | 'import' | 'trial' | 'replay'; correlationId: string;
};
export type ErrorInfo = { code: string; message: string; retryable: boolean; correlationId: string };
export type SendResult = {
  adapter: 'mock'; sendTaskId: string; status: Status; correlationId: string;
  resultVersion: number; receiptLevel: 'unknown' | 'accepted' | 'delivered';
  platformMessageId?: string; error?: ErrorInfo;
};
export type Observation = {
  platformEventId: string; platformMessageId: string; conversationRef: ConversationRef;
  sentAt: string; type: 'text' | 'image' | 'voice' | 'sticker_static' | 'sticker_animated' | 'unsupported';
  contentRef?: string; mediaId?: string; quotedMessageId?: string;
  direction: 'incoming' | 'self';
  // Set only by trusted scenario driver. A raw platform field MUST NOT become owner evidence.
  verifiedOwnerEvidence?: string; rawEventRef: string;
  mutation?: 'recall' | 'edit'; mode: 'live' | 'import' | 'trial' | 'replay';
};
export type Event = {
  eventId: string; eventType: string; eventVersion: 1; occurredAt: string;
  correlationId: string; causationId: string; aggregateId: string; aggregateVersion: number;
  payload: Record<string, unknown>;
};
type Ledger = { fingerprint: string; envelope: SendEnvelope; result: SendResult };
export type MockState = { scope: { platform: Platform; accountId: string }; seen: string[]; events: Event[]; ledger: Record<string, Ledger>; sequence: number };
type MediaFixture = { bytes: Uint8Array; mime: string; completeness: 'complete' | 'partial' | 'unknown'; animated: boolean; frameCount?: number };
type Outcome = 'accepted' | 'definite_failure' | 'timeout';

function id(now: number): string {
  const b = randomBytes(16);
  b.writeUIntBE(Math.max(0, Math.trunc(now)), 0, 6);
  b[6] = (b[6]! & 15) | 0x70; b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function hash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function required(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function time(value: string): boolean { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value)); }

export class PlatformError extends Error {
  info: ErrorInfo;
  constructor(code: string, correlationId: string, retryable = false) {
    super(code); this.info = { code, message: code, retryable, correlationId };
  }
}

/** In-memory deterministic simulator, NEVER a durable production store or real connector. */
export class MockPlatformAdapter {
  #state: MockState;
  #connection: 'DISCONNECTED' | 'RECONCILING' | 'CONNECTED' | 'RELOGIN_REQUIRED' = 'DISCONNECTED';
  #epoch = 0;
  #observedVersions = new Map<string, number>();
  #authority: object;
  #clock: () => number;
  #media = new Map<string, MediaFixture>();
  #approval: (ref: string, platform: Platform) => boolean;
  #outcomes: Outcome[] = [];
  #disabled = new Set<PartType>();
  #submissions = 0;
  readonly platform: Platform;
  readonly accountId: string;

  constructor(options: { platform: Platform; accountId: string; authority: object; clock?: () => number; state?: MockState; approvedMedia?: (ref: string, platform: Platform) => boolean }) {
    if (!['wechat', 'qq'].includes(options.platform) || !required(options.accountId)) throw new Error('invalid mock account');
    this.platform = options.platform; this.accountId = options.accountId;
    this.#authority = options.authority; this.#clock = options.clock ?? Date.now;
    this.#approval = options.approvedMedia ?? (() => false);
    if (options.state && (options.state.scope?.platform !== options.platform || options.state.scope?.accountId !== options.accountId)) throw new PlatformError('FORBIDDEN', 'mock');
    this.#state = structuredClone(options.state ?? { scope: { platform: options.platform, accountId: options.accountId }, seen: [], events: [], ledger: {}, sequence: 0 });
    // A crash after submit intent is ambiguous. Recovery never replays it.
    for (const row of Object.values(this.#state.ledger)) if (row.result.status === 'SUBMITTING') {
      row.result.status = 'RESULT_UNKNOWN'; row.result.receiptLevel = 'unknown';
      row.result.error = this.#error('SEND_RESULT_UNKNOWN', row.envelope.correlationId);
    }
  }
  #error(code: string, correlationId: string, retryable = false): ErrorInfo { return { code, message: code, retryable, correlationId }; }
  #emit(eventType: string, aggregateId: string, causationId: string, payload: Record<string, unknown>, correlationId = id(this.#clock())): Event {
    const event: Event = { eventId: id(this.#clock()), eventType, eventVersion: 1,
      occurredAt: new Date(this.#clock()).toISOString(), correlationId, causationId,
      aggregateId, aggregateVersion: ++this.#state.sequence, payload: { adapter: 'mock', platform: this.platform, accountId: this.accountId, ...payload } };
    this.#state.events.push(event); return structuredClone(event);
  }
  getCapabilities(accountId = this.accountId) {
    this.#account(accountId);
    return { id: id(this.#clock()), createdAt: new Date(this.#clock()).toISOString(), updatedAt: new Date(this.#clock()).toISOString(),
      accountId, adapterVersion: 'mock-0.1.0', observedAt: new Date(this.#clock()).toISOString(),
      receiveTypes: ['text', 'image', 'voice', 'sticker_static', 'sticker_animated'],
      sendTypes: ['text', 'sticker_static', 'sticker_animated'].filter(t => !this.#disabled.has(t as PartType)), receiptLevels: ['accepted', 'delivered'],
      ownerMessageSignal: 'synthetic_evidence_only', historySync: 'mock_snapshot_only', mediaFetch: 'fixture_only',
      constraints: ['NO_NETWORK', 'NO_REAL_LOGIN', 'NO_REAL_PLATFORM_VERIFICATION', 'IN_MEMORY_ONLY'], verificationStatus: 'unknown' };
  }
  #account(accountId: string) { if (accountId !== this.accountId) throw new PlatformError('FORBIDDEN', 'mock'); }
  getConnectionState(accountId = this.accountId) { this.#account(accountId); return { accountId, state: this.#connection, reloginRequired: this.#connection === 'RELOGIN_REQUIRED', adapter: 'mock', epoch: this.#epoch }; }
  setConnection(state: 'DISCONNECTED' | 'RECONCILING' | 'CONNECTED' | 'RELOGIN_REQUIRED') {
    if (!['DISCONNECTED', 'RECONCILING', 'CONNECTED', 'RELOGIN_REQUIRED'].includes(state)) throw new PlatformError('VALIDATION_FAILED', 'mock');
    if (state === 'CONNECTED' && this.#connection !== 'RECONCILING') throw new PlatformError('PLATFORM_UNAVAILABLE', 'mock');
    this.#connection = state; this.#epoch++;
    return this.#emit('PlatformConnectionChanged', this.accountId, this.accountId, this.getConnectionState());
  }
  reconcile(accountId = this.accountId, sinceCursor = '0') {
    this.#account(accountId);
    if (!/^\d+$/.test(sinceCursor) || Number(sinceCursor) > this.#state.sequence) throw new PlatformError('VALIDATION_FAILED', 'mock');
    this.setConnection('RECONCILING');
    return { adapter: 'mock', events: structuredClone(this.#state.events.filter(e => e.aggregateVersion > Number(sinceCursor))),
      cursor: String(this.#state.sequence), historyComplete: false,
      unresolvedSendKeys: Object.values(this.#state.ledger).filter(r => ['SUBMITTING', 'RESULT_UNKNOWN'].includes(r.result.status)).map(r => r.envelope.sendKey),
      requiresOrchestratorPreflight: true };
  }
  observe(input: Observation): Event | undefined {
    const x = structuredClone(input); this.#account(x.conversationRef?.accountId);
    if (![x.platformEventId, x.platformMessageId, x.conversationRef.conversationId, x.conversationRef.externalContactRef, x.rawEventRef].every(required) || !time(x.sentAt)
      || !['incoming', 'self'].includes(x.direction) || !['live', 'import', 'trial', 'replay'].includes(x.mode)
      || !['text', 'image', 'voice', 'sticker_static', 'sticker_animated', 'unsupported'].includes(x.type)
      || (x.mutation !== undefined && !['recall', 'edit'].includes(x.mutation))
      || (!x.mutation && (x.type === 'text' ? !required(x.contentRef) : x.type !== 'unsupported' && !required(x.mediaId)))) throw new PlatformError('VALIDATION_FAILED', 'mock');
    // Message keys cover two deliveries with different transport event IDs. Mutations have separate keys.
    const key = stable([this.platform, this.accountId, x.mode, x.conversationRef.conversationId, x.platformMessageId, x.mutation ?? 'message', x.mutation ? x.platformEventId : '']);
    if (this.#state.seen.includes(key)) return;
    const matched = Object.values(this.#state.ledger).find(r => r.result.platformMessageId === x.platformMessageId && r.envelope.conversationRef.conversationId === x.conversationRef.conversationId);
    const actor: Actor = x.direction === 'incoming' ? 'contact' : matched ? 'agent' : required(x.verifiedOwnerEvidence) ? 'owner' : 'unknown';
    const eventType = x.mutation ? 'PlatformMessageMutationObserved' : actor === 'owner' ? 'PlatformOwnerMessageObserved' : actor === 'agent' ? 'PlatformAgentEchoObserved' : actor === 'unknown' ? 'PlatformSelfMessageUnattributed' : 'PlatformInboundObserved';
    this.#state.seen.push(key);
    this.#observedVersions.set(x.conversationRef.conversationId, (this.#observedVersions.get(x.conversationRef.conversationId) ?? 0) + 1);
    return this.#emit(eventType, x.conversationRef.conversationId, x.platformEventId, {
      ...x, actor, ...(actor === 'unknown' ? { originStatus: 'unknown' } : {}), isAgentGenerated: actor === 'agent', receivedAt: new Date(this.#clock()).toISOString(),
      provenance: { source: 'synthetic_fixture', rawEventRef: x.rawEventRef, evidence: actor === 'agent' ? 'ledger_message_id' : actor === 'owner' ? x.verifiedOwnerEvidence : 'unverified_or_contact' },
      ...(matched ? { sendKey: matched.envelope.sendKey, sendTaskId: matched.envelope.sendTaskId } : {}),
      requiresReview: actor === 'unknown' || x.type === 'unsupported',
    });
  }
  queueOutcome(outcome: Outcome) { this.#outcomes.push(outcome); }
  disableCapability(type: PartType) { this.#disabled.add(type); }
  get submissionCount() { return this.#submissions; }
  snapshot(): MockState { return structuredClone(this.#state); }
  events(): Event[] { return structuredClone(this.#state.events); }

  async submitSend(input: SendEnvelope, authority: object, preflight: (envelope: SendEnvelope) => Promise<boolean> = async () => false): Promise<SendResult> {
    const x = structuredClone(input);
    if (authority !== this.#authority) throw new PlatformError('FORBIDDEN', x.correlationId);
    this.#account(x.conversationRef?.accountId);
    if (![x.sendTaskId, x.sendKey, x.correlationId, x.conversationRef.conversationId, x.conversationRef.externalContactRef].every(required) || !time(x.deadline)) throw new PlatformError('VALIDATION_FAILED', x.correlationId);
    if (x.mode !== 'live') throw new PlatformError('POLICY_BLOCKED', x.correlationId);
    if (!['text', 'sticker_static', 'sticker_animated'].includes(x.partType)) throw new PlatformError('UNSUPPORTED_CAPABILITY', x.correlationId);
    if (x.partType === 'text' ? !required(x.content) || x.mediaRef !== undefined : !required(x.mediaRef) || x.content !== undefined) throw new PlatformError('VALIDATION_FAILED', x.correlationId);
    const fingerprint = hash(x);
    const ledgerKey = hash(x.sendKey);
    const existing = this.#state.ledger[ledgerKey];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PlatformError('CONFLICT_VERSION', x.correlationId);
      return structuredClone(existing.result);
    }
    if (Object.values(this.#state.ledger).some(r => r.envelope.sendTaskId === x.sendTaskId)) throw new PlatformError('CONFLICT_VERSION', x.correlationId);
    const epoch = this.#epoch;
    const observedVersion = this.#observedVersions.get(x.conversationRef.conversationId) ?? 0;
    // The injected 02 preflight owns business decisions. Not a request-provided boolean.
    if (!await preflight(structuredClone(x))) throw new PlatformError('POLICY_BLOCKED', x.correlationId);
    // Another concurrent caller may have committed the same key while preflight awaited.
    const raced = this.#state.ledger[ledgerKey];
    if (raced) {
      if (raced.fingerprint !== fingerprint) throw new PlatformError('CONFLICT_VERSION', x.correlationId);
      return structuredClone(raced.result);
    }
    if (Object.values(this.#state.ledger).some(r => r.envelope.sendTaskId === x.sendTaskId)) throw new PlatformError('CONFLICT_VERSION', x.correlationId);
    if (this.#connection !== 'CONNECTED' || epoch !== this.#epoch) throw new PlatformError('PLATFORM_UNAVAILABLE', x.correlationId);
    if (observedVersion !== (this.#observedVersions.get(x.conversationRef.conversationId) ?? 0)) throw new PlatformError('STALE_PLAN', x.correlationId);
    if (Date.parse(x.deadline) <= this.#clock()) throw new PlatformError('STALE_PLAN', x.correlationId);
    if (this.#disabled.has(x.partType)) throw new PlatformError('UNSUPPORTED_CAPABILITY', x.correlationId);
    if (Object.values(this.#state.ledger).some(r => r.envelope.conversationRef.conversationId === x.conversationRef.conversationId && ['SUBMITTING', 'RESULT_UNKNOWN'].includes(r.result.status))) throw new PlatformError('SEND_RESULT_UNKNOWN', x.correlationId);
    if (x.partType !== 'text' && !this.#approval(x.mediaRef!, this.platform)) throw new PlatformError('POLICY_BLOCKED', x.correlationId);
    // No real platform call. The claim and result are synchronous in this simulator.
    const result: SendResult = { adapter: 'mock', sendTaskId: x.sendTaskId, status: 'SUBMITTING', correlationId: x.correlationId, resultVersion: 1, receiptLevel: 'unknown' };
    this.#state.ledger[ledgerKey] = { fingerprint, envelope: x, result }; this.#submissions++;
    const outcome = this.#outcomes.shift() ?? 'accepted';
    if (outcome === 'timeout') { result.status = 'RESULT_UNKNOWN'; result.error = this.#error('SEND_RESULT_UNKNOWN', x.correlationId); }
    else if (outcome === 'definite_failure') { result.status = 'FAILED_DEFINITE'; result.error = this.#error('PLATFORM_UNAVAILABLE', x.correlationId, true); }
    else { result.status = 'SUBMITTED'; result.receiptLevel = 'accepted'; result.platformMessageId = `mock:${id(this.#clock())}`; }
    this.#emit('PlatformReceiptObserved', x.conversationRef.conversationId, x.sendTaskId, { ...result, sendKey: x.sendKey }, x.correlationId);
    return structuredClone(result);
  }
  /** Scenario driver supplies actual receipt evidence; never inferred from elapsed time. */
  resolveReceipt(sendKey: string, status: 'SUBMITTED' | 'DELIVERED', platformMessageId: string) {
    const row = this.#state.ledger[hash(sendKey)];
    if (!row || !required(platformMessageId) || !['SUBMITTED', 'DELIVERED'].includes(status)) throw new PlatformError('VALIDATION_FAILED', 'mock');
    if (row.result.status === 'FAILED_DEFINITE' || (row.result.platformMessageId && row.result.platformMessageId !== platformMessageId)) throw new PlatformError('CONFLICT_VERSION', row.envelope.correlationId);
    if (row.result.status === 'DELIVERED' || (row.result.status === status && row.result.platformMessageId === platformMessageId)) return structuredClone(row.result);
    row.result.status = status; row.result.platformMessageId = platformMessageId; row.result.receiptLevel = status === 'DELIVERED' ? 'delivered' : 'accepted'; row.result.resultVersion++; delete row.result.error;
    this.#emit('PlatformReceiptObserved', row.envelope.conversationRef.conversationId, row.envelope.sendTaskId, { ...row.result, sendKey }, row.envelope.correlationId);
    return structuredClone(row.result);
  }
  cancelSubmitted(sendKey: string) {
    const row = this.#state.ledger[hash(sendKey)];
    if (!row) return { cancelled: false, error: this.#error('NOT_FOUND', 'mock') };
    return { cancelled: false, status: row.result.status, error: this.#error('UNSUPPORTED_CAPABILITY', row.envelope.correlationId) };
  }
  addMediaFixture(ref: string, fixture: MediaFixture) { this.#media.set(ref, structuredClone(fixture)); }
  fetchMedia(ref: string) {
    const fixture = this.#media.get(ref);
    if (!fixture) return { adapter: 'mock', fetchStatus: 'unavailable', error: this.#error('UNSUPPORTED_CAPABILITY', 'mock'), completeness: 'unknown' };
    const complete = fixture.bytes.length > 0 && fixture.completeness === 'complete' && (!fixture.animated || (fixture.frameCount ?? 0) > 1);
    return { adapter: 'mock', fetchStatus: complete ? 'complete' : 'partial', completeness: complete ? 'complete' : 'partial',
      ...(complete ? {} : { error: this.#error('MEDIA_UNCERTAIN', 'mock') }),
      bytes: new Uint8Array(fixture.bytes), sha256: createHash('sha256').update(fixture.bytes).digest('hex'),
      platformMetadata: { mime: fixture.mime, byteLength: fixture.bytes.length, animated: fixture.animated, frameCount: fixture.frameCount, evidence: 'fixture_metadata_only' } };
  }
}
