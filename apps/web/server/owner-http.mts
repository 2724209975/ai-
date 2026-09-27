/** Owner management API routing. 07 injects the authenticated session and CSRF/Origin checks;
 * 02/03 supply policy-checked projections and commands. No raw database or send port here.
 * Reads are protected by the session cookie; writes additionally require Origin + CSRF.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestIdOf } from '../../../packages/infrastructure/observability/request-id.mts';

type Session = { ownerId: string };
export type CommandResult = { resultVersion: number; correlationId: string; status?: string };
export type OwnerPort = {
  overview(ownerId: string): Promise<unknown>;
  tasks(ownerId: string): Promise<{ items: unknown[] }>;
  contacts(ownerId: string): Promise<{ items: unknown[] }>;
  conversations(ownerId: string): Promise<{ items: unknown[] }>;
  facts(ownerId: string): Promise<{ items: unknown[] }>;
  analyses(ownerId: string): Promise<{ items: unknown[] }>;
  media(ownerId: string): Promise<{ items: unknown[] }>;
  audit(ownerId: string): Promise<{ items: unknown[] }>;
  confirm(ownerId: string, taskId: string, command: ConfirmCommand): Promise<CommandResult>;
  reject(ownerId: string, taskId: string, command: VersionCommand): Promise<CommandResult>;
  pauseAll(ownerId: string, command: VersionCommand): Promise<CommandResult>;
  resumeAll(ownerId: string, command: VersionCommand): Promise<CommandResult>;
  pauseContact(ownerId: string, contactId: string, command: VersionCommand): Promise<CommandResult>;
  resumeContact(ownerId: string, contactId: string, command: VersionCommand): Promise<CommandResult>;
  acknowledgePausedInbound(ownerId: string, contactId: string, command: VersionCommand): Promise<CommandResult>;
  updatePolicy(ownerId: string, contactId: string, command: PolicyCommand): Promise<CommandResult>;
  changeFact(ownerId: string, factId: string, command: FactCommand): Promise<CommandResult>;
  correctAnalysis(ownerId: string, analysisId: string, command: AnalysisCommand): Promise<CommandResult>;
  setMediaApproval(ownerId: string, mediaId: string, command: MediaApprovalCommand): Promise<CommandResult>;
  /** An unknown send (RESULT_UNKNOWN) can only be resolved with platform evidence. */
  resolveSend(ownerId: string, sendTaskId: string, command: ResolveSendCommand): Promise<CommandResult>;
};
export type ConfirmCommand = {
  taskVersion: number; planVersion: number; alternativeId: string;
  editedParts: { type: 'text'; content: string }[]; contentHash: string; idempotencyKey: string;
};
export type VersionCommand = { expectedVersion: number; idempotencyKey: string; reason?: string };
export type ResolveSendCommand = {
  status: 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE';
  evidenceRef: string; expectedVersion: number; idempotencyKey: string; platformMessageId?: string;
};
export type PolicyPatch = {
  goal?: string; sendMode?: 'confirm' | 'auto'; agentEnabled?: boolean;
  activeContactEnabled?: boolean; activeConfessionEnabled?: boolean;
  allowedWindows?: { start: string; end: string }[]; timezone?: string;
  factScopes?: string[]; restrictions?: string[]; stylePreferences?: string[];
};
export type PolicyCommand = { expectedVersion: number; idempotencyKey: string; policy: PolicyPatch };
export type FactCommand = { expectedVersion: number; idempotencyKey: string; action: 'confirm' | 'correct' | 'delete'; content?: string; effectiveAt?: string };
export type AnalysisCommand = { expectedVersion: number; idempotencyKey: string; correction: string };
export type MediaApprovalCommand = { expectedVersion: number; idempotencyKey: string; action: 'approveAsset' | 'revokeAsset'; allowedPlatforms?: string[] };
export type OwnerHttpDependencies<S extends Session = Session> = {
  ownerPort: OwnerPort;
  /** The session object returned here is passed back to verifyWrite unchanged. */
  authenticate(request: IncomingMessage): Promise<S | null>;
  verifyWrite(request: IncomingMessage, session: S): Promise<boolean> | boolean;
};

class HttpError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isVersion = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) > 0;
/** The global pause epoch starts at 0 on a freshly migrated database, so it is the one version
 * that legitimately accepts zero: the first owner action on a new deployment is a resume. */
const isPauseEpoch = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const isKey = (x: unknown): x is string => typeof x === 'string' && x.length >= 8 && x.length <= 128;
const isId = (x: string) => /^[A-Za-z0-9_-]{1,128}$/.test(x);
const isShortText = (x: unknown, max: number): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const stringList = (x: unknown, max = 24): x is string[] => Array.isArray(x) && x.length <= max && x.every(item => isShortText(item, 120));

