/** 06 proposed REST projection. See docs/reports/web-06-api-proposal-2026-09-23.md. */
export type Operable = { id: string; version: number; allowedActions: string[]; status: string; reasonCodes?: string[]; invalidationReason?: string; correlationId?: string };
export type ReplyPart = { replyPartId: string; sequence: number; type: 'text' | 'approved_sticker'; content?: string; assetId?: string };
export type Alternative = { alternativeId: string; strategySummary: string; parts: ReplyPart[] };
export type SendTask = { sendTaskId: string; version?: number; sequence: number; status: string; approvalSource?: string; receiptLevel?: string; platformMessageId?: string; lastError?: string; correlationId?: string };
export type Task = Operable & { taskId: string; taskVersion: number; planId: string; planVersion: number; contactId: string; contactName: string; conversationId: string; triggerMessages: { id: string; type: string; text?: string; at: string }[]; reasonCodes: string[]; requiredInputs?: string[]; alternatives: Alternative[]; sends: SendTask[]; contextSnapshotId?: string; policyVersion?: number };
export type Overview = { version: number; globalPaused: boolean; allowedActions: string[]; pendingCount: number; unknownSendCount: number;
  /** Optional G2 proposal. Omission means the projection has not proved coverage. */
  connectionQueryStatus?: 'ready' | 'unavailable'; faultQueryStatus?: 'ready' | 'unavailable';
  connections: { accountId?: string; id?: string; platform: string; connectionState?: string; state?: string; verificationStatus?: string; limitations?: string[];
    lastReconciledAt?: string; recovery?: { status: string; historyComplete: boolean; gaps?: string[]; unresolvedSendCount?: number } }[];
  faults: { id: string; status: string; summary: string }[] };
export type Contact = Operable & { name: string; platform: string; agentEnabled: boolean; sendMode: string; goal: string; relationshipStatus?: string; stylePreference?: string; activeContactEnabled: boolean; activeConfessionEnabled: boolean; allowedWindows?: string[]; restrictions?: string[]; pauseReasons?: string[]; policyVersion: number };
export type Conversation = Operable & { contactId: string; contactName: string; revision: number; generation: number; pauseReasons: string[]; messages: { id: string; actor: string; type: string; text?: string; at: string; mediaId?: string; originStatus?: string; originEvidenceRefs?: string[] }[]; sends: SendTask[] };
export type Fact = Operable & { content: string; scope: string; sourceKind: string; evidenceRefs?: string[]; updatedAt: string; expiresAt?: string; confirmed: boolean };
export type Analysis = Operable & { contactId: string; contactName: string; analysisVersion: string; taxonomyVersion: string; cutoffAt: string; sampleRange: string; claims: { label: string; hypothesis: string; supportingEvidence: string[]; counterEvidence: string[]; alternativeExplanation?: string; uncertainty: string }[] };
export type Media = Operable & { contactId: string; kind: string; capturedAt: string; previewUrl?: string; recognition?: string; uncertainty?: string; approvedPlatforms?: string[]; source?: string };
export type Skill = Operable & { name: string; source: string; skillVersion: string; purpose: string; enabledContactIds: string[]; invocationReason?: string; invocationStatus?: string };
export type ImportJob = Operable & { filename: string; phase: string; contactMappings?: string[]; dateRange?: string; messageCount?: number; anomalies?: string[]; duplicates?: number };
export type AuditEntry = { id: string; at: string; contactId?: string; action: string; decisionSummary: string; policyVersion?: number; planVersion?: number; sendStatus?: string; correlationId: string };
export type Fault = Operable & { summary: string; affectedContactIds: string[]; occurredAt: string; recoveryState?: string; correlationId: string };
export type CommandResult = { resultVersion: number; correlationId: string; status?: string };
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) } : {}) }, ...init });
  } catch {
    throw new ApiError(0, { code: 'API_UNREACHABLE', message: '后端接口未接通，当前数据不可用。', retryable: true, correlationId: '' });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'code' in body ? body as ApiErrorBody : { code: 'API_UNAVAILABLE', message: `后端返回 HTTP ${response.status}，当前数据不可用。`, retryable: response.status >= 500, correlationId: '' };
    throw new ApiError(response.status, error);
  }
  if (body === null || typeof body !== 'object') throw new ApiError(response.status, { code: 'INVALID_RESPONSE', message: '后端响应格式不符合约定。', retryable: false, correlationId: '' });
  return body as T;
}

export const api = {
  session: () => request<SessionInfo>('/session'),
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
  command: (path: string, payload: Record<string, unknown>) => request<CommandResult>(path, { method: 'POST', body: JSON.stringify(payload) }),
};

export async function contentHash(parts: { type: string; content: string }[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
