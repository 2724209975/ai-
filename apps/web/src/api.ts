/** 06 proposed REST projection. See docs/reports/web-06-api-proposal-2026-09-23.md. */
export type Operable = { id: string; version: number; allowedActions: string[]; status: string; reasonCodes?: string[]; invalidationReason?: string; correlationId?: string };
export type ReplyPart = { replyPartId: string; sequence: number; type: 'text' | 'approved_sticker'; content?: string; assetId?: string };
export type Alternative = { requiresCurrentStateReview?: boolean; alternativeId: string; strategySummary: string; parts: ReplyPart[] };
export type DecisionDisplay={strategy:string;risk_level:string;action:string;classification_level?:string;classification_confidence?:number;ambiguity?:{detected:boolean;reason:string};risk_flags?:string[]};
export type EngineDisplay={mode:string;upgradeReasons:string[];classifierModelId:string|null;classificationElapsedMs:number;analysisStatus:string;analysisModelId:string|null;analysisElapsedMs:number|null};
export type ReplyJob = {id:string;version:number;status:string;conversationRevision:number;reasonCode:string|null;decision:DecisionDisplay|null;route:{reason:string;decisionProvider:string;generationProvider:string|null;engineV21?:EngineDisplay}|null;shadowDecision?:{decision?:DecisionDisplay;route?:{engineV21?:EngineDisplay};errorCode?:string}|null;quality:{candidateKey:string;style:string;status:string;reasons:string[]}[];sends:unknown[]};
export type SendTask = { sendTaskId: string; version?: number; sequence: number; status: string; content?: string; at?: string; approvalSource?: string; receiptLevel?: string; platformMessageId?: string; lastError?: string; correlationId?: string };
export type Task = Operable & { candidateOnly?: boolean; replyJob?: ReplyJob; taskId: string; taskVersion: number; planId: string; planVersion: number; contactId: string; contactName: string; conversationId: string; triggerMessages: { id: string; type: string; text?: string; at: string }[]; reasonCodes: string[]; requiredInputs?: string[]; alternatives: Alternative[]; sends: SendTask[]; contextSnapshotId?: string; policyVersion?: number };
export type Overview = { version: number; globalPaused: boolean; allowedActions: string[]; pendingCount: number; unknownSendCount: number;
  /** Optional G2 proposal. Omission means the projection has not proved coverage. */
  connectionQueryStatus?: 'ready' | 'unavailable'; faultQueryStatus?: 'ready' | 'unavailable';
  connections: { accountId?: string; id?: string; platform: string; connectionState?: string; state?: string; verificationStatus?: string; limitations?: string[];
    lastReconciledAt?: string; recovery?: { status: string; historyComplete: boolean; gaps?: string[]; unresolvedSendCount?: number } }[];
  faults: { id: string; status: string; summary: string }[] };
export type Contact = Operable & { name: string; platform: string; agentEnabled: boolean; sendMode: string; goal: string; relationshipStatus?: string; stylePreferences?: string[]; activeContactEnabled: boolean; activeConfessionEnabled: boolean; allowedWindows?: string[]; restrictions?: string[]; pauseReasons?: string[]; policyVersion: number; unreviewedPausedInboundCount?: number };
export type Conversation = Operable & { contactId: string; contactName: string; revision: number; generation: number; pauseReasons: string[]; globalPaused?: boolean; globalVersion?: number; unreviewedPausedInboundCount?: number; messages: { id: string; actor: string; type: string; text?: string; at: string; mediaId?: string; platformMessageId?: string; originStatus?: string; originEvidenceRefs?: string[] }[]; sends: SendTask[] };
export type Fact = Operable & { content: string; scope: string; sourceKind: string; evidenceRefs?: string[]; updatedAt: string; expiresAt?: string; confirmed: boolean };
export type Analysis = Operable & { contactId: string; contactName: string; analysisVersion: string; taxonomyVersion: string; cutoffAt: string; sampleRange: string; claims: { label: string; hypothesis: string; supportingEvidence: string[]; counterEvidence: string[]; alternativeExplanation?: string; uncertainty: string }[] };
export type Media = Operable & { contactId: string; kind: string; capturedAt: string; previewUrl?: string; recognition?: string; uncertainty?: string; approvedPlatforms?: string[]; source?: string };
export type Skill = Operable & { name: string; source: string; skillVersion: string; purpose: string; enabledContactIds: string[]; invocationReason?: string; invocationStatus?: string };
export type ImportJob = Operable & { filename: string; phase: string; contactMappings?: string[]; dateRange?: string; messageCount?: number; anomalies?: string[]; duplicates?: number };
export type AuditEntry = { id: string; at: string; contactId?: string; action: string; decisionSummary: string; policyVersion?: number; planVersion?: number; sendStatus?: string; correlationId: string };
export type Fault = Operable & { summary: string; affectedContactIds: string[]; occurredAt: string; recoveryState?: string; correlationId: string };
export type CommandResult = { resultVersion: number; correlationId: string; status?: string; remainingReasons?: string[]; restored?: string[]; skipped?: { contactId: string; reasons: string[] }[] };
export type SessionInfo = { ownerId: string; csrfToken: string; expiresAt: string; correlationId?: string };
export type ApiErrorBody = { code: string; message: string; retryable: boolean; correlationId: string; details?: unknown };

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) { super(body.message); }
}