function versionCommand(value: unknown): VersionCommand {
  if (!isObject(value) || !isVersion(value.expectedVersion) || !isKey(value.idempotencyKey)) throw new HttpError(400, 'VALIDATION_FAILED');
  if (value.reason !== undefined && !isShortText(value.reason, 64)) throw new HttpError(400, 'VALIDATION_FAILED');
  return { expectedVersion: value.expectedVersion, idempotencyKey: value.idempotencyKey, ...(value.reason === undefined ? {} : { reason: value.reason as string }) };
}
/** pauseAll/resumeAll only; every other resource version still has to be positive. */
function controlCommand(value: unknown): VersionCommand {
  if (!isObject(value) || !isPauseEpoch(value.expectedVersion) || !isKey(value.idempotencyKey)) throw new HttpError(400, 'VALIDATION_FAILED');
  if (value.reason !== undefined && !isShortText(value.reason, 64)) throw new HttpError(400, 'VALIDATION_FAILED');
  return { expectedVersion: value.expectedVersion, idempotencyKey: value.idempotencyKey, ...(value.reason === undefined ? {} : { reason: value.reason as string }) };
}
function confirmCommand(value: unknown): ConfirmCommand {
  if (!isObject(value) || !isVersion(value.taskVersion) || !isVersion(value.planVersion) ||
    typeof value.alternativeId !== 'string' || !isId(value.alternativeId) ||
    !Array.isArray(value.editedParts) || value.editedParts.length < 1 || value.editedParts.length > 20 ||
    !value.editedParts.every(part => isObject(part) && part.type === 'text' && typeof part.content === 'string' && part.content.trim() && part.content.length <= 4000) ||
    typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentHash) || !isKey(value.idempotencyKey)) throw new HttpError(400, 'VALIDATION_FAILED');
  return value as ConfirmCommand;
}
/** Resolving an unknown send requires evidence: the owner records what they checked. */
function resolveSendCommand(value: unknown): ResolveSendCommand {
  if (!isObject(value) || !isVersion(value.expectedVersion) || !isKey(value.idempotencyKey)
    || !['SUBMITTED', 'DELIVERED', 'FAILED_DEFINITE'].includes(String(value.status))
    || !isShortText(value.evidenceRef, 200)) throw new HttpError(400, 'VALIDATION_FAILED');
  if (value.platformMessageId !== undefined && !isShortText(value.platformMessageId, 128)) throw new HttpError(400, 'VALIDATION_FAILED');
  return { status: value.status as ResolveSendCommand['status'], evidenceRef: value.evidenceRef as string,
    expectedVersion: value.expectedVersion, idempotencyKey: value.idempotencyKey,
    ...(value.platformMessageId === undefined ? {} : { platformMessageId: value.platformMessageId as string }) };
}
function policyCommand(value: unknown): PolicyCommand {
  if (!isObject(value) || !isVersion(value.expectedVersion) || !isKey(value.idempotencyKey) || !isObject(value.policy)) throw new HttpError(400, 'VALIDATION_FAILED');
  const raw = value.policy;
  const allowed = ['goal', 'sendMode', 'agentEnabled', 'activeContactEnabled', 'activeConfessionEnabled', 'allowedWindows', 'timezone', 'factScopes', 'restrictions', 'stylePreferences'];
  if (Object.keys(raw).length === 0 || Object.keys(raw).some(key => !allowed.includes(key))) throw new HttpError(400, 'VALIDATION_FAILED');
  const policy: PolicyPatch = {};
  if (raw.goal !== undefined) { if (!isShortText(raw.goal, 200)) throw new HttpError(400, 'VALIDATION_FAILED'); policy.goal = raw.goal; }
  if (raw.sendMode !== undefined) { if (raw.sendMode !== 'confirm' && raw.sendMode !== 'auto') throw new HttpError(400, 'VALIDATION_FAILED'); policy.sendMode = raw.sendMode; }
  for (const flag of ['agentEnabled', 'activeContactEnabled', 'activeConfessionEnabled'] as const) {
    if (raw[flag] !== undefined) { if (typeof raw[flag] !== 'boolean') throw new HttpError(400, 'VALIDATION_FAILED'); policy[flag] = raw[flag] as boolean; }
  }
  if (raw.timezone !== undefined) { if (!isShortText(raw.timezone, 64)) throw new HttpError(400, 'VALIDATION_FAILED'); policy.timezone = raw.timezone; }
  if (raw.factScopes !== undefined) { if (!stringList(raw.factScopes)) throw new HttpError(400, 'VALIDATION_FAILED'); policy.factScopes = raw.factScopes; }
  if (raw.restrictions !== undefined) { if (!stringList(raw.restrictions)) throw new HttpError(400, 'VALIDATION_FAILED'); policy.restrictions = raw.restrictions; }
  if (raw.stylePreferences !== undefined) { if (!stringList(raw.stylePreferences)) throw new HttpError(400, 'VALIDATION_FAILED'); policy.stylePreferences = raw.stylePreferences; }
  if (raw.allowedWindows !== undefined) {
    const windows = raw.allowedWindows;
    if (!Array.isArray(windows) || windows.length > 12 || !windows.every(w => isObject(w) && /^\d\d:\d\d$/.test(String(w.start)) && /^\d\d:\d\d$/.test(String(w.end)))) throw new HttpError(400, 'VALIDATION_FAILED');
    policy.allowedWindows = windows.map(w => ({ start: String(w.start), end: String(w.end) }));
  }
  return { expectedVersion: value.expectedVersion, idempotencyKey: value.idempotencyKey, policy };
}
function factCommand(value: unknown): FactCommand {
  if (!isObject(value) || !isVersion(value.expectedVersion) || !isKey(value.idempotencyKey) || !['confirm', 'correct', 'delete'].includes(String(value.action))) throw new HttpError(400, 'VALIDATION_FAILED');
  if (value.action === 'correct') {
    if (!isShortText(value.content, 2000)) throw new HttpError(400, 'VALIDATION_FAILED');
    return { expectedVersion: value.expectedVersion, idempotencyKey: value.idempotencyKey, action: 'correct', content: value.content };
  }
  return { expectedVersion: value.expectedVersion, idempotencyKey: value.idempotencyKey, action: value.action as 'confirm' | 'delete' };
}
function analysisCommand(value: unknown): AnalysisCommand {
  if (!isObject(value) || !isVersion(value.expectedVersion) || !isKey(value.idempotencyKey) || !isShortText(value.correction, 2000)) throw new HttpError(400, 'VALIDATION_FAILED');
  return { expectedVersion: value.expectedVersion, idempotencyKey: value.idempotencyKey, correction: value.correction };
}
function mediaCommand(value: unknown): MediaApprovalCommand {
  if (!isObject(value) || !isVersion(value.expectedVersion) || !isKey(value.idempotencyKey) || !['approveAsset', 'revokeAsset'].includes(String(value.action))) throw new HttpError(400, 'VALIDATION_FAILED');
  if (value.action === 'approveAsset' && !stringList(value.allowedPlatforms, 4)) throw new HttpError(400, 'VALIDATION_FAILED');
  return { expectedVersion: value.expectedVersion, idempotencyKey: value.idempotencyKey, action: value.action as 'approveAsset' | 'revokeAsset', ...(value.allowedPlatforms === undefined ? {} : { allowedPlatforms: value.allowedPlatforms as string[] }) };
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString();
    if (text.length > 64_000) throw new HttpError(413, 'VALIDATION_FAILED');
  }
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'VALIDATION_FAILED'); }
}
function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
function errorStatus(code: string): number {
  if (code === 'STALE_PLAN' || code === 'CONFLICT_VERSION' || code === 'PAUSED' || code === 'POLICY_BLOCKED') return 409;
  if (code === 'VALIDATION_FAILED') return 400;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'UNSUPPORTED_CAPABILITY') return 422;
  if (code === 'MISSING_FACT' || code === 'MEDIA_UNCERTAIN') return 422;
  if (code === 'NOT_IMPLEMENTED') return 501;
  if (code === 'SEND_RESULT_UNKNOWN' || code === 'PLATFORM_UNAVAILABLE' || code === 'MODEL_UNAVAILABLE') return 503;
  return 500;
}
function resourceId(raw: string | undefined): string {
  const id = decodeURIComponent(raw ?? '');
  if (!isId(id)) throw new HttpError(400, 'VALIDATION_FAILED');
  return id;
}

