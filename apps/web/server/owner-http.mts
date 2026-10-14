/** Owner management API routing. 07 injects the authenticated session and CSRF/Origin checks;
 * 02/03 supply policy-checked projections and commands. No raw database or send port here.
 * Reads are protected by the session cookie; writes additionally require Origin + CSRF.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { validRejectionReason, type RejectionReason } from '../../../packages/data/feedback/pg-candidate-journal.mts';
import { requestIdOf } from '../../../packages/infrastructure/observability/request-id.mts';
import type { WorkspaceQuery } from '../../../packages/orchestration/postgres/workspace-query.mts';
import type { PipelineVersion } from '../../../packages/contracts/reply-pipeline-v2.mts';
import type { MemoryCommand,ProfileCommand } from '../../../packages/data/memory-v2/service.mts';
import type { ModelConfigCommandV2 } from '../../../packages/ai/pipeline-v2/model-service.mts';
import type {TrialQualitySave,TrialQualityApply} from '../../../packages/contracts/trial-model-settings.mts';
import type {PeopleCommand,ImportPreviewInput,ImportCommitInput,PersonMemoryInput,PersonMessageInput} from '../../../packages/contracts/people.mts';

type Session = { ownerId: string };
export type CommandResult = { resultVersion: number; correlationId: string; status?: string };
export type OwnerPort = {
  people?(ownerId:string):Promise<unknown>;
  peopleCommand?(ownerId:string,input:PeopleCommand):Promise<unknown>;
  personHistory?(ownerId:string,personId:string,contactId?:string,before?:string):Promise<unknown>;
  historyPreview?(ownerId:string,input:ImportPreviewInput):Promise<unknown>;
  historyCommit?(ownerId:string,input:ImportCommitInput):Promise<unknown>;
  personMemory?(ownerId:string,input:PersonMemoryInput):Promise<unknown>;
  personMessage?(ownerId:string,input:PersonMessageInput):Promise<unknown>;
  trialEconomySettings?(ownerId:string):Promise<unknown>;
  saveTrialEconomySettings?(ownerId:string,input:TrialQualitySave):Promise<unknown>;
  applyTrialEconomySettings?(ownerId:string,input:TrialQualityApply):Promise<unknown>;
  trialQualitySettings?(ownerId:string):Promise<unknown>;
  saveTrialQualitySettings?(ownerId:string,input:TrialQualitySave):Promise<unknown>;
  applyTrialQualitySettings?(ownerId:string,input:TrialQualityApply):Promise<unknown>;
  modelConfig?(ownerId:string):Promise<unknown>;
  modelUsage?(ownerId:string):Promise<unknown>;
  updateModelConfig?(ownerId:string,input:ModelConfigCommandV2):Promise<unknown>;
  memoryControls?(ownerId:string,conversationId:string,input:{idempotencyKey:string;expectedVersion:number;enabled:boolean;styleSamples:boolean;retentionDays:number}):Promise<unknown>;
  memories?(ownerId:string,conversationId:string):Promise<unknown>;
  contextPreview?(ownerId:string,conversationId:string):Promise<unknown>;
  memoryCommand?(ownerId:string,conversationId:string,action:'create'|'confirm'|'correct'|'expire'|'delete',id:string|undefined,input:MemoryCommand):Promise<unknown>;
  memoryProfile?(ownerId:string,conversationId:string,kind:'relationship'|'style',input:ProfileCommand):Promise<unknown>;
  replyJobs?(ownerId: string, conversationId: string): Promise<unknown>;
  replyJob?(ownerId: string, id: string, trace: boolean): Promise<unknown>;
  setPipelineVersion?(ownerId: string, conversationId: string, input: VersionCommand & { version: PipelineVersion }): Promise<unknown>;
  approveReplyJob?(ownerId: string, id: string, input: ConfirmCommand & { expectedConversationRevision: number }): Promise<unknown>;
  cancelReplyJob?(ownerId: string, id: string, input: VersionCommand): Promise<unknown>;
  regenerateReplyJob?(ownerId:string,id:string,input:VersionCommand&{expectedConversationRevision:number}):Promise<unknown>;
  overview(ownerId: string): Promise<unknown>;
  tasks(ownerId: string): Promise<{ items: unknown[] }>;
  contacts(ownerId: string): Promise<{ items: unknown[] }>;
  conversations(ownerId: string): Promise<{ items: unknown[] }>;
  workspaceList?(ownerId: string, query: WorkspaceQuery): Promise<unknown>;
  workspaceDetail?(ownerId: string, conversationId: string, before?: string): Promise<unknown>;
  resumeRoutine?(ownerId: string, contactId: string, command: VersionCommand): Promise<CommandResult>;
  facts(ownerId: string): Promise<{ items: unknown[] }>;
  analyses(ownerId: string): Promise<{ items: unknown[] }>;
  media(ownerId: string): Promise<{ items: unknown[] }>;
  audit(ownerId: string): Promise<{ items: unknown[] }>;
  confirm(ownerId: string, taskId: string, command: ConfirmCommand): Promise<CommandResult>;
  present(ownerId: string, taskId: string, command: CandidateCommand & { shownAlternativeIds: string[] }): Promise<CommandResult>;
  reject(ownerId: string, taskId: string, command: CandidateCommand): Promise<CommandResult>;
  regenerate(ownerId: string, taskId: string, command: CandidateCommand): Promise<CommandResult>;
  pauseAll(ownerId: string, command: VersionCommand): Promise<CommandResult>;
  resumeAll(ownerId: string, command: VersionCommand): Promise<CommandResult>;
  pauseContact(ownerId: string, contactId: string, command: VersionCommand): Promise<CommandResult>;
  resumeContact(ownerId: string, contactId: string, command: VersionCommand): Promise<CommandResult>;
  acknowledgePausedInbound(ownerId: string, contactId: string, command: VersionCommand): Promise<CommandResult>;
  requestPausedReply(ownerId: string, contactId: string, command: VersionCommand): Promise<CommandResult>;
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
  shownAlternativeIds?: string[];
};
export type VersionCommand = { expectedVersion: number; idempotencyKey: string; reason?: string };
export type CandidateCommand = VersionCommand & { shownAlternativeIds?: string[]; rejectionReason?: RejectionReason };
export type ResolveSendCommand = {
  status: 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE';
  evidenceRef: string; expectedVersion: number; idempotencyKey: string; platformMessageId?: string;
  /** Also clear the UNKNOWN_SEND pause in the same transaction; other pause reasons remain. */
  resume?: boolean;
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
  shownIds(value.shownAlternativeIds);
  return value as ConfirmCommand;
}
function shownIds(value: unknown): void {
  if (value !== undefined && (!Array.isArray(value) || value.length > 3 || new Set(value).size !== value.length || !value.every(id => typeof id === 'string' && isId(id)))) throw new HttpError(400, 'VALIDATION_FAILED');
}
function candidateCommand(value: unknown, action: 'present'): CandidateCommand & { shownAlternativeIds: string[] };
function candidateCommand(value: unknown, action: 'reject' | 'regenerate'): CandidateCommand;
function candidateCommand(value: unknown, action: string): CandidateCommand {
  const command = versionCommand(value);
  if (!isObject(value)) throw new HttpError(400, 'VALIDATION_FAILED');
  shownIds(value.shownAlternativeIds);
  if (action === 'present' && value.shownAlternativeIds === undefined) throw new HttpError(400, 'VALIDATION_FAILED');
  if (value.rejectionReason !== undefined && (action !== 'reject' || !validRejectionReason(value.rejectionReason))) throw new HttpError(400, 'VALIDATION_FAILED');
  return { ...command, ...(value.shownAlternativeIds === undefined ? {} : { shownAlternativeIds: value.shownAlternativeIds }),
    ...(value.rejectionReason === undefined ? {} : { rejectionReason: value.rejectionReason }) } as CandidateCommand;
}
/** Resolving an unknown send requires evidence: the owner records what they checked. */
function resolveSendCommand(value: unknown): ResolveSendCommand {
  if (!isObject(value) || !isVersion(value.expectedVersion) || !isKey(value.idempotencyKey)
    || !['SUBMITTED', 'DELIVERED', 'FAILED_DEFINITE'].includes(String(value.status))
    || !isShortText(value.evidenceRef, 200)) throw new HttpError(400, 'VALIDATION_FAILED');
  if (value.platformMessageId !== undefined && !isShortText(value.platformMessageId, 128)) throw new HttpError(400, 'VALIDATION_FAILED');
  if (value.resume !== undefined && typeof value.resume !== 'boolean') throw new HttpError(400, 'VALIDATION_FAILED');
  return { status: value.status as ResolveSendCommand['status'], evidenceRef: value.evidenceRef as string,
    expectedVersion: value.expectedVersion, idempotencyKey: value.idempotencyKey,
    ...(value.platformMessageId === undefined ? {} : { platformMessageId: value.platformMessageId as string }),
    ...(value.resume === true ? { resume: true } : {}) };
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
async function readJson(request: IncomingMessage,limit=64_000): Promise<unknown> {
  const chunks:Buffer[]=[];let size=0;
  for await (const chunk of request) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
    if(size>limit)throw new HttpError(413,'VALIDATION_FAILED');chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'VALIDATION_FAILED'); }
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
      if (!path.startsWith('/api/v1/') && !path.startsWith('/api/v2/')) throw new HttpError(404, 'NOT_FOUND');
      const session = await deps.authenticate(request);
      if (!session?.ownerId) throw new HttpError(401, 'UNAUTHENTICATED');
      const ownerId = session.ownerId;
      const method = request.method ?? 'GET';

      if (method === 'GET') {
        if(path==='/api/v2/people'){if(!deps.ownerPort.people)throw new HttpError(501,'NOT_IMPLEMENTED');return send(response,200,await deps.ownerPort.people(ownerId));}
        const personHistory=/^\/api\/v2\/people\/([^/]+)\/history$/.exec(path);
        if(personHistory){if(!deps.ownerPort.personHistory)throw new HttpError(501,'NOT_IMPLEMENTED');const q=new URL(request.url!,'http://localhost').searchParams;return send(response,200,await deps.ownerPort.personHistory(ownerId,resourceId(personHistory[1]),q.get('contactId')??undefined,q.get('before')??undefined));}
        if(path==='/api/v2/trial-economy-settings'){if(!deps.ownerPort.trialEconomySettings)throw new HttpError(501,'NOT_IMPLEMENTED');return send(response,200,await deps.ownerPort.trialEconomySettings(ownerId));}
        if(path==='/api/v2/trial-quality-settings'){if(!deps.ownerPort.trialQualitySettings)throw new HttpError(501,'NOT_IMPLEMENTED');return send(response,200,await deps.ownerPort.trialQualitySettings(ownerId));}
        if(path==='/api/v2/model-config'||path==='/api/v2/model-usage'){
          const fn=path.endsWith('model-config')?deps.ownerPort.modelConfig:deps.ownerPort.modelUsage;
          if(!fn)throw new HttpError(501,'NOT_IMPLEMENTED');return send(response,200,await fn(ownerId));
        }
        const memory=/^\/api\/v2\/conversations\/([^/]+)\/(memories|context-preview)$/.exec(path);
        if(memory){const fn=memory[2]==='memories'?deps.ownerPort.memories:deps.ownerPort.contextPreview;if(!fn)throw new HttpError(501,'NOT_IMPLEMENTED');return send(response,200,await fn(ownerId,resourceId(memory[1])));}
        let v2 = /^\/api\/v2\/conversations\/([^/]+)\/reply-jobs$/.exec(path);
        if (v2) {
          if (!deps.ownerPort.replyJobs) throw new HttpError(501, 'NOT_IMPLEMENTED');
          return send(response,200,await deps.ownerPort.replyJobs(ownerId,resourceId(v2[1])));
        }
        v2 = /^\/api\/v2\/reply-jobs\/([^/]+)(\/trace)?$/.exec(path);
        if (v2) {
          if (!deps.ownerPort.replyJob) throw new HttpError(501, 'NOT_IMPLEMENTED');
          return send(response,200,await deps.ownerPort.replyJob(ownerId,resourceId(v2[1]),!!v2[2]));
        }
        const params = new URL(request.url ?? '/', 'http://localhost').searchParams;
        if (path === '/api/v1/workspace/conversations') {
          if (!deps.ownerPort.workspaceList) throw new HttpError(501, 'NOT_IMPLEMENTED');
          return send(response, 200, await deps.ownerPort.workspaceList(ownerId, {
            search: params.get('search') ?? undefined, platform: params.get('platform') ?? undefined,
            filter: params.get('filter') ?? undefined, cursor: params.get('cursor') ?? undefined,
            limit: params.has('limit') ? Number(params.get('limit')) : undefined,
          }));
        }
        const workspace = /^\/api\/v1\/conversations\/([^/]+)\/workspace$/.exec(path);
        if (workspace) {
          if (!deps.ownerPort.workspaceDetail) throw new HttpError(501, 'NOT_IMPLEMENTED');
          return send(response, 200, await deps.ownerPort.workspaceDetail(ownerId, resourceId(workspace[1]), params.get('before') ?? undefined));
        }
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
      if(path==='/api/v2/people/message'){const body=await readJson(request);if(!isObject(body))throw new HttpError(400,'VALIDATION_FAILED');if(!deps.ownerPort.personMessage)throw new HttpError(501,'NOT_IMPLEMENTED');return send(response,200,await deps.ownerPort.personMessage(ownerId,body as PersonMessageInput));}
      if(path==='/api/v2/people/memory'){const body=await readJson(request);if(!isObject(body))throw new HttpError(400,'VALIDATION_FAILED');if(!deps.ownerPort.personMemory)throw new HttpError(501,'NOT_IMPLEMENTED');return send(response,200,await deps.ownerPort.personMemory(ownerId,body as PersonMemoryInput));}
      if(['/api/v2/people','/api/v2/history-imports/preview','/api/v2/history-imports/commit'].includes(path)){
        const body=await readJson(request,path==='/api/v2/people'?64000:4_000_000);if(!isObject(body))throw new HttpError(400,'VALIDATION_FAILED');
        if(path==='/api/v2/people'){if(!deps.ownerPort.peopleCommand)throw new HttpError(501,'NOT_IMPLEMENTED');return send(response,200,await deps.ownerPort.peopleCommand(ownerId,body as PeopleCommand));}
        if(path.endsWith('/preview')){if(!deps.ownerPort.historyPreview)throw new HttpError(501,'NOT_IMPLEMENTED');return send(response,200,await deps.ownerPort.historyPreview(ownerId,body as ImportPreviewInput));}
        if(!deps.ownerPort.historyCommit)throw new HttpError(501,'NOT_IMPLEMENTED');return send(response,200,await deps.ownerPort.historyCommit(ownerId,body as ImportCommitInput));
      }
      if(['/api/v2/trial-quality-settings','/api/v2/trial-quality-settings/apply','/api/v2/trial-economy-settings','/api/v2/trial-economy-settings/apply'].includes(path)){
        const apply=path.endsWith('/apply'),economy=path.includes('economy'),fn=economy?(apply?deps.ownerPort.applyTrialEconomySettings:deps.ownerPort.saveTrialEconomySettings):(apply?deps.ownerPort.applyTrialQualitySettings:deps.ownerPort.saveTrialQualitySettings);
        if(!fn)throw new HttpError(501,'NOT_IMPLEMENTED');const body=await readJson(request);
        if(!isObject(body)||Object.keys(body).sort().join(',')!==(apply?'expectedVersion,idempotencyKey':'expectedVersion,idempotencyKey,model')||!isPauseEpoch(body.expectedVersion)||!isKey(body.idempotencyKey)||!apply&&!isObject(body.model))throw new HttpError(400,'VALIDATION_FAILED');
        return send(response,200,await fn(ownerId,body as unknown as TrialQualitySave));
      }
      if(path==='/api/v2/model-config'){
        if(!deps.ownerPort.updateModelConfig)throw new HttpError(501,'NOT_IMPLEMENTED');
        const body=await readJson(request);
        if(!isObject(body)||Object.keys(body).sort().join(',')!=='config,expectedVersion,idempotencyKey'||!isPauseEpoch(body.expectedVersion)||!isKey(body.idempotencyKey)||!isObject(body.config))throw new HttpError(400,'VALIDATION_FAILED');
        return send(response,200,await deps.ownerPort.updateModelConfig(ownerId,body as ModelConfigCommandV2));
      }

      const memory=/^\/api\/v2\/conversations\/([^/]+)\/memories(?:\/([^/]+)\/(confirm|correct|expire|delete))?$/.exec(path);
      if(memory){
        if(!deps.ownerPort.memoryCommand)throw new HttpError(501,'NOT_IMPLEMENTED');
        const body=await readJson(request),allowed=['idempotencyKey','expectedVersion','memory','content','object','validUntil'];
        if(!isObject(body)||!isKey(body.idempotencyKey)||Object.keys(body).some(k=>!allowed.includes(k)))throw new HttpError(400,'VALIDATION_FAILED');
        return send(response,200,await deps.ownerPort.memoryCommand(ownerId,resourceId(memory[1]),(memory[3]??'create') as 'create'|'confirm'|'correct'|'expire'|'delete',memory[2]?resourceId(memory[2]):undefined,body as MemoryCommand));
      }
      const profile=/^\/api\/v2\/conversations\/([^/]+)\/(relationship|style)$/.exec(path);
      if(profile){
        if(!deps.ownerPort.memoryProfile)throw new HttpError(501,'NOT_IMPLEMENTED');const body=await readJson(request);
        if(!isObject(body)||!isKey(body.idempotencyKey)||Object.keys(body).some(k=>!['idempotencyKey','expectedVersion','stage','locked','sourceRefs','settings','global'].includes(k)))throw new HttpError(400,'VALIDATION_FAILED');
        return send(response,200,await deps.ownerPort.memoryProfile(ownerId,resourceId(profile[1]),profile[2] as 'relationship'|'style',body as ProfileCommand));
      }
      const controls=/^\/api\/v2\/conversations\/([^/]+)\/memory-controls$/.exec(path);
      if(controls){
        if(!deps.ownerPort.memoryControls)throw new HttpError(501,'NOT_IMPLEMENTED');const body=await readJson(request);
        if(!isObject(body)||!isKey(body.idempotencyKey)||!isPauseEpoch(body.expectedVersion)||Object.keys(body).some(k=>!['idempotencyKey','expectedVersion','enabled','styleSamples','retentionDays'].includes(k)))throw new HttpError(400,'VALIDATION_FAILED');
        return send(response,200,await deps.ownerPort.memoryControls(ownerId,resourceId(controls[1]),body as {idempotencyKey:string;expectedVersion:number;enabled:boolean;styleSamples:boolean;retentionDays:number}));
      }

      let v2 = /^\/api\/v2\/conversations\/([^/]+)\/pipeline$/.exec(path);
      if (v2) {
        if (!deps.ownerPort.setPipelineVersion) throw new HttpError(501, 'NOT_IMPLEMENTED');
        const body = await readJson(request);
        if (!isObject(body) || ![1,2].includes(body.version as number)) throw new HttpError(400,'VALIDATION_FAILED');
        return send(response,200,await deps.ownerPort.setPipelineVersion(ownerId,resourceId(v2[1]),{...versionCommand(body),version: body.version as PipelineVersion}));
      }
      v2 = /^\/api\/v2\/reply-jobs\/([^/]+)\/(approve|cancel|regenerate)$/.exec(path);
      if (v2) {
        const id = resourceId(v2[1]),body = await readJson(request);
        const fields=v2[2]==='regenerate'?['expectedVersion','idempotencyKey','expectedConversationRevision']:v2[2]==='cancel'?['expectedVersion','idempotencyKey']:['taskVersion','planVersion','alternativeId','editedParts','contentHash','idempotencyKey','shownAlternativeIds','expectedConversationRevision'];
        if(!isObject(body)||Object.keys(body).some(k=>!fields.includes(k)))throw new HttpError(400,'VALIDATION_FAILED');
        if(v2[2]==='regenerate'){
          if(!deps.ownerPort.regenerateReplyJob)throw new HttpError(501,'NOT_IMPLEMENTED');if(!isVersion(body.expectedConversationRevision))throw new HttpError(400,'VALIDATION_FAILED');
          return send(response,200,await deps.ownerPort.regenerateReplyJob(ownerId,id,{...versionCommand(body),expectedConversationRevision:body.expectedConversationRevision as number}));
        }
        if (v2[2] === 'cancel') {
          if (!deps.ownerPort.cancelReplyJob) throw new HttpError(501,'NOT_IMPLEMENTED');
          return send(response,200,await deps.ownerPort.cancelReplyJob(ownerId,id,versionCommand(body)));
        }
        if (!deps.ownerPort.approveReplyJob) throw new HttpError(501,'NOT_IMPLEMENTED');
        if (!isObject(body) || !isVersion(body.expectedConversationRevision)) throw new HttpError(400,'VALIDATION_FAILED');
        return send(response,200,await deps.ownerPort.approveReplyJob(ownerId,id,{...confirmCommand(body),expectedConversationRevision: body.expectedConversationRevision as number}));
      }

      if (path === '/api/v1/control/pause-all') return send(response, 200, await deps.ownerPort.pauseAll(ownerId, controlCommand(await readJson(request))));
      if (path === '/api/v1/control/resume-all') return send(response, 200, await deps.ownerPort.resumeAll(ownerId, controlCommand(await readJson(request))));

      let match = /^\/api\/v1\/tasks\/([^/]+)\/(confirm|reject|regenerate|present)$/.exec(path);
      if (match) {
        const taskId = resourceId(match[1]);
        const body = await readJson(request);
        if (match[2] === 'present') return send(response, 200, await deps.ownerPort.present(ownerId, taskId, candidateCommand(body, 'present')));
        if (match[2] === 'regenerate') return send(response, 200, await deps.ownerPort.regenerate(ownerId, taskId, candidateCommand(body, 'regenerate')));
        return send(response, 200, match[2] === 'confirm'
          ? await deps.ownerPort.confirm(ownerId, taskId, confirmCommand(body))
          : await deps.ownerPort.reject(ownerId, taskId, candidateCommand(body, 'reject')));
      }
      match = /^\/api\/v1\/sends\/([^/]+)\/resolve$/.exec(path);
      if (match) {
        const sendTaskId = resourceId(match[1]);
        return send(response, 200, await deps.ownerPort.resolveSend(ownerId, sendTaskId, resolveSendCommand(await readJson(request))));
      }
      match = /^\/api\/v1\/contacts\/([^/]+)\/(pauseContact|resumeContact|resumeRoutine|acknowledgePausedInbound|requestPausedReply|updatePolicy)$/.exec(path);
      if (match) {
        const contactId = resourceId(match[1]);
        const body = await readJson(request);
        if (match[2] === 'resumeRoutine') {
          if (!deps.ownerPort.resumeRoutine) throw new HttpError(501, 'NOT_IMPLEMENTED');
          return send(response, 200, await deps.ownerPort.resumeRoutine(ownerId, contactId, versionCommand(body)));
        }
        if (match[2] === 'pauseContact') return send(response, 200, await deps.ownerPort.pauseContact(ownerId, contactId, versionCommand(body)));
        if (match[2] === 'resumeContact') return send(response, 200, await deps.ownerPort.resumeContact(ownerId, contactId, versionCommand(body)));
        if (match[2] === 'acknowledgePausedInbound') return send(response, 200, await deps.ownerPort.acknowledgePausedInbound(ownerId, contactId, versionCommand(body)));
        if (match[2] === 'requestPausedReply') return send(response, 200, await deps.ownerPort.requestPausedReply(ownerId, contactId, versionCommand(body)));
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
