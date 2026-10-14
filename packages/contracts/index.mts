/** Public v0.3.0 wire literals. docs/contracts.md defines their semantics. */
export const CONTRACT_VERSION = '0.3.0' as const;
export const modes = ['live', 'import', 'trial', 'replay'] as const;
export const actors = ['owner', 'contact', 'agent', 'system', 'platform', 'unknown'] as const;
export const messageTypes = ['text', 'image', 'voice', 'sticker_static', 'sticker_animated', 'unsupported'] as const;
export const sendStates = ['CREATED', 'PREFLIGHT', 'LEASED', 'SUBMITTING', 'SUBMITTED', 'DELIVERED', 'CANCELLED_PRE_SUBMIT', 'REJECTED_PREFLIGHT', 'FAILED_DEFINITE', 'RESULT_UNKNOWN'] as const;
/** Owner projection availability. A missing field reads as `unavailable`: an empty array is not proof. */
export const queryStatuses = ['ready', 'unavailable'] as const;
export const platformConnectionStates = ['disconnected', 'connecting', 'relogin_required', 'reconciling', 'connected', 'degraded'] as const;
/** Per-capability evidence levels (contracts.md §2): `documented` is a vendor statement, `tested`
 * must come from this project against the target account. */
export const capabilityStatuses = ['documented', 'tested', 'unsupported', 'unknown'] as const;
export const capabilityFamilies = ['receive_types', 'send_types', 'receipt_levels', 'owner_message_signal', 'history_sync', 'media_fetch'] as const;
export const eventTypes = ['PlatformInboundObserved', 'PlatformOwnerMessageObserved', 'PlatformSelfMessageUnattributed', 'PlatformAgentEchoObserved', 'PlatformOriginResolved', 'PlatformReceiptObserved', 'PlatformConnectionChanged', 'PlatformMessageMutationObserved', 'ContactPolicyChanged', 'GlobalPauseChanged', 'ContactControlChanged', 'FactChanged', 'EvidenceInvalidated', 'AnalysisChanged', 'SkillVersionChanged', 'GrantChanged', 'ReplyPlanProposed', 'ReplyPlanInvalidated', 'SendTaskStateChanged'] as const;
export type Mode = typeof modes[number];
export type Actor = typeof actors[number];
export type MessageType = typeof messageTypes[number];
export type SendState = typeof sendStates[number];
export type QueryStatus = typeof queryStatuses[number];
export type PlatformConnectionState = typeof platformConnectionStates[number];
export type CapabilityStatus = typeof capabilityStatuses[number];
export type CapabilityFamily = typeof capabilityFamilies[number];
export type EventType = typeof eventTypes[number];

export interface EventEnvelope<T extends EventType = EventType, P = unknown> {
  eventId: string; eventType: T; eventVersion: number; occurredAt: string;
  correlationId: string; causationId: string; aggregateId: string;
  aggregateVersion: number; payload: P;
}
export interface PlatformSelfMessageUnattributedPayload {
  platform: 'wechat' | 'qq'; accountId: string; conversationRef: { accountId: string; conversationId: string; externalContactRef: string };
  platformEventId: string; platformMessageId: string; sentAt: string; receivedAt: string;
  type: MessageType; contentRef?: string; mediaId?: string; rawEventRef: string;
  actor: 'unknown'; originStatus: 'unknown'; isAgentGenerated: false;
  provenance: { source: string; rawEventRef: string; evidence?: string };
  mode: Mode;
}
export interface RecoveryReport {
  accountId: string; bridgeSessionId: string; previousCursor: string | null;
  verifiedFromCursor: string | null; verifiedToCursor: string | null;
  coverage: 'complete' | 'partial' | 'none' | 'unknown'; historyComplete: boolean;
  durableNextCursor: string | null; gaps: { conversationId: string | null; reason: string }[];
  unresolvedSends: { conversationId: string; sendKey: string; evidenceStatus: 'unknown' | 'accepted' | 'delivered' | 'definitely_not_sent'; platformMessageId?: string }[];
  reviewConversationIds: string[]; sourceRef: string;
}
export interface VersionRef { id: string; version: number }
export interface MediaInterpretationRef extends VersionRef {
  completeness: 'complete' | 'partial' | 'unavailable' | 'unknown';
  coverage: 'full_image' | 'temporal_sequence' | 'complete_transcript' | 'partial' | 'unknown';
  evidenceRefs: VersionRef[]; correctedByOwner: boolean;
}
export interface ContextMessageRef extends VersionRef {
  type: MessageType; mediaInterpretation?: MediaInterpretationRef;
  originEvidenceRef?: string;
}
export interface ConfirmPlanCommand {
  taskVersion: number; planVersion: number; alternativeId: string;
  editedParts: { type: 'text' | 'approved_sticker'; content?: string; mediaAssetId?: string }[];
  contentHash: string; idempotencyKey: string;
}
export interface OwnerResource {
  id: string; version: number; status: string; allowedActions: string[];
  reasonCodes?: string[]; invalidationReason?: string; correlationId?: string;
}
export interface OwnerConnectionRecovery {
  status: 'complete' | 'partial' | 'none' | 'unknown'; historyComplete: boolean;
  unresolvedSendCount?: number; gaps?: string[];
}
export interface OwnerConnection {
  accountId: string; platform: 'wechat' | 'qq' | 'unknown'; connectionState: PlatformConnectionState | 'unknown' | 'probe_healthy';
  capabilitySnapshotId?: string; verificationStatus?: 'documented' | 'tested' | 'unsupported' | 'unknown';
  lastReconciledAt?: string; limitations?: string[]; recovery?: OwnerConnectionRecovery;
}
export interface OwnerFault { id: string; status: string; summary: string }
export interface PlatformCapabilityEvidence {
  capability: CapabilityFamily; status: CapabilityStatus; sourceRef: string;
  observedAt: string; adapterVersion: string; constraints: string[]; unavailableReason?: string;
}
export interface PlatformCapabilitySnapshot {
  accountId: string; platform: 'wechat' | 'qq'; adapterVersion: string; observedAt: string;
  receiveTypes: MessageType[]; sendTypes: ('text' | 'sticker_static' | 'sticker_animated')[];
  receiptLevels: ('accepted' | 'delivered')[]; ownerMessageSignal: string; historySync: string; mediaFetch: string;
  constraints: string[]; verificationStatus: CapabilityStatus; evidence: PlatformCapabilityEvidence[];
}
/** The overall status is derived from the per-capability evidence, never declared on its own:
 * it can only be as strong as the weakest required capability. */