export function createOwnerHttpHandler<S extends Session = Session>(deps: OwnerHttpDependencies<S>) {
  if (!deps?.ownerPort || !deps.authenticate || !deps.verifyWrite) throw new Error('OWNER_HTTP_SECURITY_DEPENDENCY_REQUIRED');
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The runtime sets a request id and logs it; reusing it here keeps the error body and the log
    // line correlatable. Anything that is not a plain token is replaced, so it cannot be forged.
    const correlationId = requestIdOf(request);
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (!path.startsWith('/api/v1/')) throw new HttpError(404, 'NOT_FOUND');
      const session = await deps.authenticate(request);
      if (!session?.ownerId) throw new HttpError(401, 'UNAUTHENTICATED');
      const ownerId = session.ownerId;
      const method = request.method ?? 'GET';

      if (method === 'GET') {
        const reads: Record<string, () => Promise<unknown>> = {
          '/api/v1/overview': () => deps.ownerPort.overview(ownerId),
          '/api/v1/tasks': () => deps.ownerPort.tasks(ownerId),
          '/api/v1/contacts': () => deps.ownerPort.contacts(ownerId),
          '/api/v1/conversations': () => deps.ownerPort.conversations(ownerId),
          '/api/v1/facts': () => deps.ownerPort.facts(ownerId),
          '/api/v1/analyses': () => deps.ownerPort.analyses(ownerId),
          '/api/v1/media': () => deps.ownerPort.media(ownerId),
          '/api/v1/audit': () => deps.ownerPort.audit(ownerId),
        };
        const read = reads[path];
        if (read) return send(response, 200, await read());
        // Skill and import providers do not exist yet: report that instead of a fake empty list.
        if (path === '/api/v1/skills' || path === '/api/v1/imports' || path === '/api/v1/faults') throw new HttpError(501, 'NOT_IMPLEMENTED');
        throw new HttpError(404, 'NOT_FOUND');
      }
      if (method !== 'POST') throw new HttpError(405, 'VALIDATION_FAILED');
      if (!(await deps.verifyWrite(request, session))) throw new HttpError(403, 'FORBIDDEN');

      if (path === '/api/v1/control/pause-all') return send(response, 200, await deps.ownerPort.pauseAll(ownerId, controlCommand(await readJson(request))));
      if (path === '/api/v1/control/resume-all') return send(response, 200, await deps.ownerPort.resumeAll(ownerId, controlCommand(await readJson(request))));

      let match = /^\/api\/v1\/tasks\/([^/]+)\/(confirm|reject)$/.exec(path);
      if (match) {
        const taskId = resourceId(match[1]);
        const body = await readJson(request);
        return send(response, 200, match[2] === 'confirm'
          ? await deps.ownerPort.confirm(ownerId, taskId, confirmCommand(body))
          : await deps.ownerPort.reject(ownerId, taskId, versionCommand(body)));
      }
      match = /^\/api\/v1\/sends\/([^/]+)\/resolve$/.exec(path);
      if (match) {
        const sendTaskId = resourceId(match[1]);
        return send(response, 200, await deps.ownerPort.resolveSend(ownerId, sendTaskId, resolveSendCommand(await readJson(request))));
      }
      match = /^\/api\/v1\/contacts\/([^/]+)\/(pauseContact|resumeContact|acknowledgePausedInbound|updatePolicy)$/.exec(path);
      if (match) {
        const contactId = resourceId(match[1]);
        const body = await readJson(request);
        if (match[2] === 'pauseContact') return send(response, 200, await deps.ownerPort.pauseContact(ownerId, contactId, versionCommand(body)));
        if (match[2] === 'resumeContact') return send(response, 200, await deps.ownerPort.resumeContact(ownerId, contactId, versionCommand(body)));
        if (match[2] === 'acknowledgePausedInbound') return send(response, 200, await deps.ownerPort.acknowledgePausedInbound(ownerId, contactId, versionCommand(body)));
        return send(response, 200, await deps.ownerPort.updatePolicy(ownerId, contactId, policyCommand(body)));
      }
      match = /^\/api\/v1\/facts\/([^/]+)\/(confirmFact|correctFact|deleteFact)$/.exec(path);
      if (match) {
        const factId = resourceId(match[1]);
        const action = match[2] === 'confirmFact' ? 'confirm' : match[2] === 'correctFact' ? 'correct' : 'delete';
        const parsed = factCommand({ ...(await readJson(request) as object), action });
        return send(response, 200, await deps.ownerPort.changeFact(ownerId, factId, parsed));
      }
      match = /^\/api\/v1\/analyses\/([^/]+)\/correctAnalysis$/.exec(path);
      if (match) return send(response, 200, await deps.ownerPort.correctAnalysis(ownerId, resourceId(match[1]), analysisCommand(await readJson(request))));
      match = /^\/api\/v1\/media\/([^/]+)\/(approveAsset|revokeAsset)$/.exec(path);
      if (match) return send(response, 200, await deps.ownerPort.setMediaApproval(ownerId, resourceId(match[1]), mediaCommand(await readJson(request))));

      throw new HttpError(404, 'NOT_FOUND');
    } catch (cause) {
      const code = cause instanceof HttpError ? cause.code : cause instanceof Error && /^[A-Z_]+$/.test(cause.message) ? cause.message : 'INTERNAL_ERROR';
      const status = cause instanceof HttpError ? cause.status : errorStatus(code);
      const message = code === 'NOT_IMPLEMENTED' ? '该资源还没有持久化 provider，页面暂不可用。'
        : status >= 500 ? '服务暂不可用，请稍后刷新。' : code;
      send(response, status, { code, message, retryable: status >= 500 && code !== 'SEND_RESULT_UNKNOWN' && code !== 'NOT_IMPLEMENTED', correlationId });
    }
  };
}
