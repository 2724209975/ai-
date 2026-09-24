/** Public v0.3.0 wire literals. docs/contracts.md defines their semantics. */
export const CONTRACT_VERSION = '0.3.0' as const;
export const modes = ['live', 'import', 'trial', 'replay'] as const;
export const actors = ['owner', 'contact', 'agent', 'system', 'platform', 'unknown'] as const;
export const messageTypes = ['text', 'image', 'voice', 'sticker_static', 'sticker_animated', 'unsupported'] as const;
export const sendStates = ['CREATED', 'PREFLIGHT', 'LEASED', 'SUBMITTING', 'SUBMITTED', 'DELIVERED', 'CANCELLED_PRE_SUBMIT', 'REJECTED_PREFLIGHT', 'FAILED_DEFINITE', 'RESULT_UNKNOWN'] as const;
/** Owner projection availability. A missing field reads as `unavailable`: an empty array is not proof. */
export const queryStatuses = ['ready', 'unavailable'] as const;
export const platformConnectionStates = ['disconnected', 'connecting', 'relogin_required', 'reconciling', 'connected', 'degraded'] as const;
export const eventTypes = ['PlatformInboundObserved', 'PlatformOwnerMessageObserved', 'PlatformSelfMessageUnattributed', 'PlatformAgentEchoObserved', 'PlatformOriginResolved', 'PlatformReceiptObserved', 'PlatformConnectionChanged', 'PlatformMessageMutationObserved', 'ContactPolicyChanged', 'GlobalPauseChanged', 'ContactControlChanged', 'FactChanged', 'EvidenceInvalidated', 'AnalysisChanged', 'SkillVersionChanged', 'GrantChanged', 'ReplyPlanProposed', 'ReplyPlanInvalidated', 'SendTaskStateChanged'] as const;
export type Mode = typeof modes[number];
export type Actor = typeof actors[number];
export type MessageType = typeof messageTypes[number];
export type SendState = typeof sendStates[number];
export type QueryStatus = typeof queryStatuses[number];
export type PlatformConnectionState = typeof platformConnectionStates[number];
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
  accountId: string; platform: 'wechat' | 'qq'; connectionState: PlatformConnectionState;
  capabilitySnapshotId?: string; verificationStatus?: 'documented' | 'tested' | 'unsupported' | 'unknown';
  lastReconciledAt?: string; limitations?: string[]; recovery?: OwnerConnectionRecovery;
}
export interface OwnerFault { id: string; status: string; summary: string }
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
      || !['wechat', 'qq'].includes(connection.platform as string)
      || !(platformConnectionStates as readonly string[]).includes(connection.connectionState as string)) throw new Error('VALIDATION_FAILED');
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
export function assertEventEnvelope(value: unknown): asserts value is EventEnvelope {
  if (!value || typeof value !== 'object') throw new Error('VALIDATION_FAILED');
  const e = value as Record<string, unknown>;
  for (const k of ['eventId', 'occurredAt', 'correlationId', 'causationId', 'aggregateId']) if (typeof e[k] !== 'string' || !(e[k] as string).trim()) throw new Error('VALIDATION_FAILED');
  if (!eventTypes.includes(e.eventType as EventType) || !Number.isSafeInteger(e.eventVersion) || (e.eventVersion as number) < 1 || !Number.isSafeInteger(e.aggregateVersion) || (e.aggregateVersion as number) < 0 || !e.payload || typeof e.payload !== 'object') throw new Error('VALIDATION_FAILED');
  if (typeof e.occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(e.occurredAt) || !Number.isFinite(Date.parse(e.occurredAt))) throw new Error('VALIDATION_FAILED');
}