/** The server injects the CSRF token into the app shell; login refreshes it in memory. */
let csrfToken: string | undefined = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content || undefined;
export function setCsrfToken(token?: string): void {
  if (typeof token === 'string' && token) csrfToken = token;
}

export async function request<T>(path: string, init?: RequestInit,version: 'v1'|'v2'='v1'): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${version}${path}`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) } : {}) }, ...init });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, { code: 'API_UNREACHABLE', message: '后端接口未接通，当前数据不可用。', retryable: true, correlationId: '' });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) { csrfToken = undefined; dispatchEvent(new Event('owner-session-expired')); }
    const error = body && typeof body === 'object' && 'code' in body ? body as ApiErrorBody : { code: 'API_UNAVAILABLE', message: `后端返回 HTTP ${response.status}，当前数据不可用。`, retryable: response.status >= 500, correlationId: '' };
    throw new ApiError(response.status, error);
  }
  if (body === null || typeof body !== 'object') throw new ApiError(response.status, { code: 'INVALID_RESPONSE', message: '后端响应格式不符合约定。', retryable: false, correlationId: '' });
  return body as T;
}

export type ConversationSummary = { id: string; contactId: string; contactName: string; accountId: string; platform: string; status: string; version: number; allowedActions: string[]; pauseReasons: string[]; pendingCount: number; unknownSendCount: number; unreviewedPausedInboundCount: number; needsAttention: boolean; preview: string; lastActivityAt: string };
export type CandidateRuntime = { connected: boolean; persistent: boolean; reconnectAttempts: number; status: string; imageEnabled: boolean; priorConservativeCny: number; maxCalls: number; phoneAllocatedCny?:number; budget: {limitCny:number; calls:number; accountedCny:number; heldCny:number; halted:boolean}; sendCalls: number };
export type WorkspaceDetail = { candidateOnly?: boolean; runtime?: CandidateRuntime; contact: Contact; conversation: Conversation; tasks: Task[]; nextCursor: string | null };
export type WorkspaceList = { candidateOnly?: boolean; runtime?: CandidateRuntime; items: ConversationSummary[]; total: number; nextCursor: string | null };
export const api = {
  workspaceList: (params: URLSearchParams, signal?: AbortSignal) => request<WorkspaceList>(`/workspace/conversations?${params}`, { signal }),
  workspaceDetail: (id: string, before?: string, signal?: AbortSignal) => request<WorkspaceDetail>(`/conversations/${encodeURIComponent(id)}/workspace${before ? '?before='+encodeURIComponent(before) : ''}`, { signal }),
  session: async () => {const info=await request<SessionInfo>('/session');setCsrfToken(info.csrfToken);return info;},
  login: async (password: string) => {
    const info = await request<SessionInfo>('/session/login', { method: 'POST', body: JSON.stringify({ password }) });
    setCsrfToken(info.csrfToken);
    return info;
  },
  logout: () => request<{ status?: string }>('/session/logout', { method: 'POST', body: JSON.stringify({}) }),
  overview: () => request<Overview>('/overview'),
  contacts: () => request<{ items: Contact[] }>('/contacts'),
  conversations: () => request<{ items: Conversation[] }>('/conversations'),
  tasks: () => request<{ items: Task[] }>('/tasks'),
  facts: () => request<{ items: Fact[] }>('/facts'),
  analyses: () => request<{ items: Analysis[] }>('/analyses'),
  media: () => request<{ items: Media[] }>('/media'),
  skills: () => request<{ items: Skill[] }>('/skills'),
  imports: () => request<{ items: ImportJob[] }>('/imports'),
  audit: () => request<{ items: AuditEntry[] }>('/audit'),
  faults: () => request<{ items: Fault[] }>('/faults'),
  command: (path: string, payload: Record<string, unknown>, version: 'v1'|'v2'='v1') => request<CommandResult>(path, { method: 'POST', body: JSON.stringify(payload) }, version),
};

export { contentHash } from './browser-crypto';