export function capabilityOverallStatus(evidence: readonly PlatformCapabilityEvidence[]): CapabilityStatus {
  const byFamily = new Map(evidence.map(item => [item.capability, item.status]));
  if (capabilityFamilies.some(family => !byFamily.has(family))) return 'unknown';
  const statuses = capabilityFamilies.map(family => byFamily.get(family)!);
  if (statuses.every(status => status === 'tested')) return 'tested';
  if (statuses.every(status => status === 'documented' || status === 'tested')) return 'documented';
  if (statuses.some(status => status === 'unsupported')) return 'unsupported';
  return 'unknown';
}
function rfc3339Z(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value));
}
/** Validates one snapshot. `tested` may not cite a vendor URL, and the overall status must equal the
 * derived one, so a report cannot quietly upgrade a documented statement into measured behaviour. */
export function assertCapabilitySnapshot(value: unknown): asserts value is PlatformCapabilitySnapshot {
  if (!value || typeof value !== 'object') throw new Error('VALIDATION_FAILED');
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.accountId !== 'string' || !snapshot.accountId.trim()) throw new Error('VALIDATION_FAILED');
  if (!['wechat', 'qq'].includes(snapshot.platform as string)) throw new Error('VALIDATION_FAILED');
  if (typeof snapshot.adapterVersion !== 'string' || !snapshot.adapterVersion.trim() || !rfc3339Z(snapshot.observedAt)) throw new Error('VALIDATION_FAILED');
  for (const key of ['receiveTypes', 'sendTypes', 'receiptLevels', 'constraints']) {
    if (!Array.isArray(snapshot[key])) throw new Error('VALIDATION_FAILED');
  }
  for (const key of ['ownerMessageSignal', 'historySync', 'mediaFetch']) {
    if (typeof snapshot[key] !== 'string' || !(snapshot[key] as string).trim()) throw new Error('VALIDATION_FAILED');
  }
  if (!(capabilityStatuses as readonly string[]).includes(snapshot.verificationStatus as string)) throw new Error('VALIDATION_FAILED');
  if (!Array.isArray(snapshot.evidence) || !snapshot.evidence.length) throw new Error('VALIDATION_FAILED');
  const seen = new Set<string>();
  for (const item of snapshot.evidence as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') throw new Error('VALIDATION_FAILED');
    if (!(capabilityFamilies as readonly string[]).includes(item.capability as string)) throw new Error('VALIDATION_FAILED');
    if (!(capabilityStatuses as readonly string[]).includes(item.status as string)) throw new Error('VALIDATION_FAILED');
    if (typeof item.sourceRef !== 'string' || !item.sourceRef.trim()) throw new Error('VALIDATION_FAILED');
    // A vendor page cannot prove this project measured the behaviour.
    if (item.status === 'tested' && /^https?:\/\//i.test(item.sourceRef)) throw new Error('VALIDATION_FAILED');
    if (!rfc3339Z(item.observedAt) || typeof item.adapterVersion !== 'string' || !item.adapterVersion.trim()) throw new Error('VALIDATION_FAILED');
    if (!Array.isArray(item.constraints)) throw new Error('VALIDATION_FAILED');
    if (item.unavailableReason !== undefined && (typeof item.unavailableReason !== 'string' || !item.unavailableReason.trim())) throw new Error('VALIDATION_FAILED');
    if (seen.has(item.capability as string)) throw new Error('VALIDATION_FAILED');
    seen.add(item.capability as string);
  }
  if (snapshot.verificationStatus !== capabilityOverallStatus(snapshot.evidence as PlatformCapabilityEvidence[])) throw new Error('VALIDATION_FAILED');
}
/** Owner overview projection (contracts.md §3). Availability is explicit: an empty array alone
 * never means "connected" or "no faults". */
export interface OwnerOverviewProjection {
  id: string; version: number; status: 'ACTIVE' | 'PAUSED'; globalPaused: boolean;
  allowedActions: string[]; pendingCount: number; unknownSendCount: number;
  connectionQueryStatus?: QueryStatus; faultQueryStatus?: QueryStatus;
  connections?: OwnerConnection[]; faults?: OwnerFault[];
}
/** Missing, malformed or unknown availability reads as `unavailable`, never as `ready`. */
export function overviewQueryStatus(projection: OwnerOverviewProjection, kind: 'connection' | 'fault'): QueryStatus {
  const value = kind === 'connection' ? projection.connectionQueryStatus : projection.faultQueryStatus;
  return value === 'ready' ? 'ready' : 'unavailable';
}
export function assertOwnerOverview(value: unknown): asserts value is OwnerOverviewProjection {
  if (!value || typeof value !== 'object') throw new Error('VALIDATION_FAILED');
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id.trim()) throw new Error('VALIDATION_FAILED');
  for (const key of ['version', 'pendingCount', 'unknownSendCount']) {
    if (!Number.isSafeInteger(o[key]) || (o[key] as number) < 0) throw new Error('VALIDATION_FAILED');
  }
  if (typeof o.globalPaused !== 'boolean' || !['ACTIVE', 'PAUSED'].includes(o.status as string) || !Array.isArray(o.allowedActions)) throw new Error('VALIDATION_FAILED');
  for (const key of ['connectionQueryStatus', 'faultQueryStatus']) {
    if (o[key] !== undefined && !(queryStatuses as readonly string[]).includes(o[key] as string)) throw new Error('VALIDATION_FAILED');
  }
  for (const key of ['connections', 'faults']) if (o[key] !== undefined && !Array.isArray(o[key])) throw new Error('VALIDATION_FAILED');
  for (const connection of (o.connections ?? []) as Record<string, unknown>[]) {
    if (typeof connection.accountId !== 'string' || !connection.accountId.trim()
      || !['wechat', 'qq','unknown'].includes(connection.platform as string)
      || ![...platformConnectionStates,'unknown','probe_healthy'].includes(connection.connectionState as PlatformConnectionState)) throw new Error('VALIDATION_FAILED');
    const recovery = connection.recovery as Record<string, unknown> | undefined;
    if (recovery !== undefined && (recovery === null || typeof recovery !== 'object'
      || typeof recovery.historyComplete !== 'boolean' || !['complete', 'partial', 'none', 'unknown'].includes(recovery.status as string))) throw new Error('VALIDATION_FAILED');
  }
  for (const fault of (o.faults ?? []) as Record<string, unknown>[]) {
    if (typeof fault.id !== 'string' || typeof fault.summary !== 'string' || typeof fault.status !== 'string') throw new Error('VALIDATION_FAILED');
  }
}

export function assertLiveSend(mode: Mode): asserts mode is 'live' {
  if (mode !== 'live') throw new Error('POLICY_BLOCKED');
}
export { validateDecisionV2 } from './decision-v2.mts';
export type {DecisionResultV2,ModelRouteConfigV2,ModelUsageV2,ModelPriceV2,QualityResultV2} from './decision-v2.mts';
export function assertEventEnvelope(value: unknown): asserts value is EventEnvelope {
  if (!value || typeof value !== 'object') throw new Error('VALIDATION_FAILED');
  const e = value as Record<string, unknown>;
  for (const k of ['eventId', 'occurredAt', 'correlationId', 'causationId', 'aggregateId']) if (typeof e[k] !== 'string' || !(e[k] as string).trim()) throw new Error('VALIDATION_FAILED');
  if (!eventTypes.includes(e.eventType as EventType) || !Number.isSafeInteger(e.eventVersion) || (e.eventVersion as number) < 1 || !Number.isSafeInteger(e.aggregateVersion) || (e.aggregateVersion as number) < 0 || !e.payload || typeof e.payload !== 'object') throw new Error('VALIDATION_FAILED');
  if (typeof e.occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(e.occurredAt) || !Number.isFinite(Date.parse(e.occurredAt))) throw new Error('VALIDATION_FAILED');
}
