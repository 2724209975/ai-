/** PostgreSQL-backed confirmation path: text and reviewed media inbound, confirmation, dispatch. */
import { messageTypes, type MessageType } from '../../contracts/index.mts';
import { MockPlatformAdapter, type Event, type SendEnvelope, type SendResult } from '../../platform/mock/adapter.mts';
import { PgDataProvider } from '../../data/postgres/provider.mts';
import { PgOwnerDataPort } from '../../data/postgres/owner-data-port.mts';
import { appendOutbox, consumeOnce } from '../../infrastructure/postgres/event-store.mts';
import { acquireDispatchBoundary, changeContactPause, changeGlobalPause, finishDispatch, recoverAmbiguous, withDispatchLease, type DispatchClaim } from '../../infrastructure/postgres/dispatch-journal.mts';
import { setContactScope, withTransaction, type PgClient, type PgPool } from '../../infrastructure/postgres/transaction.mts';
import { contentHash, type Draft, type ProposedAlternative } from '../conversations/engine.mts';
import { defaultPolicy, routeReply, type Policy } from '../policy/evaluate.mts';
import { newId, sha256 } from './ids.mts';
import { PgCandidateFeedbackJournal, validRejectionReason, type RejectionReason } from '../../data/feedback/pg-candidate-journal.mts';
import { preparePersistentImages, type ImagePreparationPort } from './media-preparation.mts';
import { registerPlatformAccount } from './platform-accounts.mts';
import { createWorkspaceQueries, type WorkspaceQuery } from './workspace-query.mts';
import { createReplyJob, invalidateReplyJobs, readReplyJob, transitionPlanJob, transitionReplyJob, type ReplyJobRow } from './reply-jobs.mts';
import { cancellableReplyStates, type PipelineVersion, type ReplyJobState } from '../../contracts/reply-pipeline-v2.mts';
import { MemoryService } from '../../data/memory-v2/service.mts';
import { MemoryWorker } from '../../data/memory-v2/worker.mts';
import type { EmbeddingProvider } from '../../data/memory-v2/embedding.mts';
import type { ContextBudget } from '../../contracts/context-memory-v2.mts';
import { ReplyPipelineV2,type DecisionRunV2 } from '../../ai/pipeline-v2/pipeline.mts';
import type { GenerationProviderV2,DecisionProviderV2,AnalysisProviderV21 } from '../../ai/pipeline-v2/providers.mts';
import { adaptDataContextProjection } from '../../ai/understanding/context-adapter.mts';
import { evaluateQualityV2 } from '../../ai/pipeline-v2/quality.mts';
import { ruleDecision } from '../../ai/pipeline-v2/providers.mts';
import { registeredProvidersFromEnv } from '../../ai/pipeline-v2/compatible-provider.mts';
import {cloudAllowedForContact} from '../../data/memory-v2/cloud-policy.mts';

type Row = { conversation_id: string; contact_id: string; account_id: string; external_contact_ref: string; policy: Policy; policy_version: number | string; generation: number | string; revision: number | string; version: number | string; state: string; pause_reasons: string[]; last_inbound_message_id: string | null; paused_inbound_unreviewed_count: number | string; collection_started_at?: Date | string | null; collection_due_at?: Date | string | null; collection_message_ids?: string[] | null; pipeline_version: PipelineVersion; current_reply_job_id: string | null };
type PlanRow = { id: string; conversation_id: string; contact_id: string; context_snapshot_id: string; generation: number | string; policy_version: number | string; dependency_epoch: number | string; skill_epoch: number | string; trigger_message_ids: string[]; alternatives: { alternativeId: string; strategySummary: string; parts: { replyPartId: string; sequence: number; type: 'text'; content: string }[] }[]; risks: string[]; status: string; version: number | string; final_content_hash: string | null; approved_alternative_id: string | null; invalidation_reasons?: string[] };
type TaskRow = { id: string; plan_id: string; status: string; version: number | string; reason_codes: string[]; confirmed_content_hash: string | null; confirmed_plan_version: number | string | null };
type SendRow = { id: string; plan_id: string; reply_part_id: string; sequence: number; send_key: string; content: string; content_sha256: string; status: string; version: number | string; correlation_id: string; receipt: { status: string; platformMessageId: string | null } | null; approval_source?: string };
export type PersistentContext = Awaited<ReturnType<PgDataProvider['buildContext']>>;
export type PersistentIntelligence = { v2Generations?:GenerationProviderV2[];v2Decisions?:DecisionProviderV2[];v21Analyses?:AnalysisProviderV21[];propose(context: PersistentContext, policy: Policy): Promise<Draft>; checkEdited(context: PersistentContext, policy: Policy, parts: readonly { type: 'text'; content: string }[]): Promise<{ allowed: boolean; reasons: string[] }> };
/** The platform surface 02 needs for dispatch. Mock and the QQ bridge satisfy it structurally;
 * authorization, the dispatch lease and the send ledger stay inside 02, so no platform
 * implementation can submit a send on its own. */
export type DispatchPlatform = {
  readonly platform: 'wechat' | 'qq';
  readonly accountId: string;
  submitSend(envelope: SendEnvelope, authority: object, preflight: (envelope: SendEnvelope) => Promise<boolean>): Promise<{ status: string; receiptLevel?: string; platformMessageId?: string; correlationId?: string }>;
};

function fail(code: string): never { throw new Error(code); }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireText(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim()) fail('VALIDATION_FAILED'); }
function toMs(value: unknown): number { return value instanceof Date ? value.getTime() : Date.parse(String(value)); }
function validAlternatives(alternatives: ProposedAlternative[]): boolean {
  return alternatives.length >= 1 && alternatives.length <= 3 && alternatives.every(a => a.key && a.parts.length > 0 && a.parts.every((p, i) => p.key && p.sequence === i + 1 && p.type === 'text' && p.content.trim()));
}

/** Model output is data; it cannot introduce actions or send authorization. */
function assertReplyDraftV2(value: unknown): asserts value is Draft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INTELLIGENCE_OUTPUT');
  const draft = value as Record<string, unknown>;
  const fields = ['shouldReply','risks','alternatives','generatorVersion','promptVersion','timing','factVersions','analysisVersions','skillVersions'];
  const risks = ['ordinary','confession','relationship_decision','meeting_commitment','major_commitment','sensitive','unknown_fact','media_uncertain','stop_request'];
  if (Object.keys(draft).some(key => !fields.includes(key)) || typeof draft.shouldReply !== 'boolean'
    || !['now','wait','no_reply'].includes(String(draft.timing)) || typeof draft.generatorVersion !== 'string'
    || !draft.generatorVersion.trim() || (draft.promptVersion !== undefined && typeof draft.promptVersion !== 'string')
    || !Array.isArray(draft.risks) || !draft.risks.every(risk => risks.includes(risk))
    || !Array.isArray(draft.alternatives)) fail('INVALID_INTELLIGENCE_OUTPUT');
  for (const key of ['factVersions','analysisVersions','skillVersions']) {
    const versions = draft[key];
    if (versions !== undefined && (!versions || typeof versions !== 'object' || Array.isArray(versions)
      || Object.values(versions).some(version => !Number.isSafeInteger(version) || Number(version) < 1))) fail('INVALID_INTELLIGENCE_OUTPUT');
  }
  for (const alternative of draft.alternatives) {
    if (!alternative || typeof alternative !== 'object' || Object.keys(alternative).some(key => !['key','strategySummary','parts'].includes(key))
      || typeof alternative.key !== 'string' || typeof alternative.strategySummary !== 'string' || !Array.isArray(alternative.parts)) fail('INVALID_INTELLIGENCE_OUTPUT');
    for (const part of alternative.parts) {
      if (!part || typeof part !== 'object' || Object.keys(part).some(key => !['key','sequence','type','content'].includes(key))
        || typeof part.key !== 'string' || typeof part.content !== 'string' || part.type !== 'text') fail('INVALID_INTELLIGENCE_OUTPUT');
    }
  }
  if (draft.shouldReply && draft.timing === 'now' && !validAlternatives(draft.alternatives as ProposedAlternative[])) fail('INVALID_INTELLIGENCE_OUTPUT');
}

/** Only live events for this platform account may touch conversation state. */
function conversationRefOf(event: Event, payload: Record<string, unknown>, accountId: string) {
  const ref = payload.conversationRef as { accountId: string; conversationId: string; externalContactRef: string } | undefined;
  if (!ref || event.aggregateId !== ref.conversationId || ref.accountId !== accountId || payload.mode !== 'live') fail('VALIDATION_FAILED');
  return ref;
}
function observedMessageOf(payload: Record<string, unknown>, row: Row, type: MessageType, actor: 'contact' | 'unknown') {
  return { contactId: row.contact_id, conversationId: row.conversation_id, platformAccountId: row.account_id,
    platformMessageId: String(payload.platformMessageId), platformEventId: String(payload.platformEventId), actor, type,
    contentRef: type === 'text' ? String(payload.contentRef) : undefined,
    mediaId: typeof payload.mediaId === 'string' && payload.mediaId ? payload.mediaId : undefined,
    // `quotedMessageId` is this system's own message id (a uuid). A platform reply reference belongs
    // in provenance: accepting it here would try to store a platform id in a uuid column.
    quotedMessageId: typeof payload.quotedMessageId === 'string' && UUID_PATTERN.test(payload.quotedMessageId) ? payload.quotedMessageId : undefined,
    sentAt: String(payload.sentAt), receivedAt: String(payload.receivedAt),
    provenance: payload.provenance as Record<string, unknown> ?? {}, isAgentGenerated: false, mode: 'live' as const };
}

/** Removing one pause reason never clears the others: every remaining reason keeps the contact paused. */
function deriveState(pauseReasons: readonly string[], sendMode: Policy['sendMode'], agentEnabled = true): string {
  const has = (name: string) => pauseReasons.includes(name);
  if (has('GLOBAL_PAUSE')) return 'PAUSED_GLOBAL';
  if (has('OWNER_ORIGIN') || has('OWNER_ORIGIN_UNMAPPED') || has('OWNER_PAUSE')) return 'PAUSED_OWNER';
  if (has('STOP_REQUEST')) return 'PAUSED_STOP_REQUEST';
  if (has('MISSING_FACT')) return 'PAUSED_MISSING_FACT';
  if (has('MEDIA_UNCERTAIN')) return 'PAUSED_MEDIA';
  if (has('UNKNOWN_SEND')) return 'PAUSED_UNKNOWN_SEND';
  if (has('ACCOUNT_FAULT') || has('RECEIPT_CONFLICT') || has('SEND_FAILURE') || has('INTELLIGENCE_FAILURE') || has('PLATFORM_MUTATION_UNVERIFIED')) return 'PAUSED_FAILURE';
  if (has('AWAITING_MANUAL_RESUME') || has('CONFIRMATION_REJECTED')) return 'PAUSED_POLICY';
  return !agentEnabled ? 'DISABLED' : sendMode === 'auto' ? 'READY_AUTO' : 'READY_CONFIRM';
}

export class PgConfirmedService {
  readonly pipeline:ReplyPipelineV2;
  readonly memory:MemoryService;
  readonly memoryWorker:MemoryWorker;
  readonly #ownerId:string;
  readonly #contextBudget?:Partial<ContextBudget>;
  readonly #embedding?:EmbeddingProvider;
  workspaceList(query: WorkspaceQuery = {}) { return createWorkspaceQueries(this.#pool, this).list(query); }
  workspaceDetail(id: string, before?: string) { return createWorkspaceQueries(this.#pool, this).detail(id, before); }
  readonly #feedback = new PgCandidateFeedbackJournal();
  readonly #pool: PgPool; readonly #data: PgDataProvider; readonly #ai: PersistentIntelligence;
  readonly #platform: DispatchPlatform; readonly #authority: object; readonly #now: () => number;
  readonly #aggregationWindowMs: number; readonly #maxAggregationMs: number;
  readonly #mockAutoEnabled: boolean;
  readonly #images?: ImagePreparationPort;
  #recovered = false;
  constructor(options: { pool: PgPool; data: PgDataProvider; intelligence: PersistentIntelligence; platform: DispatchPlatform; authority: object; now?: () => number; aggregationWindowMs?: number; maxAggregationMs?: number; mockAutoEnabled?: boolean; images?: ImagePreparationPort; ownerId?:string;contextBudget?:Partial<ContextBudget>;embedding?:EmbeddingProvider }) {
    this.#pool = options.pool; this.#data = options.data; this.#ai = options.intelligence; this.#platform = options.platform;
    this.#authority = options.authority; this.#now = options.now ?? Date.now;
    this.#aggregationWindowMs = options.aggregationWindowMs ?? 0;
    this.#maxAggregationMs = options.maxAggregationMs ?? 30_000;
    this.#mockAutoEnabled = options.mockAutoEnabled === true;
    this.#images = options.images;
    this.#ownerId=options.ownerId??'local-owner';this.#contextBudget=options.contextBudget;this.#embedding=options.embedding;
    this.memory=new MemoryService(options.pool,options.data,this.#ownerId);
    this.memoryWorker=new MemoryWorker({pool:options.pool,data:options.data,ownerId:this.#ownerId,embedding:options.embedding});
    const registered=registeredProvidersFromEnv(process.env);
    this.pipeline=new ReplyPipelineV2({pool:options.pool,ownerId:this.#ownerId,generations:[...(options.intelligence.v2Generations??[]),...registered.generations],decisions:[...(options.intelligence.v2Decisions??[]),...registered.decisions],analyses:[...(options.intelligence.v21Analyses??[]),...registered.analyses],
      invalidate:async(tx,id)=>{await this.#invalidate(tx,id,'MODEL_CONFIG_CHANGED');await tx.query(`UPDATE orch_conversations SET state=CASE WHEN cardinality(pause_reasons)>0 THEN state ELSE CASE WHEN policy->>'sendMode'='auto' THEN 'READY_AUTO' ELSE 'READY_CONFIRM' END END,version=version+1 WHERE conversation_id=$1`,[id]);}});
    if (this.#mockAutoEnabled && !(this.#platform instanceof MockPlatformAdapter)) fail('MOCK_AUTO_REQUIRES_MOCK_PLATFORM');
    if (!Number.isSafeInteger(this.#aggregationWindowMs) || this.#aggregationWindowMs < 0
      || !Number.isSafeInteger(this.#maxAggregationMs) || this.#maxAggregationMs < this.#aggregationWindowMs) fail('VALIDATION_FAILED');
  }

  async enrollContact(input: { contactId: string; conversationId: string; accountId: string; externalContactRef: string; timezone: string; goal: string }): Promise<Policy> {
    const policy = defaultPolicy(input.contactId, input.timezone, input.goal);
    if (input.accountId !== this.#platform.accountId) fail('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      await setContactScope(tx, input.contactId);
      await registerPlatformAccount(tx, input.accountId, this.#platform.platform);
      const contact = await tx.query<{ conversation_id: string; platform_account_id: string; external_contact_ref: string }>(`SELECT conversation_id,platform_account_id,external_contact_ref FROM data_contacts WHERE id=$1 AND enrollment_status='enrolled'`, [input.contactId]);
      const c = contact.rows[0]; if (!c || c.conversation_id !== input.conversationId || c.platform_account_id !== input.accountId || c.external_contact_ref !== input.externalContactRef) fail('FORBIDDEN');
      await tx.query(`INSERT INTO dispatch_control(conversation_id,account_id,paused) VALUES($1,$2,false)`, [input.conversationId, input.accountId]);
      await tx.query(`INSERT INTO orch_conversations(conversation_id,contact_id,account_id,external_contact_ref,policy,policy_version,generation,revision,state) VALUES($1,$2,$3,$4,$5::jsonb,1,1,1,'READY_CONFIRM')`, [input.conversationId, input.contactId, input.accountId, input.externalContactRef, JSON.stringify(policy)]);
      if ((await tx.query(`SELECT account_id FROM orch_account_health h WHERE account_id=$1 AND (healthy=false OR
        EXISTS(SELECT 1 FROM orch_conversations c WHERE c.account_id=h.account_id AND 'ACCOUNT_FAULT'=ANY(c.pause_reasons)))`, [input.accountId])).rows.length) {
        await changeContactPause(tx, input.conversationId, true);
        await tx.query(`UPDATE orch_conversations SET generation=(SELECT generation FROM dispatch_control WHERE conversation_id=$1),state='PAUSED_FAILURE',pause_reasons=ARRAY['ACCOUNT_FAULT'] WHERE conversation_id=$1`, [input.conversationId]);
      }
      return policy;
    });
  }

  /** Trusted bridge probe. 02 owns the same dispatch boundary used by submissions and pauses. */
  async recordAccountHealth(input: { accountId: string; healthy: boolean; faultCode?: string }) {
    const codes = ['BRIDGE_RESTARTED','PROCESS_EXITED','HOOK_LOGIN_ABNORMAL','HELPER_UNRESPONSIVE'];
    if (input.accountId !== this.#platform.accountId || typeof input.healthy !== 'boolean' || (!input.healthy && !codes.includes(input.faultCode ?? '')) || (input.healthy && input.faultCode !== undefined)) fail('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      await tx.query(`INSERT INTO orch_account_health(account_id,healthy,fault_code) VALUES($1,$2,$3)
        ON CONFLICT(account_id) DO UPDATE SET healthy=EXCLUDED.healthy,fault_code=COALESCE(EXCLUDED.fault_code,orch_account_health.fault_code),
        observed_at=now(),version=orch_account_health.version+CASE WHEN orch_account_health.healthy IS DISTINCT FROM EXCLUDED.healthy OR
        (EXCLUDED.fault_code IS NOT NULL AND orch_account_health.fault_code IS DISTINCT FROM EXCLUDED.fault_code) THEN 1 ELSE 0 END`,
        [input.accountId, input.healthy, input.faultCode ?? null]);
      if (!input.healthy) {
        const rows = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE account_id=$1 ORDER BY conversation_id FOR UPDATE', [input.accountId])).rows;
        for (const row of rows) {
          if (row.pause_reasons.includes('ACCOUNT_FAULT')) continue;
          await changeContactPause(tx, row.conversation_id, true);
          await this.#invalidate(tx, row.conversation_id, 'ACCOUNT_FAULT');
          await tx.query(`UPDATE orch_conversations SET generation=(SELECT generation FROM dispatch_control WHERE conversation_id=$1),
            state='PAUSED_FAILURE',pause_reasons=array_append(pause_reasons,'ACCOUNT_FAULT'),collection_started_at=NULL,collection_due_at=NULL,
            collection_message_ids='{}'::uuid[],version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id]);
        }
      }
    });
  }

  /** 01 calls this inside its authenticated raw-inbox transaction before acknowledging an
   * own-account event whose peer cannot be established. No contact identity is invented. */
  async pauseAccountForUnmappedSelf(tx: PgClient, accountId: string, input: { rawEventRef: string; correlationId: string }): Promise<number> {
    const [kind, refAccount, digest, extra] = input.rawEventRef?.split(':') ?? [];
    if (!accountId || accountId !== this.#platform.accountId || !input.correlationId || kind !== 'bridge' || refAccount !== accountId || !digest || !/^[a-f0-9]{32}$/i.test(digest) || extra !== undefined) fail('VALIDATION_FAILED');
    await acquireDispatchBoundary(tx);
    const scope = `unmapped_self:${accountId}`;
    const commandHash = sha256(input.rawEventRef);
    const previous = (await tx.query<{ command_hash: string }>('SELECT command_hash FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [scope, input.rawEventRef])).rows[0];
    if (previous) { if (previous.command_hash !== commandHash) fail('CONFLICT_VERSION'); return 0; }
    const rows = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE account_id=$1 ORDER BY conversation_id FOR UPDATE', [accountId])).rows;
    for (const row of rows) {
      if (row.pause_reasons.includes('OWNER_ORIGIN_UNMAPPED')) continue;
      await changeContactPause(tx, row.conversation_id, true);
      await this.#invalidate(tx, row.conversation_id, 'OWNER_ORIGIN_UNMAPPED');
      const control = (await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id])).rows[0];
      await tx.query(`UPDATE orch_conversations SET generation=$2,state='PAUSED_OWNER',pause_reasons=array_append(pause_reasons,'OWNER_ORIGIN_UNMAPPED'),collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, Number(control?.generation)]);
    }
    await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [scope, input.rawEventRef, commandHash, rows.length, input.correlationId]);
    return rows.length;
  }

  async ingestPlatformEvent(event: Event): Promise<{ planId: string; taskId: string } | undefined> {
    if (event.eventVersion !== 1) fail('VALIDATION_FAILED');
    if (event.eventType === 'PlatformSelfMessageUnattributed') return this.#handleOwnerOrigin(event);
    if (event.eventType === 'PlatformMessageMutationObserved') return this.#handleMutation(event);
    if (event.eventType !== 'PlatformInboundObserved') fail('VALIDATION_FAILED');
    const p = event.payload as Record<string, unknown>;
    const ref = p.conversationRef as { accountId: string; conversationId: string; externalContactRef: string } | undefined;
    const type = String(p.type ?? '');
    if (!ref || event.aggregateId !== ref.conversationId || ref.accountId !== this.#platform.accountId || p.actor !== 'contact' || p.mode !== 'live'
      || !(messageTypes as readonly string[]).includes(type)) fail('VALIDATION_FAILED');
    // Text must carry content; media stays non-text and is never relabelled as text.
    if (type === 'text') requireText(p.contentRef);
    const accepted = await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const result = await consumeOnce(tx, '02-confirmed', event.eventId, async () => {
        const row = await this.#conversation(tx, ref.conversationId, true);
        if (!row) return undefined;
        if (row.account_id !== ref.accountId || row.external_contact_ref !== ref.externalContactRef) fail('VALIDATION_FAILED');
        const saved = await this.#data.appendObservedMessage(tx, observedMessageOf(p, row, type as MessageType, 'contact'), event.correlationId);
        if (saved.duplicate) return undefined;
        const control = await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
        const generation = Number(control.rows[0]?.generation);
        await this.#invalidate(tx, row.conversation_id, 'NEW_MESSAGE');
        // Disabling the agent keeps reception durable without invoking the model or collecting work.
        if (!row.policy.agentEnabled) {
          await tx.query(`UPDATE orch_conversations SET generation=$2,revision=revision+1,last_inbound_message_id=$3,
            collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],
            version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, generation, saved.id]);
          return { row, generation, messageIds: [] as string[], flush: false };
        }
        // A paused contact keeps receiving messages but never collects a generation batch.
        if (row.pause_reasons.length) {
          await tx.query(`UPDATE orch_conversations SET generation=$2,revision=revision+1,last_inbound_message_id=$3,paused_inbound_unreviewed_count=paused_inbound_unreviewed_count+1,version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, generation, saved.id]);
          return { row, generation, messageIds: [] as string[], flush: false };
        }
        if (this.#aggregationWindowMs === 0) {
          await tx.query(`UPDATE orch_conversations SET generation=$2,revision=revision+1,state='GENERATING',last_inbound_message_id=$3,collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, generation, saved.id]);
          if (row.pipeline_version === 2) await createReplyJob(tx, (await this.#conversation(tx,row.conversation_id))!, [saved.id], event.eventId);
          return { row, generation, messageIds: [saved.id], flush: true };
        }
        // Aggregation: the deadline is persisted so a restart cannot lose the batch.
        const startedAt = row.collection_started_at ? toMs(row.collection_started_at) : this.#now();
        const dueAt = Math.min(this.#now() + this.#aggregationWindowMs, startedAt + this.#maxAggregationMs);
        const batch = [...(row.collection_message_ids ?? []), saved.id];
        await tx.query(`UPDATE orch_conversations SET generation=$2,revision=revision+1,state='COLLECTING',last_inbound_message_id=$3,collection_started_at=$4::timestamptz,collection_due_at=$5::timestamptz,collection_message_ids=$6::uuid[],version=version+1,updated_at=now() WHERE conversation_id=$1`,
          [row.conversation_id, generation, saved.id, new Date(startedAt).toISOString(), new Date(dueAt).toISOString(), batch]);
        if (row.pipeline_version === 2) await createReplyJob(tx, (await this.#conversation(tx,row.conversation_id))!, batch, event.eventId, true);
        return { row, generation, messageIds: batch, flush: false };
      });
      if ('value' in result) return result.value;
      return undefined;
    });
    if (!accepted || !accepted.flush) return;
    return this.#proposeFor(accepted.row, accepted.generation, accepted.messageIds, event.eventId);
  }

  /** 05 has already raised skill_epoch in its command transaction. Make stale Owner tasks
   * visibly invalid as soon as the durable event is delivered, including after a restart. */
  async consumeSkillEvent(event: Event): Promise<undefined> {
    if (event.eventType !== 'SkillVersionChanged' && event.eventType !== 'GrantChanged') fail('VALIDATION_FAILED');
    const payload = event.payload as Record<string, unknown>;
    const skillId = payload.skillId;
    const version = event.eventType === 'SkillVersionChanged' ? payload.newVersion : payload.grantVersion;
    const contactId = event.eventType === 'GrantChanged' ? payload.contactId : undefined;
    if (event.eventVersion !== 1 || !UUID_PATTERN.test(String(skillId)) || event.aggregateId !== skillId ||
      !Number.isSafeInteger(version) || Number(version) < 1 ||
      (contactId !== undefined && !UUID_PATTERN.test(String(contactId))) ||
      (event.eventType === 'GrantChanged' && contactId === undefined)) fail('VALIDATION_FAILED');
    await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      await consumeOnce(tx, '02-skill', event.eventId, async () => {
        const rows = await tx.query<{ conversation_id: string; skill_epoch: string | number }>(`SELECT c.conversation_id,dc.skill_epoch FROM orch_conversations c
          JOIN dispatch_control dc ON dc.conversation_id=c.conversation_id
          WHERE ($1::uuid IS NULL OR c.contact_id=$1::uuid)
            AND EXISTS (SELECT 1 FROM orch_plans p WHERE p.conversation_id=c.conversation_id
              AND p.status IN ('AWAITING_CONFIRMATION','APPROVED','PARTIALLY_SENT')
              AND p.skill_epoch<dc.skill_epoch)
          ORDER BY c.conversation_id FOR UPDATE OF c`, [contactId ?? null]);
        const reason = event.eventType === 'SkillVersionChanged' ? 'SKILL_VERSION_CHANGED' : 'GRANT_CHANGED';
        for (const row of rows.rows) await this.#invalidate(tx, row.conversation_id, reason, Number(row.skill_epoch));
      });
    });
    return undefined;
  }

  /** Unattributed self message: never a contact inbound and never a style fact (contracts.md A08).
   * Pause the contact, invalidate un-sent plans, keep the raw origin for review. Only the owner
   * resumes the contact; a later origin correction must not silently resume it either. */
  async #handleOwnerOrigin(event: Event): Promise<undefined> {
    const p = event.payload as Record<string, unknown>;
    const ref = conversationRefOf(event, p, this.#platform.accountId);
    const type = String(p.type ?? '');
    if (!(messageTypes as readonly string[]).includes(type)) fail('VALIDATION_FAILED');
    await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      await consumeOnce(tx, '02-owner-origin', event.eventId, async () => {
        const row = await this.#conversation(tx, ref.conversationId, true);
        if (!row) return; // Outside enrollment: raw evidence only, no business effect.
        if (row.account_id !== ref.accountId || row.external_contact_ref !== ref.externalContactRef) fail('VALIDATION_FAILED');
        const saved = await this.#data.appendObservedMessage(tx, observedMessageOf(p, row, type as MessageType, 'unknown'), event.correlationId);
        if (saved.duplicate) return;
        await tx.query('UPDATE orch_conversations SET revision=revision+1 WHERE conversation_id=$1', [row.conversation_id]);
        if (row.pause_reasons.includes('OWNER_ORIGIN')) return;
        await changeContactPause(tx, row.conversation_id, true);
        await this.#invalidate(tx, row.conversation_id, 'OWNER_ORIGIN');
        const control = await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
        await tx.query(`UPDATE orch_conversations SET generation=$2,state='PAUSED_OWNER',pause_reasons=array_append(pause_reasons,'OWNER_ORIGIN'),version=version+1,updated_at=now() WHERE conversation_id=$1`,
          [row.conversation_id, Number(control.rows[0]?.generation)]);
      });
    });
    return undefined;
  }

  /** A platform mutation (recall/edit) can invalidate the evidence a pending plan was built on. */
  async #handleMutation(event: Event): Promise<undefined> {
    const p = event.payload as Record<string, unknown>;
    const ref = conversationRefOf(event, p, this.#platform.accountId);
    const mutation = String(p.mutation ?? '');
    const provenance = (p.provenance ?? {}) as Record<string, unknown>;
    const rawEventRef = typeof provenance.rawEventRef === 'string' ? provenance.rawEventRef : '';
    const platformEventId = String(p.platformEventId ?? '');
    if (!['recall', 'edit'].includes(mutation) || !rawEventRef.trim() || !platformEventId.trim()) fail('VALIDATION_FAILED');
    await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      await consumeOnce(tx, '02-mutation', event.eventId, async () => {
        const row = await this.#conversation(tx, ref.conversationId, true);
        if (!row) return;
        if (row.account_id !== ref.accountId || row.external_contact_ref !== ref.externalContactRef) fail('VALIDATION_FAILED');
        // 03 records the append-only audit row and invalidates the message's dependants in this very
        // transaction. An unlinked mutation is a risk, not a no-op.
        const outcome = await this.#data.invalidatePlatformMessage(tx, {
          callerContactId: row.contact_id, contactId: row.contact_id, conversationId: row.conversation_id,
          platformAccountId: row.account_id, platformMessageId: String(p.platformMessageId), platformEventId,
          mutation: mutation as 'recall' | 'edit', rawEventRef, receivedAt: String(p.receivedAt),
        }, event.correlationId);
        if (outcome.status === 'duplicate') return;
        await this.#invalidate(tx, row.conversation_id, outcome.status === 'unmatched' ? 'PLATFORM_MUTATION_UNVERIFIED' : 'PLATFORM_MUTATION');
        // Applied or not, the old evidence is no longer trustworthy: pause until the owner reviews.
        // Nothing here ever resumes the contact automatically.
        if (!row.pause_reasons.includes('PLATFORM_MUTATION_UNVERIFIED')) await changeContactPause(tx, row.conversation_id, true);
        const control = await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
        await tx.query(`UPDATE orch_conversations SET generation=$2,revision=revision+1,state='PAUSED_FAILURE',pause_reasons=CASE WHEN 'PLATFORM_MUTATION_UNVERIFIED'=ANY(pause_reasons) THEN pause_reasons ELSE array_append(pause_reasons,'PLATFORM_MUTATION_UNVERIFIED') END,collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, Number(control.rows[0]?.generation)]);
      });
    });
    return undefined;
  }

  readonly #shadowTasks=new Set<Promise<void>>();
  /** Diagnostics are detached after the existing flow commits; no error can change a plan or pause a contact. */
  async waitForShadow(){await Promise.all([...this.#shadowTasks]);}
  async #proposeFor(row: Row, generation: number, messageIds: readonly string[], causationId: string): Promise<{ planId: string; taskId: string } | undefined> {
    let observed:{jobId:string;context:PersistentContext}|undefined;
    const result=await this.#proposeForCurrent(row,generation,messageIds,causationId,(jobId,context)=>{observed={jobId,context};});
    if(observed){
      // Use the validated input of this turn, including turns where the old engine then paused the contact.
      const task=this.pipeline.shadow(observed.jobId,adaptDataContextProjection(observed.context),{...row.policy,restrictions:[...row.policy.restrictions],stylePreferences:[...(row.policy.stylePreferences??[])]}).catch(()=>{});
      this.#shadowTasks.add(task);void task.finally(()=>this.#shadowTasks.delete(task));
    }
    return result;
  }
  async #proposeForCurrent(row: Row, generation: number, messageIds: readonly string[], causationId: string,observe?:(jobId:string,context:PersistentContext)=>void): Promise<{ planId: string; taskId: string } | undefined> {
    const messageId = messageIds.at(-1);
    if (!messageId) fail('VALIDATION_FAILED');
    // The snapshot must include the messages that triggered it. A platform timestamp with second
    // precision can lead our own clock by up to a second (QQ reports time in whole seconds), and
    // taking only "now" as the cutoff made buildContext reject the trigger message as NOT_FOUND.
    const job = row.pipeline_version === 2 ? await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const current = await this.#conversation(tx,row.conversation_id,true);
      if (!current || current.pipeline_version !== 2 || Number(current.generation) !== generation || current.state !== 'GENERATING') return;
      const existing = current.current_reply_job_id ? (await tx.query<ReplyJobRow>('SELECT * FROM orch_reply_jobs WHERE id=$1 AND conversation_id=$2', [current.current_reply_job_id,current.conversation_id])).rows[0] : undefined;
      if (existing && !existing.plan_id && ['RECEIVED','BUFFERING','CONTEXT_READY','DECIDING','GENERATING','VALIDATING'].includes(existing.status)) return existing;
      return createReplyJob(tx,current,messageIds,causationId);
    }) : undefined;
    if (row.pipeline_version === 2 && !job) return;
    let projection: PersistentContext;
    let draft!: Draft;
    let runV2:DecisionRunV2|undefined;
    try {
      const cloudAllowed=!job||await withTransaction(this.#pool,tx=>cloudAllowedForContact(tx,this.#ownerId,row.contact_id));
      const v2Budget=job?await this.pipeline.contextBudget(row.contact_id,this.#contextBudget):undefined;
      const activeV21=job&&await this.pipeline.mode(row.contact_id)==='active';
      let queryEmbedding:import('../../data/memory-v2/repository.mts').Embedding|undefined;
      if(job&&!activeV21&&cloudAllowed&&this.#embedding&&(await this.memory.scoped(row.conversation_id,repo=>repo.controls())).enabled){
        const text=await withTransaction(this.#pool,async tx=>{await setContactScope(tx,row.contact_id);return (await tx.query<{content_ref:string}>("SELECT content_ref FROM data_messages WHERE contact_id=$1 AND id=ANY($2::uuid[]) AND type='text' AND deletion_status='active' ORDER BY sent_at,id",[row.contact_id,messageIds])).rows.map(m=>m.content_ref).join('\n');});
        if(text)try{queryEmbedding=await this.#embedding.embed(text);}catch{/* Optional semantic lookup falls back to scoped keyword recall. */}
      }
      projection = await withTransaction(this.#pool, async tx => {
        const newest = await tx.query<{ sent_at: Date | string }>('SELECT sent_at FROM data_messages WHERE id=$1 AND contact_id=$2', [messageId, row.contact_id]);
        const sentAt = newest.rows[0] ? toMs(newest.rows[0].sent_at) : Number.NaN;
        const cutoffMs = Number.isFinite(sentAt) ? Math.max(this.#now(), sentAt) : this.#now();
        return this.#data.buildContext(tx, { callerContactId: row.contact_id, contactId: row.contact_id, generation,
          policyVersion: Number(row.policy_version), allowedScopes: row.policy.factScopes,
          cutoffTime: new Date(cutoffMs).toISOString(), cutoffMessageId: messageId, mode: 'live',queryEmbedding,
          v2:job?{ownerId:this.#ownerId,revision:Number(job.conversation_revision),triggerMessageIds:messageIds,budget:v2Budget,retrievalMode:activeV21?'light':'full'}:undefined });
      });
      if (job && !await this.#stageReplyJob(job.id,projection,'CONTEXT_READY')) return;
      const lastReply = projection.messages.findLastIndex(m => m.actor === 'owner' || m.actor === 'agent');
      let mediaReady=true;
      if (this.#images && cloudAllowed && projection.messages.slice(lastReply + 1).some(m => m.type === 'image')) {
        const prepared = await preparePersistentImages({ pool: this.#pool, data: this.#data, port: this.#images, context: projection, policy: row.policy });
        projection = prepared.context; generation = projection.snapshot.generation;
        mediaReady=prepared.ready;
      }
      if(job&&mediaReady){
        if(!await this.#stageReplyJob(job.id,projection,'DECIDING'))return;
        observe?.(job.id,projection);
        let full=adaptDataContextProjection(projection);const policy={...row.policy,restrictions:[...row.policy.restrictions],stylePreferences:[...(row.policy.stylePreferences??[])]};
        let decision:DecisionRunV2;
        try{decision=await this.pipeline.decide(job.id,full,policy,async()=>{
          // L3 alone pays for optional semantic retrieval. Rebuild through MemoryEngine so all evidence remains version checked.
          if(cloudAllowed&&this.#embedding&&(await this.memory.scoped(row.conversation_id,repo=>repo.controls())).enabled){
            const text=full.messages.filter(m=>messageIds.includes(m.id)).map(m=>m.text??'').join('\n');
            if(text)try{queryEmbedding=await this.#embedding.embed(text);}catch{/* Keyword retrieval remains available. */}
          }
          projection=await withTransaction(this.#pool,tx=>this.#data.buildContext(tx,{callerContactId:row.contact_id,contactId:row.contact_id,generation,policyVersion:Number(row.policy_version),allowedScopes:row.policy.factScopes,cutoffTime:projection.snapshot.cutoffTime,cutoffMessageId:messageId,mode:'live',queryEmbedding,
            v2:{ownerId:this.#ownerId,revision:Number(job.conversation_revision),triggerMessageIds:messageIds,budget:v2Budget,retrievalMode:'full'}}));
          full=adaptDataContextProjection(projection);return full;
        });}catch(error){
          if(error instanceof Error&&['MEDIA_UNCERTAIN','UNSUPPORTED_CAPABILITY'].includes(error.message)){mediaReady=false;}else throw error;
        }
        if(mediaReady){
          await this.#recordReplyDiagnostics(job.id,decision!.decision,decision!.route);
          if((decision!.decision.action==='reply'||this.#ai.v2Generations===undefined&&!decision!.route.engineV21)&&!await this.#stageReplyJob(job.id,projection,'GENERATING'))return;
          runV2=decision!;
          if(this.#ai.v2Generations!==undefined||decision!.route.engineV21){
            const generated=await this.pipeline.generate(job.id,full,policy,decision!);draft=generated.draft;
          }else draft=await this.#ai.propose(projection,row.policy);
        }
      }else if(!job&&mediaReady)draft=await this.#ai.propose(projection,row.policy);
      if(!mediaReady){
        if(job&&!await this.#stageReplyJob(job.id,projection,'GENERATING'))return;
        draft={shouldReply:false,risks:['media_uncertain'],alternatives:[],generatorVersion:'image-preparation-1',timing:'no_reply'};
      }
      if (job) assertReplyDraftV2(draft);
      if (job && (draft.shouldReply||this.#ai.v2Generations===undefined&&!runV2?.route.engineV21||!mediaReady) && !await this.#stageReplyJob(job.id,projection,'VALIDATING')) return;
      if(job&&draft.shouldReply&&runV2&&(this.#ai.v2Generations!==undefined||runV2.route.engineV21)){
        const full=adaptDataContextProjection(projection),policy={...row.policy,restrictions:[...row.policy.restrictions],stylePreferences:[...(row.policy.stylePreferences??[])]};
        const quality=this.pipeline.evaluate(full,policy,runV2,draft);
        await this.#recordReplyDiagnostics(job.id,runV2.decision,runV2.route,quality);
        if(quality.some(q=>q.status==='blocked')){
          await withTransaction(this.#pool,async tx=>{await acquireDispatchBoundary(tx);await transitionReplyJob(tx,job.id,'FAILED','QUALITY_BLOCKED');const current=await this.#conversation(tx,row.conversation_id,true);if(current?.current_reply_job_id===job.id&&Number(current.generation)===generation)await tx.query(`UPDATE orch_conversations SET state='READY_CONFIRM',version=version+1 WHERE conversation_id=$1`,[row.conversation_id]);});return;
        }
      }
    }
    catch (error) {
      if (error instanceof Error && ['STALE_CONTEXT', 'CONFLICT_VERSION', 'NOT_FOUND'].includes(error.message)) {
        if (job) await withTransaction(this.#pool, async tx => { await acquireDispatchBoundary(tx); await transitionReplyJob(tx,job.id,'STALE','CONTEXT_CHANGED'); });
        return;
      }
      if (!(error instanceof Error) || !['MODEL_UNAVAILABLE','MODEL_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_AUTH_FAILURE','PROVIDER_ERROR','MODEL_BUDGET_EXCEEDED','MODEL_BUDGET_EXHAUSTED','MODEL_BUDGET_UNAVAILABLE','MODEL_BUDGET_LIMIT_CHANGED','MODEL_BUDGET_POLICY_CHANGED','MODEL_PRICE_REQUIRED','INVALID_DECISION_OUTPUT','SKILL_UNAVAILABLE','INTELLIGENCE_MODEL_UNAVAILABLE','INVALID_INTELLIGENCE_OUTPUT','CONTEXT_BUDGET_EXCEEDED'].includes(error.message)) throw error;
      await withTransaction(this.#pool, async tx => {
        await acquireDispatchBoundary(tx);
        const current = await this.#conversation(tx, row.conversation_id, true);
        if (!current || Number(current.generation) !== generation || current.state !== 'GENERATING') return;
        if (job) await transitionReplyJob(tx,job.id,'FAILED',['INVALID_INTELLIGENCE_OUTPUT','INVALID_DECISION_OUTPUT','MODEL_BUDGET_EXCEEDED','MODEL_BUDGET_EXHAUSTED','MODEL_BUDGET_UNAVAILABLE','MODEL_BUDGET_LIMIT_CHANGED','MODEL_BUDGET_POLICY_CHANGED','MODEL_PRICE_REQUIRED','MODEL_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_AUTH_FAILURE','PROVIDER_ERROR','CONTEXT_BUDGET_EXCEEDED'].includes(error.message) ? error.message : 'INTELLIGENCE_FAILURE');
        await changeContactPause(tx, row.conversation_id, true);
        const control = (await tx.query<{ generation: number | string }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id])).rows[0];
        await tx.query(`UPDATE orch_conversations SET generation=$2,state='PAUSED_FAILURE',pause_reasons=array_append(pause_reasons,'INTELLIGENCE_FAILURE'),version=version+1 WHERE conversation_id=$1`, [row.conversation_id, Number(control?.generation)]);
      });
      return;
    }
    const pauseRisk = draft.risks.includes('stop_request') ? { reason: 'STOP_REQUEST', state: 'PAUSED_STOP_REQUEST' }
      : draft.risks.includes('unknown_fact') ? { reason: 'MISSING_FACT', state: 'PAUSED_MISSING_FACT' }
      : draft.risks.includes('media_uncertain') ? { reason: 'MEDIA_UNCERTAIN', state: 'PAUSED_MEDIA' } : undefined;
    if (pauseRisk) {
      await withTransaction(this.#pool, async tx => {
        await acquireDispatchBoundary(tx);
        const current = await this.#conversation(tx, row.conversation_id, true);
        if (!current || Number(current.generation) !== generation || current.state !== 'GENERATING') return;
        if (job) await transitionReplyJob(tx,job.id,'SKIPPED',pauseRisk.reason);
        await changeContactPause(tx, row.conversation_id, true);
        const control = await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
        await tx.query(`UPDATE orch_conversations SET generation=$2,state=$3,pause_reasons=array_append(pause_reasons,$4),version=version+1 WHERE conversation_id=$1`, [row.conversation_id, Number(control.rows[0]?.generation), pauseRisk.state, pauseRisk.reason]);
      });
      return;
    }
    if (!draft.shouldReply || draft.timing !== 'now') {
      await withTransaction(this.#pool, async tx => { await acquireDispatchBoundary(tx); const current = await this.#conversation(tx, row.conversation_id, true); if (current && Number(current.generation) === generation && current.state === 'GENERATING') {
        if (job) {const diagnostic=(await tx.query<{decision_record:{action:string;classification_level?:string}|null}>('SELECT decision_record FROM orch_reply_jobs WHERE id=$1',[job.id])).rows[0];await transitionReplyJob(tx,job.id,'SKIPPED',diagnostic?.decision_record?.classification_level==='L4'?'HUMAN_REVIEW_REQUIRED':diagnostic?.decision_record?.action==='ask_user'?'ASK_USER':draft.timing === 'wait' ? 'WAIT' : 'NO_REPLY');}
        await tx.query(`UPDATE orch_conversations SET state=$2,version=version+1 WHERE conversation_id=$1`, [row.conversation_id, deriveState([], current.policy.sendMode)]);
      } });
      return;
    }
    if (!validAlternatives(draft.alternatives)) fail('VALIDATION_FAILED');
    const route = routeReply(row.policy, draft.risks);
    if (route.kind === 'block') fail('POLICY_BLOCKED');
    const triggerMessages = projection.messages.filter(m => messageIds.includes(m.id as string));
    const autoEligible = row.pipeline_version !== 2 && this.#mockAutoEnabled && this.#platform instanceof MockPlatformAdapter && row.policy.sendMode === 'auto'
      && route.kind === 'auto' && draft.risks.every(r => r === 'ordinary') && !Object.keys(draft.skillVersions ?? {}).length
      && triggerMessages.length === messageIds.length && triggerMessages.every(m => m.type === 'text' && m.actor === 'contact' && m.mode === 'live');
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const current = await this.#conversation(tx, row.conversation_id, true);
      if (!current || Number(current.generation) !== generation || Number(current.policy_version) !== Number(row.policy_version) || current.pause_reasons.length || current.state !== 'GENERATING') return;
      if (job) {
        const finalJob = (await tx.query<ReplyJobRow>('SELECT * FROM orch_reply_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
        if (!finalJob || current.current_reply_job_id !== job.id || finalJob.status !== 'VALIDATING'
          || Number(finalJob.conversation_revision) !== Number(current.revision)) return;
      }
      const epochs = await tx.query<{ generation: string | number; dependency_epoch: string | number; skill_epoch: string | number; paused: boolean; unresolved_send_key: string | null }>('SELECT generation,dependency_epoch,skill_epoch,paused,unresolved_send_key FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
      const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
      if (Number(epochs.rows[0]?.generation) !== generation || Number(epochs.rows[0]?.dependency_epoch) !== projection.dependencyEpoch || epochs.rows[0]?.paused || epochs.rows[0]?.unresolved_send_key || global?.paused) return;
      const alternatives = draft.alternatives.map(a => ({ alternativeId: newId(this.#now()), strategySummary: a.strategySummary, parts: a.parts.map(part => ({ replyPartId: newId(this.#now()), sequence: part.sequence, type: 'text' as const, content: part.content })) }));
      const planId = newId(this.#now()), taskId = newId(this.#now());
      const chosen = alternatives[0]!;
      const autoParts = chosen.parts.map(p => ({ type: 'text' as const, content: p.content }));
      const finalHash = autoEligible ? contentHash(autoParts) : null;
      await tx.query(`INSERT INTO orch_plans(id,conversation_id,contact_id,context_snapshot_id,generation,policy_version,dependency_epoch,skill_epoch,trigger_message_ids,fact_versions,analysis_versions,skill_versions,risks,alternatives,status,approved_alternative_id,final_content_hash,generator_version,prompt_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16,$17,$18,$19)`, [planId, row.conversation_id, row.contact_id, projection.snapshot.id, generation, row.policy_version, Number(epochs.rows[0]?.dependency_epoch ?? 0), Number(epochs.rows[0]?.skill_epoch ?? 0), [...messageIds], JSON.stringify(draft.factVersions ?? {}), JSON.stringify(draft.analysisVersions ?? {}), JSON.stringify(draft.skillVersions ?? {}), draft.risks, JSON.stringify(alternatives), autoEligible ? 'APPROVED' : 'AWAITING_CONFIRMATION', autoEligible ? chosen.alternativeId : null, finalHash, draft.generatorVersion, draft.promptVersion ?? null]);
      if (job) {
        await tx.query('UPDATE orch_reply_jobs SET plan_id=$2,context_snapshot_id=$3,generation=$4 WHERE id=$1', [job.id,planId,projection.snapshot.id,generation]);
        await transitionReplyJob(tx,job.id,'PENDING_APPROVAL');
      }
      if (autoEligible) {
        await tx.query(`INSERT INTO orch_mock_auto_approvals(plan_id,content_hash,policy_version,generation,dependency_epoch,skill_epoch,reason) VALUES($1,$2,$3,$4,$5,$6,'LOW_RISK_TEXT')`, [planId, finalHash, row.policy_version, generation, Number(epochs.rows[0]?.dependency_epoch), Number(epochs.rows[0]?.skill_epoch)]);
        for (const part of chosen.parts) await tx.query(`INSERT INTO orch_send_tasks(id,plan_id,reply_part_id,sequence,send_key,content,content_sha256,status,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,'CREATED',$8)`, [newId(this.#now()), planId, part.replyPartId, part.sequence, newId(this.#now()), part.content, sha256(part.content), newId(this.#now())]);
        await tx.query(`UPDATE orch_conversations SET state='SCHEDULED',version=version+1 WHERE conversation_id=$1`, [row.conversation_id]);
      } else {
        const reasonCodes = [...new Set([row.policy.sendMode === 'auto' ? 'AUTO_REVIEW_UNAVAILABLE' : 'CONFIRM_MODE', ...route.reasons, ...draft.risks.filter(r => r !== 'ordinary').map(r => r.toUpperCase())])];
        await tx.query(`INSERT INTO orch_confirmation_tasks(id,plan_id,status,reason_codes) VALUES($1,$2,'PENDING',$3)`, [taskId, planId, reasonCodes]);
        await tx.query(`UPDATE orch_conversations SET state='AWAITING_CONFIRMATION',version=version+1 WHERE conversation_id=$1`, [row.conversation_id]);
      }
      if (!autoEligible) await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'ReplyPlanProposed', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId: newId(this.#now()), causationId, aggregateId: row.conversation_id, aggregateVersion: generation, payload: { planId, contactId: row.contact_id, taskId, mode: 'live' } });
      return { planId, taskId: autoEligible ? '' : taskId };
    });
  }

  async #recordReplyDiagnostics(id:string,decision:unknown,route:unknown,quality?:unknown){
    await withTransaction(this.#pool,async tx=>{await tx.query(`UPDATE orch_reply_jobs j SET decision_record=$2::jsonb,route_record=$3::jsonb,quality_results=COALESCE($4::jsonb,j.quality_results) WHERE j.id=$1 AND j.status IN ('DECIDING','GENERATING','VALIDATING') AND EXISTS(SELECT 1 FROM data_context_snapshots s WHERE s.id=j.context_snapshot_id AND s.status='valid')`,[id,JSON.stringify(decision),JSON.stringify(route),quality===undefined?null:JSON.stringify(quality)]);});
  }
  async #stageReplyJob(id: string, context: PersistentContext, status: ReplyJobState): Promise<boolean> {
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const current = await this.#conversation(tx,context.snapshot.conversationId,true);
      if (!current || current.current_reply_job_id !== id || current.pipeline_version !== 2 || current.state !== 'GENERATING'
        || Number(current.generation) !== context.snapshot.generation || current.pause_reasons.length) return false;
      const job=(await tx.query<ReplyJobRow>('SELECT * FROM orch_reply_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!job||Number(job.conversation_revision)!==Number(current.revision)||!cancellableReplyStates.includes(job.status))return false;
      await this.#data.readContextProjection(tx,{ callerContactId: current.contact_id, contactId: current.contact_id,
        snapshotId: context.snapshot.id, allowedScopes: current.policy.factScopes, expectedDependencyEpoch: context.dependencyEpoch });
      await tx.query('UPDATE orch_reply_jobs SET context_snapshot_id=$2,generation=$3 WHERE id=$1', [id,context.snapshot.id,context.snapshot.generation]);
      await transitionReplyJob(tx,id,status);
      return true;
    });
  }

  async ownerReplyJobs(conversationId: string) {
    return withTransaction(this.#pool, async tx => {
      const row = await this.#conversation(tx,conversationId); if (!row) fail('NOT_FOUND');
      const jobs = await tx.query<{ id: string }>('SELECT id FROM orch_reply_jobs WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [conversationId]);
      const items = [];
      for (const job of jobs.rows) items.push(await readReplyJob(tx,job.id));
      return { pipelineVersion: row.pipeline_version, conversationVersion: Number(row.version),contactId:row.contact_id,factScopes:[...row.policy.factScopes],items };
    });
  }

  async ownerReplyJob(id: string, trace = false) {
    return withTransaction(this.#pool, async tx => {
      const job = await readReplyJob(tx,id);
      if (!trace) return { ...job, transitions: undefined,modelCalls:undefined,feedback:undefined };
      const transitions = (await tx.query('SELECT version,from_status,to_status,reason_code,occurred_at FROM orch_reply_job_transitions WHERE job_id=$1 ORDER BY version', [id])).rows;
      await this.pipeline.models.bind(tx);
      const modelCalls=(await tx.query(`SELECT id,task,provider_key,provider_id,model_id,model_version,prompt_version,route_reason,outcome,error_code,elapsed_ms,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,price_snapshot,cost,started_at,completed_at FROM ai_model_calls_v2 WHERE job_id=$1 AND owner_id=$2 ORDER BY started_at,id`,[id,this.#ownerId])).rows;
      await setContactScope(tx,job.contactId);
      const feedback=job.planId?(await tx.query('SELECT action,reason,rating,shown_alternative_ids,updated_at FROM data_feedback WHERE plan_id=$1 AND contact_id=$2 ORDER BY updated_at',[job.planId,job.contactId])).rows:[];
      return { ...job, transitions,modelCalls,feedback };
    });
  }

  /** Per-conversation opt-in/out; this changes tracking, never sends or grants automation. */
  async setPipelineVersion(conversationId: string, input: { version: PipelineVersion; expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    if (![1,2].includes(input.version) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const row = await this.#conversation(tx,conversationId,true); if (!row) fail('NOT_FOUND');
      const scope = `pipeline:${conversationId}`, hash = sha256(JSON.stringify(input));
      const previous = (await tx.query<{ command_hash: string; result_version: string | number; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [scope,input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version),correlationId: previous.correlation_id,status: 'UPDATED' }; }
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      if (row.pipeline_version !== input.version) {
        await this.#invalidate(tx,conversationId,'PIPELINE_CHANGED');
        await tx.query(`UPDATE orch_conversations SET pipeline_version=$2,current_reply_job_id=NULL,
          state=$3,collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],
          version=version+1,updated_at=now() WHERE conversation_id=$1`,
          [conversationId,input.version,deriveState(row.pause_reasons,row.policy.sendMode,row.policy.agentEnabled)]);
      }
      const changed = (await this.#conversation(tx,conversationId))!;
      const correlationId = newId();
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)',
        [scope,input.idempotencyKey,hash,changed.version,correlationId]);
      return { resultVersion: Number(changed.version),correlationId,status: 'UPDATED' };
    });
  }

  async approveReplyJob(id: string, input: Omit<Parameters<PgConfirmedService['confirmPlan']>[0], 'conversationId' | 'planId'> & { expectedConversationRevision: number }) {
    if (!Number.isSafeInteger(input.expectedConversationRevision) || input.expectedConversationRevision < 1) fail('VALIDATION_FAILED');
    const job = await this.ownerReplyJob(id);
    if (!job.planId) fail('STALE_PLAN');
    const result = await this.confirmPlan({ ...input,conversationId: job.conversationId,planId: job.planId });
    return { ...result,jobId: id,status: 'SEND_QUEUED' };
  }

  async cancelReplyJob(id: string, input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const initial = await readReplyJob(tx,id);
      const row = await this.#conversation(tx,initial.conversationId,true); if (!row) fail('NOT_FOUND');
      const job = (await tx.query<ReplyJobRow>('SELECT * FROM orch_reply_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
      const scope = `cancel-job:${id}`, hash = sha256(JSON.stringify(input));
      const previous = (await tx.query<{ command_hash: string; result_version: string | number; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [scope,input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version),correlationId: previous.correlation_id,status: 'CANCELLED' }; }
      if (Number(job.version) !== input.expectedVersion || row.current_reply_job_id !== id) fail('CONFLICT_VERSION');
      if (!cancellableReplyStates.includes(job.status)) fail('POLICY_BLOCKED');
      // Cancellation cannot hide a submitted part or an ambiguous external attempt.
      if (job.plan_id && (await tx.query(`SELECT id FROM orch_send_tasks WHERE plan_id=$1 AND status NOT IN ('CREATED','CANCELLED_PRE_SUBMIT')
        UNION ALL SELECT send_task_id FROM dispatch_attempts WHERE plan_id=$1`, [job.plan_id])).rows.length) fail('POLICY_BLOCKED');
      await transitionReplyJob(tx,id,'CANCELLED','OWNER_CANCEL');
      await this.#invalidate(tx,row.conversation_id,'OWNER_CANCEL');
      await tx.query(`UPDATE orch_conversations SET state=$2,current_reply_job_id=NULL,collection_started_at=NULL,
        collection_due_at=NULL,collection_message_ids='{}'::uuid[],version=version+1 WHERE conversation_id=$1`,
        [row.conversation_id,deriveState(row.pause_reasons,row.policy.sendMode,row.policy.agentEnabled)]);
      const version = Number(job.version)+1,correlationId = newId();
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [scope,input.idempotencyKey,hash,version,correlationId]);
      return { resultVersion: version,correlationId,status: 'CANCELLED' };
    });
  }

  /** A retry creates new reply work; uncertain/submitted sends never enter this path. */
  async regenerateReplyJob(id:string,input:{expectedVersion:number;expectedConversationRevision:number;idempotencyKey:string}){
    requireText(input.idempotencyKey);if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||!Number.isSafeInteger(input.expectedConversationRevision)||input.expectedConversationRevision<1)fail('VALIDATION_FAILED');
    return withTransaction(this.#pool,async tx=>{
      await acquireDispatchBoundary(tx);const initial=await readReplyJob(tx,id),row=await this.#conversation(tx,initial.conversationId,true);if(!row)fail('NOT_FOUND');
      const scope=`regenerate-job:${id}`,hash=sha256(JSON.stringify(input));
      const prior=(await tx.query<{command_hash:string;result_details:{jobId:string;resultVersion:number;correlationId:string;status:string}}>('SELECT command_hash,result_details FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2',[scope,input.idempotencyKey])).rows[0];
      if(prior){if(prior.command_hash!==hash)fail('CONFLICT_VERSION');return prior.result_details;}
      const job=(await tx.query<ReplyJobRow>('SELECT * FROM orch_reply_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0]!;
      if(row.current_reply_job_id!==id||Number(job.version)!==input.expectedVersion||row.pipeline_version!==2)fail('CONFLICT_VERSION');
      if(Number(row.revision)!==input.expectedConversationRevision||Number(job.conversation_revision)!==input.expectedConversationRevision)fail('STALE_PLAN');
      if(!['FAILED','SKIPPED','STALE','CANCELLED','PENDING_APPROVAL'].includes(job.status)||row.pause_reasons.length||!row.policy.agentEnabled)fail('POLICY_BLOCKED');
      const control=(await tx.query<{paused:boolean;unresolved_send_key:string|null}>('SELECT paused,unresolved_send_key FROM dispatch_control WHERE conversation_id=$1',[row.conversation_id])).rows[0];
      const global=(await tx.query<{paused:boolean}>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
      if(control?.paused||control?.unresolved_send_key||global?.paused||job.plan_id&&(await tx.query('SELECT id FROM orch_send_tasks WHERE plan_id=$1 LIMIT 1',[job.plan_id])).rows.length)fail('POLICY_BLOCKED');
      await setContactScope(tx,row.contact_id);
      const active=(await tx.query('SELECT id FROM data_messages WHERE id=ANY($1::uuid[]) AND contact_id=$2 AND conversation_id=$3::uuid AND actor=\'contact\' AND mode=\'live\' AND deletion_status=\'active\'',[job.trigger_message_ids,row.contact_id,row.conversation_id])).rows;
      if(active.length!==job.trigger_message_ids.length)fail('STALE_PLAN');
      await this.#invalidate(tx,row.conversation_id,'OWNER_REGENERATE');
      const generation=(await tx.query<{generation:string}>('UPDATE dispatch_control SET generation=generation+1 WHERE conversation_id=$1 RETURNING generation',[row.conversation_id])).rows[0]!;
      const at=new Date(this.#now()).toISOString();await tx.query(`UPDATE orch_conversations SET generation=$2,state='COLLECTING',collection_started_at=$3,collection_due_at=$3,collection_message_ids=$4,version=version+1,updated_at=now() WHERE conversation_id=$1`,[row.conversation_id,Number(generation.generation),at,job.trigger_message_ids]);
      const current=(await this.#conversation(tx,row.conversation_id))!,next=await createReplyJob(tx,current,job.trigger_message_ids,scope+':'+input.idempotencyKey,true);
      if(!next)fail('CONFLICT_VERSION');
      const result={jobId:next.id,resultVersion:Number(current.version),correlationId:newId(),status:'GENERATION_REQUESTED'};
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id,result_details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[scope,input.idempotencyKey,hash,result.resultVersion,result.correlationId,JSON.stringify(result)]);return result;
    });
  }

  async #checkPlanJobRevision(tx: PgClient, row: Row, planId: string): Promise<void> {
    const job = (await tx.query<{ conversation_revision: string | number; status: ReplyJobState }>('SELECT conversation_revision,status FROM orch_reply_jobs WHERE plan_id=$1 AND conversation_id=$2', [planId,row.conversation_id])).rows[0];
    if (job && (Number(job.conversation_revision) !== Number(row.revision) || ['STALE','CANCELLED'].includes(job.status))) fail('STALE_PLAN');
  }

  async confirmPlan(command: { conversationId: string; planId: string; taskVersion: number; planVersion: number; alternativeId: string; editedParts: { type: 'text'; content: string }[]; contentHash: string; idempotencyKey: string; shownAlternativeIds?: string[]; expectedConversationRevision?: number }) {
    requireText(command.idempotencyKey);
    if (!command.editedParts.length || command.editedParts.some(p => p.type !== 'text' || !p.content.trim()) || contentHash(command.editedParts) !== command.contentHash) fail('VALIDATION_FAILED');
    if (command.expectedConversationRevision !== undefined && (!Number.isSafeInteger(command.expectedConversationRevision) || command.expectedConversationRevision < 1)) fail('VALIDATION_FAILED');
    const commandHash = sha256(JSON.stringify({ planId: command.planId, taskVersion: command.taskVersion, planVersion: command.planVersion, alternativeId: command.alternativeId, editedParts: command.editedParts, contentHash: command.contentHash,
      ...(command.expectedConversationRevision === undefined ? {} : { expectedConversationRevision: command.expectedConversationRevision }) }));
    const previous = await withTransaction(this.#pool, async tx => {
      const row = await this.#conversation(tx, command.conversationId); if (!row) fail('NOT_FOUND');
      const old = await tx.query<{ command_hash: string; plan_id: string; result_version: string | number }>('SELECT command_hash,plan_id,result_version FROM orch_owner_commands WHERE contact_id=$1 AND idempotency_key=$2', [row.contact_id, command.idempotencyKey]);
      if (!old.rows[0]) return;
      if (old.rows[0].command_hash !== commandHash) fail('CONFLICT_VERSION');
      return { planId: old.rows[0].plan_id, resultVersion: Number(old.rows[0].result_version), duplicate: true };
    });
    if (previous) return previous;
    const preview = await withTransaction(this.#pool, async tx => {
      const row = await this.#conversation(tx, command.conversationId);
      if (!row) fail('NOT_FOUND');
      const plan = await this.#plan(tx, command.planId);
      if (!plan || plan.conversation_id !== row.conversation_id) fail('NOT_FOUND');
      if (command.expectedConversationRevision !== undefined && Number(row.revision) !== command.expectedConversationRevision) fail('STALE_PLAN');
      await this.#checkPlanJobRevision(tx,row,plan.id);
      const current = await this.#readProjection(tx, row, plan);
      return { row, plan, context: current };
    });
    const checked = preview.row.pipeline_version===2&&this.#ai.v2Generations!==undefined?{allowed:true,reasons:[]}:await this.#ai.checkEdited(preview.context, preview.row.policy, command.editedParts);
    if(preview.row.pipeline_version===2){
      const full=adaptDataContextProjection(preview.context),policy={...preview.row.policy,restrictions:[...preview.row.policy.restrictions],stylePreferences:[...(preview.row.policy.stylePreferences??[])]};
      const decision=ruleDecision(full,policy);if(decision.decision.action!=='reply')fail('POLICY_BLOCKED');
      const config=await this.pipeline.models.read();
      const quality=evaluateQualityV2(full,policy,decision.legacy,[{clientAlternativeKey:command.alternativeId,strategySummary:'本人编辑',parts:command.editedParts.map((p,i)=>({...p,clientPartKey:`edit-${i}`,sequence:i+1}))}],config.config.maxReplyCharacters);
      if(quality.some(q=>q.status==='blocked'))fail('POLICY_BLOCKED');
    }
    if (!checked.allowed) fail(checked.reasons.includes('MISSING_FACT') ? 'MISSING_FACT' : 'POLICY_BLOCKED');
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const row = await this.#conversation(tx, command.conversationId, true); if (!row) fail('NOT_FOUND');
      const old = await tx.query<{ command_hash: string; plan_id: string; result_version: string | number }>('SELECT command_hash,plan_id,result_version FROM orch_owner_commands WHERE contact_id=$1 AND idempotency_key=$2', [row.contact_id, command.idempotencyKey]);
      if (old.rows[0]) { if (old.rows[0].command_hash !== commandHash) fail('CONFLICT_VERSION'); return { planId: old.rows[0].plan_id, resultVersion: Number(old.rows[0].result_version), duplicate: true }; }
      const plan = await this.#plan(tx, command.planId, true);
      if (command.expectedConversationRevision !== undefined && Number(row.revision) !== command.expectedConversationRevision) fail('STALE_PLAN');
      if (plan) await this.#checkPlanJobRevision(tx,row,plan.id);
      const task = await this.#task(tx, command.planId, true);
      const control = await tx.query<{ generation: string | number; dependency_epoch: string | number; skill_epoch: string | number; paused: boolean; unresolved_send_key: string | null }>('SELECT generation,dependency_epoch,skill_epoch,paused,unresolved_send_key FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
      const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
      if (!plan || !task || plan.conversation_id !== row.conversation_id || plan.status !== 'AWAITING_CONFIRMATION' || task.status !== 'PENDING' || Number(plan.version) !== command.planVersion || Number(task.version) !== command.taskVersion || Number(plan.generation) !== Number(row.generation) || Number(plan.generation) !== Number(control.rows[0]?.generation) || Number(plan.policy_version) !== Number(row.policy_version) || Number(plan.dependency_epoch) !== Number(control.rows[0]?.dependency_epoch) || Number(plan.skill_epoch) !== Number(control.rows[0]?.skill_epoch) || control.rows[0]?.paused || control.rows[0]?.unresolved_send_key || global?.paused || row.pause_reasons.length) fail('STALE_PLAN');
      const alternative = plan.alternatives.find(a => a.alternativeId === command.alternativeId);
      if (!alternative || alternative.parts.length !== command.editedParts.length) fail('VALIDATION_FAILED');
      await this.#readProjection(tx, row, plan);
      const newVersion = Number(plan.version) + 1;
      await tx.query(`UPDATE orch_plans SET status='APPROVED',approved_alternative_id=$2,final_content_hash=$3,version=$4,updated_at=now() WHERE id=$1`, [plan.id, alternative.alternativeId, command.contentHash, newVersion]);
      await tx.query(`UPDATE orch_confirmation_tasks SET status='RESOLVED',confirmed_content_hash=$2,confirmed_plan_version=$3,version=version+1,updated_at=now() WHERE id=$1`, [task.id, command.contentHash, newVersion]);
      for (let i = 0; i < command.editedParts.length; i++) {
        const part = command.editedParts[i]!;
        await tx.query(`INSERT INTO orch_send_tasks(id,plan_id,reply_part_id,sequence,send_key,content,content_sha256,status,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,'CREATED',$8)`, [newId(this.#now()), plan.id, alternative.parts[i]!.replyPartId, i + 1, newId(this.#now()), part.content, sha256(part.content), newId(this.#now())]);
      }
      await tx.query(`INSERT INTO orch_owner_commands(contact_id,idempotency_key,command_hash,plan_id,result_version) VALUES($1,$2,$3,$4,$5)`, [row.contact_id, command.idempotencyKey, commandHash, plan.id, newVersion]);
      await tx.query(`UPDATE orch_conversations SET state='SCHEDULED',version=version+1 WHERE conversation_id=$1`, [row.conversation_id]);
      await transitionPlanJob(tx,plan.id,'SEND_QUEUED','OWNER_APPROVED');
      await this.#feedback.recordOutcome(tx, { callerContactId: row.contact_id, contactId: row.contact_id, planId: plan.id,
        shownAlternativeIds: command.shownAlternativeIds, at: new Date(this.#now()).toISOString(),
        action: alternative.parts.every((part, i) => part.content === command.editedParts[i]?.content) ? 'selected' : 'edited' });
      return { planId: plan.id, resultVersion: newVersion, duplicate: false };
    });
  }

  async recover(): Promise<void> {
    await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      if (this.#platform.accountId !== 'core-no-dispatch') await registerPlatformAccount(tx, this.#platform.accountId, this.#platform.platform);
      const accountId = this.#platform.accountId === 'core-no-dispatch' ? undefined : this.#platform.accountId;
      await recoverAmbiguous(tx, accountId);
      const attempts = await tx.query<{ send_task_id: string; conversation_id: string; status: string; platform_message_id: string | null }>(`SELECT send_task_id,conversation_id,status,platform_message_id FROM dispatch_attempts WHERE ($1::text IS NULL OR account_id=$1)`, [accountId ?? null]);
      for (const a of attempts.rows) await this.#recordSendResult(tx, a.send_task_id, a.status, a.platform_message_id);
    });
    const pending = await withTransaction(this.#pool, async tx => (await tx.query<Row>(`SELECT * FROM orch_conversations WHERE state='GENERATING' AND last_inbound_message_id IS NOT NULL AND ($1::text IS NULL OR account_id=$1)`, [this.#platform.accountId === 'core-no-dispatch' ? null : this.#platform.accountId])).rows);
    for (const row of pending) {
      const triggerIds = row.pipeline_version === 2 && row.current_reply_job_id ? await withTransaction(this.#pool,async tx =>
        (await tx.query<{ trigger_message_ids: string[] }>('SELECT trigger_message_ids FROM orch_reply_jobs WHERE id=$1 AND conversation_id=$2', [row.current_reply_job_id,row.conversation_id])).rows[0]?.trigger_message_ids) : undefined;
      await this.#proposeFor(row, Number(row.generation), triggerIds ?? [row.last_inbound_message_id!], newId(this.#now()));
    }
    // A batch that was still collecting when the worker died is due-by-deadline, not by wall clock.
    for (const conversationId of await this.claimDueCollections()) await this.flushDue(conversationId);
    this.#recovered = true;
  }

  /** Claims due aggregation batches without holding a lock across the model call. */
  async claimDueCollections(limit = 20, accountId?: string): Promise<string[]> {
    if (this.#platform.accountId !== 'core-no-dispatch' && accountId !== undefined && accountId !== this.#platform.accountId) fail('FORBIDDEN');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => (await tx.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM orch_conversations
       WHERE state='COLLECTING' AND collection_due_at IS NOT NULL AND collection_due_at <= now() AND ($2::text IS NULL OR account_id=$2)
       ORDER BY collection_due_at,conversation_id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit, accountId ?? (this.#platform.accountId === 'core-no-dispatch' ? null : this.#platform.accountId)])).rows.map(row => row.conversation_id));
  }

  /** Conversations with approved but not yet submitted parts, for the dispatch worker. */
  async dispatchableConversations(limit = 20, accountId = this.#platform.accountId): Promise<string[]> {
    if (accountId !== this.#platform.accountId) fail('FORBIDDEN');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => (await tx.query<{ conversation_id: string }>(
      `SELECT DISTINCT p.conversation_id FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id JOIN orch_conversations c ON c.conversation_id=p.conversation_id
       WHERE s.status='CREATED' AND p.status IN ('APPROVED','PARTIALLY_SENT') AND c.account_id=$2 LIMIT $1`, [limit, accountId])).rows.map(row => row.conversation_id));
  }

  /** Flushes one due batch. The generation CAS inside #proposeFor makes a double flush harmless. */
  async flushDue(conversationId: string): Promise<{ planId: string; taskId: string } | undefined> {
    const claimed = await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const row = await this.#conversation(tx, conversationId, true);
      if (!row || row.state !== 'COLLECTING' || !row.collection_due_at) return undefined;
      if (this.#platform.accountId !== 'core-no-dispatch' && row.account_id !== this.#platform.accountId) fail('FORBIDDEN');
      if (toMs(row.collection_due_at) > this.#now()) return undefined;
      const messageIds = row.collection_message_ids ?? [];
      if (!messageIds.length) return undefined;
      await tx.query(`UPDATE orch_conversations SET state='GENERATING',collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],last_inbound_message_id=$2,version=version+1,updated_at=now() WHERE conversation_id=$1`,
        [conversationId, messageIds.at(-1)]);
      return { row, generation: Number(row.generation), messageIds };
    });
    if (!claimed) return undefined;
    return this.#proposeFor(claimed.row, claimed.generation, claimed.messageIds, newId(this.#now()));
  }

  async dispatchNext(conversationId: string): Promise<{ id: string; status: string } | undefined> {
    if (!this.#recovered) fail('RECOVERY_REQUIRED');
    const candidate = await withTransaction(this.#pool, async tx => {
      const row = await this.#conversation(tx, conversationId); if (!row) fail('NOT_FOUND');
      if (row.account_id !== this.#platform.accountId) fail('FORBIDDEN');
      const sends = await tx.query<SendRow>(`SELECT s.* FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id WHERE p.conversation_id=$1 AND s.status='CREATED' AND p.status IN ('APPROVED','PARTIALLY_SENT') ORDER BY p.created_at,s.sequence LIMIT 1`, [conversationId]);
      const send = sends.rows[0]; if (!send) return;
      const plan = await this.#plan(tx, send.plan_id); if (!plan) fail('NOT_FOUND');
      const control = await tx.query<{ dependency_epoch: string | number; skill_epoch: string | number; pause_epoch: string | number; generation: string | number; policy_version: string | number }>('SELECT * FROM dispatch_control WHERE conversation_id=$1', [conversationId]);
      const global = await tx.query<{ pause_epoch: string | number }>('SELECT pause_epoch FROM dispatch_global_control WHERE singleton=true');
      return { row, plan, send, control: control.rows[0]!, global: global.rows[0]! };
    });
    if (!candidate) return;
    const { row, plan, send, control, global } = candidate;
    const claim: DispatchClaim = { sendTaskId: send.id, planId: plan.id, conversationId, accountId: row.account_id, sendKey: send.send_key, sequence: send.sequence, mode: 'live', contentSha256: send.content_sha256,
      generation: Number(control.generation), policyVersion: Number(control.policy_version), dependencyEpoch: Number(control.dependency_epoch), skillEpoch: Number(control.skill_epoch), pauseEpoch: Number(control.pause_epoch), globalPauseEpoch: Number(global.pause_epoch) };
    const result = await withDispatchLease(this.#pool, claim, async tx => {
      const current = await this.#conversation(tx, conversationId, true);
      const p = await this.#plan(tx, plan.id, true);
      if (current?.account_id !== this.#platform.accountId) fail('FORBIDDEN');
      const t = await this.#task(tx, plan.id, true);
      const auto = (await tx.query<{ content_hash: string; policy_version: number | string; generation: number | string; dependency_epoch: number | string; skill_epoch: number | string }>('SELECT * FROM orch_mock_auto_approvals WHERE plan_id=$1', [plan.id])).rows[0];
      const s = await tx.query<SendRow>('SELECT * FROM orch_send_tasks WHERE id=$1 FOR UPDATE', [send.id]);
      const prior = await tx.query<{ sequence: number; status: string }>('SELECT sequence,status FROM orch_send_tasks WHERE plan_id=$1 AND sequence<$2', [plan.id, send.sequence]);
      const manualApproved = !!t && t.status === 'RESOLVED' && t.confirmed_content_hash === p?.final_content_hash;
      const mockAutoApproved = !!auto && this.#mockAutoEnabled && this.#platform instanceof MockPlatformAdapter && current?.policy.sendMode === 'auto'
        && p?.risks.every(r => r === 'ordinary') && auto.content_hash === p?.final_content_hash
        && Number(auto.generation) === claim.generation && Number(auto.policy_version) === claim.policyVersion
        && Number(auto.dependency_epoch) === claim.dependencyEpoch && Number(auto.skill_epoch) === claim.skillEpoch;
      if (!current || !p || !s.rows[0] || current.pause_reasons.length || current.policy.agentEnabled !== true || p.status !== 'APPROVED' && p.status !== 'PARTIALLY_SENT' || s.rows[0].status !== 'CREATED' || !manualApproved && !mockAutoApproved || Number(p.generation) !== Number(current.generation) || Number(p.generation) !== claim.generation || Number(p.policy_version) !== Number(current.policy_version) || Number(p.dependency_epoch) !== claim.dependencyEpoch || Number(p.skill_epoch) !== claim.skillEpoch || sha256(s.rows[0].content) !== s.rows[0].content_sha256 || prior.rows.some(x => !['SUBMITTED','DELIVERED'].includes(x.status))) fail('STALE_PLAN');
      const all = await tx.query<{ content: string }>('SELECT content FROM orch_send_tasks WHERE plan_id=$1 ORDER BY sequence', [plan.id]);
      if (contentHash(all.rows.map(x => ({ type: 'text', content: x.content }))) !== p.final_content_hash) fail('STALE_PLAN');
      await this.#readProjection(tx, current, p);
      await this.#checkPlanJobRevision(tx,current,p.id);
      await transitionPlanJob(tx,p.id,'SENDING');
    }, async () => {
      const observed = await this.#platform.submitSend({ sendTaskId: send.id, sendKey: send.send_key, conversationRef: { accountId: row.account_id, conversationId, externalContactRef: row.external_contact_ref }, partType: 'text', content: send.content, deadline: new Date(this.#now() + 30_000).toISOString(), mode: 'live', correlationId: send.correlation_id }, this.#authority, async () => true);
      return { status: observed.status as 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE' | 'RESULT_UNKNOWN', platformMessageId: observed.platformMessageId, receiptLevel: observed.receiptLevel, evidenceRef: observed.status === 'FAILED_DEFINITE' ? `${this.#platform.platform}:${observed.correlationId ?? send.correlation_id}` : undefined };
    });
    await withTransaction(this.#pool, async tx => { await acquireDispatchBoundary(tx); await this.#recordSendResult(tx, send.id, result.status, result.platformMessageId ?? null); });
    return { id: send.id, status: result.status };
  }

  async applyReceipt(event: Event): Promise<void> {
    if (event.eventType !== 'PlatformReceiptObserved') fail('VALIDATION_FAILED');
    const receipt = event.payload as unknown as SendResult & { sendKey: string };
    await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      await consumeOnce(tx, '02-receipt', event.eventId, async () => {
        const send = await tx.query<SendRow>('SELECT * FROM orch_send_tasks WHERE id=$1 AND send_key=$2 FOR UPDATE', [receipt.sendTaskId, receipt.sendKey]);
        if (!send.rows[0]) return;
        if (!['SUBMITTED','DELIVERED','FAILED_DEFINITE','RESULT_UNKNOWN'].includes(receipt.status)) fail('VALIDATION_FAILED');
        await finishDispatch(tx, receipt.sendKey, { status: receipt.status as 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE' | 'RESULT_UNKNOWN', platformMessageId: receipt.platformMessageId, receiptLevel: receipt.receiptLevel, evidenceRef: receipt.status === 'FAILED_DEFINITE' ? `${this.#platform.platform}:${receipt.correlationId}` : undefined });
        await this.#recordSendResult(tx, send.rows[0].id, receipt.status, receipt.platformMessageId ?? null);
      });
    });
  }

  async ownerOverview() {
    return withTransaction(this.#pool, async tx => {
      const global = (await tx.query<{ paused: boolean; pause_epoch: number | string }>('SELECT paused,pause_epoch FROM dispatch_global_control WHERE singleton=true')).rows[0];
      if (!global) fail('NOT_FOUND');
      const counts = (await tx.query<{ pending: string; unknown: string }>(`SELECT (SELECT count(*) FROM orch_confirmation_tasks WHERE status='PENDING')::text AS pending,
        (SELECT count(*) FROM orch_send_tasks WHERE status='RESULT_UNKNOWN')::text AS unknown`)).rows[0]!;
      const health = (await tx.query<{ account_id: string; healthy: boolean; fault_code: string | null; version: string; held: boolean }>(`SELECT h.*,
        EXISTS(SELECT 1 FROM orch_conversations c WHERE c.account_id=h.account_id AND 'ACCOUNT_FAULT'=ANY(c.pause_reasons)) AS held
        FROM orch_account_health h ORDER BY h.account_id`)).rows;
      const coverage = (await tx.query<{ covered: boolean }>(`SELECT EXISTS(SELECT 1 FROM orch_account_health) AND NOT EXISTS(
        SELECT 1 FROM orch_conversations c WHERE NOT EXISTS(SELECT 1 FROM orch_account_health h WHERE h.account_id=c.account_id)) AS covered`)).rows[0]?.covered === true;
      const summaries: Record<string,string> = { BRIDGE_RESTARTED: '桥接重新启动，账号保持暂停', PROCESS_EXITED: '平台进程已退出，账号已暂停',
        HOOK_LOGIN_ABNORMAL: '接收长时间无事件且登录探测异常，账号已暂停', HELPER_UNRESPONSIVE: '微信 helper 无响应或响应异常，账号已暂停' };
      const faults = health.filter(h => !h.healthy || h.held).map((h, index) => ({ id: `account-fault-${index + 1}`, version: Number(h.version),
        status: h.healthy ? 'RECOVERED_AWAITING_OWNER' : 'ACTIVE', summary: summaries[h.fault_code ?? ''] ?? '账号健康状态未知，保持暂停', allowedActions: [] }));
      return { id: 'global', version: Number(global.pause_epoch), status: global.paused ? 'PAUSED' : 'ACTIVE', globalPaused: global.paused,
        allowedActions: global.paused ? ['resumeAll'] : ['pauseAll','resumeAll'], pendingCount: Number(counts.pending), unknownSendCount: Number(counts.unknown),
        connectionQueryStatus: 'ready' as const, faultQueryStatus: coverage ? 'ready' as const : 'unavailable' as const,
        connections: (await tx.query<{ account_id: string; platform: string | null; healthy: boolean | null; observed_at: string | null }>(`SELECT a.*,h.healthy,h.observed_at FROM orch_platform_accounts a LEFT JOIN orch_account_health h ON h.account_id=a.account_id ORDER BY a.account_id`)).rows.map(a => ({
          accountId: a.account_id, platform: a.platform ?? 'unknown',
          connectionState: !a.observed_at || this.#now()-toMs(a.observed_at)>30_000 ? 'unknown' : a.healthy ? 'probe_healthy' : 'disconnected',
          lastReconciledAt: a.observed_at ? new Date(a.observed_at).toISOString() : undefined,
          limitations: ['最近健康探测不证明消息历史完整'],
        })), faults };
    });
  }

  async ownerTasks(contactId?: string) {
    return withTransaction(this.#pool, async tx => {
      const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
      const rows = await tx.query<TaskRow & { contact_id: string; conversation_id: string; plan_version: number | string; plan_status: string; context_snapshot_id: string; policy_version: number | string; alternatives: PlanRow['alternatives']; trigger_message_ids: string[]; generation: number | string; current_generation: number | string; dependency_epoch: number | string; current_dependency_epoch: number | string; skill_epoch: number | string; current_skill_epoch: number | string; paused: boolean; unresolved_send_key: string | null; pause_reasons: string[] }>(`SELECT t.*,p.contact_id,p.conversation_id,p.version AS plan_version,p.status AS plan_status,p.context_snapshot_id,p.policy_version,p.alternatives,p.trigger_message_ids,p.generation,dc.generation AS current_generation,p.dependency_epoch,dc.dependency_epoch AS current_dependency_epoch,p.skill_epoch,dc.skill_epoch AS current_skill_epoch,dc.paused,dc.unresolved_send_key,o.pause_reasons
        FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id JOIN orch_conversations o ON o.conversation_id=p.conversation_id JOIN dispatch_control dc ON dc.conversation_id=p.conversation_id
        WHERE ($1::uuid IS NULL OR p.contact_id=$1)
        ORDER BY (t.status='PENDING' OR p.status IN ('APPROVED','PARTIALLY_SENT','RESULT_UNKNOWN')
          OR EXISTS (SELECT 1 FROM orch_send_tasks s WHERE s.plan_id=p.id AND s.status IN ('CREATED','RESULT_UNKNOWN'))) DESC,
          t.updated_at DESC,t.id DESC LIMIT 100`, [contactId ?? null]);
      const items = [];
      for (const t of rows.rows) {
        await setContactScope(tx, t.contact_id);
        const detail = (await tx.query<{ display_name: string; snapshot_status: string; send_mode: string }>(`SELECT c.display_name,s.status AS snapshot_status,o.policy->>'sendMode' AS send_mode FROM data_contacts c JOIN data_context_snapshots s ON s.contact_id=c.id JOIN orch_conversations o ON o.contact_id=c.id WHERE c.id=$1 AND s.id=$2`, [t.contact_id, t.context_snapshot_id])).rows[0];
        if (!detail) fail('STALE_PLAN');
        const messages = await tx.query<{ id: string; type: string; content_ref: string | null; sent_at: Date | string }>('SELECT id,type,content_ref,sent_at FROM data_messages WHERE id=ANY($1::uuid[]) AND contact_id=$2', [t.trigger_message_ids, t.contact_id]);
        const sends = await tx.query<SendRow>('SELECT * FROM orch_send_tasks WHERE plan_id=$1 ORDER BY sequence', [t.plan_id]);
        const active = !global?.paused && !t.paused && !t.unresolved_send_key && t.status === 'PENDING' && t.plan_status === 'AWAITING_CONFIRMATION' && detail.snapshot_status === 'valid' && Number(t.generation) === Number(t.current_generation) && Number(t.dependency_epoch) === Number(t.current_dependency_epoch) && Number(t.skill_epoch) === Number(t.current_skill_epoch) && !t.pause_reasons.length;
        const jobId=(await tx.query<{id:string}>('SELECT id FROM orch_reply_jobs WHERE plan_id=$1',[t.plan_id])).rows[0]?.id;
        const replyJob=jobId?await readReplyJob(tx,jobId):undefined;
        items.push({ replyJob, id: t.id, taskId: t.id, version: Number(t.version), taskVersion: Number(t.version), status: t.plan_status, allowedActions: active ? ['confirmPlan', 'rejectPlan', ...(detail.send_mode === 'confirm' ? ['regeneratePlan'] : [])] : [], reasonCodes: t.reason_codes,
          planId: t.plan_id, planVersion: Number(t.plan_version), contactId: t.contact_id, contactName: detail.display_name, conversationId: t.conversation_id,
          triggerMessages: t.trigger_message_ids.map(id => { const m = messages.rows.find(x => x.id === id); return { id, type: m?.type ?? 'text', text: m?.content_ref ?? undefined, at: m?.sent_at instanceof Date ? m.sent_at.toISOString() : String(m?.sent_at ?? '') }; }),
          alternatives: t.alternatives, sends: sends.rows.map(s => ({ sendTaskId: s.id, version: Number(s.version), sequence: s.sequence, status: s.status, receiptLevel: s.status === 'DELIVERED' ? 'delivered' : s.status === 'SUBMITTED' ? 'accepted' : s.status === 'RESULT_UNKNOWN' ? 'unknown' : undefined, platformMessageId: s.receipt?.platformMessageId ?? undefined, correlationId: s.correlation_id })), contextSnapshotId: t.context_snapshot_id, policyVersion: Number(t.policy_version) });
      }
      return { items };
    });
  }

  async ownerContacts(contactId?: string) {
    return withTransaction(this.#pool, async tx => {
      const rows = await tx.query<Row>('SELECT c.*,a.platform AS account_platform FROM orch_conversations c LEFT JOIN orch_platform_accounts a ON a.account_id=c.account_id WHERE ($1::uuid IS NULL OR c.contact_id=$1) ORDER BY c.contact_id', [contactId ?? null]);
      const items = [];
      for (const row of rows.rows) {
        await setContactScope(tx, row.contact_id);
        const contact = (await tx.query<{ display_name: string }>('SELECT display_name FROM data_contacts WHERE id=$1', [row.contact_id])).rows[0];
        if (!contact) fail('FORBIDDEN');
        items.push({ id: row.contact_id, version: Number(row.version), status: row.state,
          allowedActions: [...(row.pause_reasons.length ? ['resumeContact', 'resumeRoutine', 'updatePolicy'] : ['pauseContact', 'updatePolicy']), ...(Number(row.paused_inbound_unreviewed_count) ? ['acknowledgePausedInbound'] : [])],
          name: contact.display_name, platform: (row as Row & { account_platform?: string }).account_platform ?? 'unknown', agentEnabled: row.policy.agentEnabled, sendMode: row.policy.sendMode, goal: row.policy.goal,
          activeContactEnabled: row.policy.activeContactEnabled, activeConfessionEnabled: row.policy.activeConfessionEnabled,
          allowedWindows: row.policy.allowedWindows.map(w => `${w.start}-${w.end}`), restrictions: row.policy.restrictions,
          stylePreferences: row.policy.stylePreferences ?? [], pauseReasons: row.pause_reasons, policyVersion: Number(row.policy_version),
          unreviewedPausedInboundCount: Number(row.paused_inbound_unreviewed_count) });
      }
      return { items };
    });
  }

  async confirmTask(taskId: string, input: Omit<Parameters<PgConfirmedService['confirmPlan']>[0], 'conversationId' | 'planId'>) {
    const task = await withTransaction(this.#pool, async tx => (await tx.query<{ plan_id: string; conversation_id: string }>(`SELECT t.plan_id,p.conversation_id FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id WHERE t.id=$1`, [taskId])).rows[0]);
    if (!task) fail('NOT_FOUND');
    const result = await this.confirmPlan({ ...input, conversationId: task.conversation_id, planId: task.plan_id });
    return { resultVersion: result.resultVersion, correlationId: newId(this.#now()), status: 'SCHEDULED' };
  }

  async recordTaskPresentation(taskId: string, input: { expectedVersion: number; idempotencyKey: string; shownAlternativeIds: string[] }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const target = (await tx.query<{ plan_id: string; contact_id: string; version: string | number }>(
        'SELECT t.plan_id,p.contact_id,t.version FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id WHERE t.id=$1', [taskId])).rows[0];
      if (!target) fail('NOT_FOUND');
      if (Number(target.version) !== input.expectedVersion) fail('STALE_PLAN');
      await this.#feedback.recordPresentation(tx, { callerContactId: target.contact_id, contactId: target.contact_id,
        planId: target.plan_id, shownAlternativeIds: input.shownAlternativeIds, at: new Date(this.#now()).toISOString() });
      return { resultVersion: Number(target.version), correlationId: newId(this.#now()), status: 'RECORDED' };
    });
  }

  async rejectTask(taskId: string, input: { expectedVersion: number; idempotencyKey: string; rejectionReason?: RejectionReason; shownAlternativeIds?: string[] }) {
    requireText(input.idempotencyKey);
    if (input.rejectionReason !== undefined && !validRejectionReason(input.rejectionReason)) fail('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const target = (await tx.query<{ plan_id: string; conversation_id: string; contact_id: string }>(`SELECT t.plan_id,p.conversation_id,p.contact_id FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id WHERE t.id=$1`, [taskId])).rows[0];
      if (!target) fail('NOT_FOUND');
      const hash = sha256(JSON.stringify({ action: 'rejectTask', taskId, expectedVersion: input.expectedVersion, rejectionReason: input.rejectionReason }));
      const row = await this.#conversation(tx, target.conversation_id, true);
      const plan = await this.#plan(tx, target.plan_id, true);
      const task = await this.#task(tx, target.plan_id, true);
      const previous = (await tx.query<{ command_hash: string; result_version: number | string }>('SELECT command_hash,result_version FROM orch_owner_commands WHERE contact_id=$1 AND idempotency_key=$2', [target.contact_id, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: newId(this.#now()), status: 'REJECTED' }; }
      if (!row || !plan || !task || task.id !== taskId || task.status !== 'PENDING' || plan.status !== 'AWAITING_CONFIRMATION' || Number(task.version) !== input.expectedVersion || Number(plan.generation) !== Number(row.generation)) fail('STALE_PLAN');
      const version = Number(plan.version) + 1;
      await tx.query(`UPDATE orch_confirmation_tasks SET status='REJECTED',version=version+1,updated_at=now() WHERE id=$1`, [taskId]);
      await tx.query(`UPDATE orch_plans SET status='REJECTED',version=$2,updated_at=now() WHERE id=$1`, [plan.id, version]);
      await transitionPlanJob(tx,plan.id,'CANCELLED','OWNER_REJECTED');
      await tx.query(`UPDATE orch_conversations SET state='READY_CONFIRM',version=version+1 WHERE conversation_id=$1 AND state='AWAITING_CONFIRMATION'`, [row.conversation_id]);
      await tx.query('INSERT INTO orch_owner_commands(contact_id,idempotency_key,command_hash,plan_id,result_version) VALUES($1,$2,$3,$4,$5)', [target.contact_id, input.idempotencyKey, hash, plan.id, version]);
      await this.#feedback.recordOutcome(tx, { callerContactId: target.contact_id, contactId: target.contact_id, planId: plan.id,
        action: 'rejected', rejectionReason: input.rejectionReason, shownAlternativeIds: input.shownAlternativeIds, at: new Date(this.#now()).toISOString() });
      return { resultVersion: version, correlationId: newId(this.#now()), status: 'REJECTED' };
    });
  }

  /** Replace an unconfirmed plan with a durable generation request; never schedules a send. */
  async regenerateTask(taskId: string, input: { expectedVersion: number; idempotencyKey: string; shownAlternativeIds?: string[] }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const scope = `regenerate:${taskId}`;
      const hash = sha256(JSON.stringify({ taskId, expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [scope, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'GENERATION_REQUESTED' }; }
      const target = (await tx.query<{ plan_id: string; conversation_id: string }>('SELECT t.plan_id,p.conversation_id FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id WHERE t.id=$1', [taskId])).rows[0];
      if (!target) fail('NOT_FOUND');
      const row = await this.#conversation(tx, target.conversation_id, true);
      const plan = await this.#plan(tx, target.plan_id, true);
      const task = await this.#task(tx, target.plan_id, true);
      if (!row || !plan || !task || task.status !== 'PENDING' || plan.status !== 'AWAITING_CONFIRMATION'
        || Number(task.version) !== input.expectedVersion || Number(plan.generation) !== Number(row.generation)
        || Number(plan.policy_version) !== Number(row.policy_version) || !row.last_inbound_message_id
        || !plan.trigger_message_ids.includes(row.last_inbound_message_id)) fail('STALE_PLAN');
      const control = (await tx.query<{ paused: boolean; unresolved_send_key: string | null; skill_epoch: number | string }>('SELECT paused,unresolved_send_key,skill_epoch FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id])).rows[0];
      const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
      if (!control || !global || control.paused || control.unresolved_send_key || global.paused || row.pause_reasons.length
        || !row.policy.agentEnabled || row.policy.sendMode !== 'confirm') fail('POLICY_BLOCKED');
      if (Number(control.skill_epoch) !== Number(plan.skill_epoch)) fail('STALE_PLAN');
      await this.#readProjection(tx, row, plan);
      if ((await tx.query('SELECT id FROM orch_send_tasks WHERE plan_id=$1 LIMIT 1', [plan.id])).rows.length) fail('STALE_PLAN');
      if (input.shownAlternativeIds !== undefined) await this.#feedback.recordPresentation(tx, { callerContactId: row.contact_id, contactId: row.contact_id, planId: plan.id,
        shownAlternativeIds: input.shownAlternativeIds, at: new Date(this.#now()).toISOString() });
      await this.#invalidate(tx, row.conversation_id, 'OWNER_REGENERATE');
      const at = new Date(this.#now()).toISOString();
      const changed = await tx.query<{ version: number | string }>(`UPDATE orch_conversations SET state='COLLECTING',
        collection_started_at=$2::timestamptz,collection_due_at=$2::timestamptz,collection_message_ids=$3::uuid[],
        version=version+1,updated_at=now() WHERE conversation_id=$1 RETURNING version`, [row.conversation_id, at, plan.trigger_message_ids]);
      const version = Number(changed.rows[0]!.version), correlationId = newId(this.#now());
      if (row.pipeline_version === 2) await createReplyJob(tx,(await this.#conversation(tx,row.conversation_id))!,plan.trigger_message_ids,scope+':'+input.idempotencyKey,true);
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [scope, input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: 'GENERATION_REQUESTED' };
    });
  }

  async pauseAll(input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'pauseAll', expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', ['global', input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'PAUSED' }; }
      const global = (await tx.query<{ pause_epoch: number | string }>('SELECT pause_epoch FROM dispatch_global_control WHERE singleton=true FOR UPDATE')).rows[0];
      if (!global || Number(global.pause_epoch) !== input.expectedVersion) fail('CONFLICT_VERSION');
      const version = await changeGlobalPause(tx, true);
      const conversations = await tx.query<{ conversation_id: string }>('SELECT conversation_id FROM orch_conversations ORDER BY conversation_id FOR UPDATE');
      for (const row of conversations.rows) {
        await this.#invalidate(tx, row.conversation_id, 'GLOBAL_PAUSE');
        await tx.query(`UPDATE orch_conversations SET state='PAUSED_GLOBAL',pause_reasons=array_append(pause_reasons,'GLOBAL_PAUSE'),version=version+1 WHERE conversation_id=$1 AND NOT ('GLOBAL_PAUSE'=ANY(pause_reasons))`, [row.conversation_id]);
      }
      const correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', ['global', input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: 'PAUSED' };
    });
  }

  async pauseContact(contactId: string, input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'pauseContact', contactId, expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [contactId, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'PAUSED' }; }
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      await changeContactPause(tx, row.conversation_id, true);
      await this.#invalidate(tx, row.conversation_id, 'OWNER_PAUSE');
      const control = (await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id])).rows[0]!;
      const changed = await tx.query<{ version: string | number }>(`UPDATE orch_conversations SET generation=$2,state='PAUSED_OWNER',pause_reasons=array_append(pause_reasons,'OWNER_PAUSE'),version=version+1 WHERE conversation_id=$1 RETURNING version`, [row.conversation_id, Number(control.generation)]);
      const version = Number(changed.rows[0]!.version), correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [contactId, input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: 'PAUSED' };
    });
  }

  /** Owner management projection across contacts: each contact is read under its own scope. */
  /** Owner decision for a send whose platform result could not be established (RESULT_UNKNOWN).
   * Only evidence-backed outcomes are accepted, the transition must be one the dispatch journal
   * allows out of RESULT_UNKNOWN, and nothing here retries. With `resume` the owner also clears the
   * UNKNOWN_SEND pause in the same transaction; any other pause reason still keeps the contact paused. */
  async resolveUnknownSend(sendTaskId: string, input: { status: 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE'; evidenceRef: string; expectedVersion: number; idempotencyKey: string; platformMessageId?: string; resume?: boolean }) {
    requireText(input.idempotencyKey);
    requireText(input.evidenceRef);
    if (!['SUBMITTED', 'DELIVERED', 'FAILED_DEFINITE'].includes(input.status)) fail('VALIDATION_FAILED');
    if (input.resume !== undefined && typeof input.resume !== 'boolean') fail('VALIDATION_FAILED');
    const resume = input.resume === true;
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('VALIDATION_FAILED');
    if (input.platformMessageId !== undefined) requireText(input.platformMessageId);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const scope = `send:${sendTaskId}`;
      const hash = sha256(JSON.stringify({ action: 'resolveUnknownSend', sendTaskId, status: input.status,
        evidenceRef: input.evidenceRef, platformMessageId: input.platformMessageId ?? null, expectedVersion: input.expectedVersion,
        ...(resume ? { resume } : {}) }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>(
        'SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [scope, input.idempotencyKey])).rows[0];
      if (previous) {
        if (previous.command_hash !== hash) fail('CONFLICT_VERSION');
        return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: input.status, ...(resume ? { clearedReason: 'UNKNOWN_SEND' } : {}) };
      }
      const found = await tx.query<SendRow>('SELECT * FROM orch_send_tasks WHERE id=$1 FOR UPDATE', [sendTaskId]);
      const send = found.rows[0]; if (!send) fail('NOT_FOUND');
      if (Number(send.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      if (send.status !== 'RESULT_UNKNOWN') fail('STALE_PLAN');
      await finishDispatch(tx, send.send_key, { status: input.status, platformMessageId: input.platformMessageId, evidenceRef: input.evidenceRef });
      await this.#recordSendResult(tx, send.id, input.status, input.platformMessageId ?? null);
      const version = Number(send.version) + 1;
      const correlationId = newId(this.#now());
      if (resume) {
        const row = (await tx.query<Row>('SELECT c.* FROM orch_conversations c JOIN orch_plans p ON p.conversation_id=c.conversation_id WHERE p.id=$1 FOR UPDATE OF c', [send.plan_id])).rows[0];
        if (!row) fail('NOT_FOUND');
        await this.#clearPauseReason(tx, row, 'UNKNOWN_SEND', correlationId);
      }
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)',
        [scope, input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: input.status, ...(resume ? { clearedReason: 'UNKNOWN_SEND' } : {}) };
    });
  }

  async ownerContactIds(): Promise<string[]> {
    return withTransaction(this.#pool, async tx => (await tx.query<{ contact_id: string }>('SELECT contact_id FROM orch_conversations ORDER BY contact_id')).rows.map(row => row.contact_id));
  }

  async ownerConversations(conversationId?: string, includeMessages = true) {
    const projection = await withTransaction(this.#pool, async tx => {
      const global = (await tx.query<{ paused: boolean; pause_epoch: number }>('SELECT paused,pause_epoch FROM dispatch_global_control WHERE singleton=true')).rows[0];
      const rows = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE ($1::text IS NULL OR conversation_id=$1) ORDER BY contact_id', [conversationId ?? null])).rows;
      const items = [];
      for (const row of rows) {
        await setContactScope(tx, row.contact_id);
        const contact = (await tx.query<{ display_name: string }>('SELECT display_name FROM data_contacts WHERE id=$1', [row.contact_id])).rows[0];
        const messages = includeMessages ? await tx.query<{ id: string; actor: string; type: string; content_ref: string | null; sent_at: Date | string; media_id: string | null }>(
          `SELECT id,actor,type,content_ref,sent_at,media_id FROM data_messages
           WHERE contact_id=$1 AND deletion_status='active' ORDER BY sent_at DESC,id DESC LIMIT 20`, [row.contact_id]) : { rows: [] };
        const sends = await tx.query<SendRow & { created_at: Date | string }>(`SELECT s.*,CASE WHEN a.plan_id IS NULL THEN 'owner_confirmation' ELSE 'mock_auto' END AS approval_source FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id LEFT JOIN orch_mock_auto_approvals a ON a.plan_id=p.id WHERE p.conversation_id=$1 ORDER BY (s.status='RESULT_UNKNOWN') DESC,s.updated_at DESC LIMIT 100`, [row.conversation_id]);
        const paused = Boolean(global?.paused) || row.pause_reasons.length > 0;
        items.push({
          id: row.conversation_id, version: Number(row.version), status: row.state,
          allowedActions: [...(paused ? ['resumeContact','resumeRoutine'] : ['pauseContact']), ...(Number(row.paused_inbound_unreviewed_count) ? ['acknowledgePausedInbound'] : []), ...(await this.#canRequestPausedReply(tx, row) ? ['requestPausedReply'] : [])],
          contactId: row.contact_id, contactName: contact?.display_name ?? '未命名联系人',
          revision: Number(row.revision), generation: Number(row.generation),
          pauseReasons: row.pause_reasons, globalPaused: Boolean(global?.paused), globalVersion: Number(global?.pause_epoch), unreviewedPausedInboundCount: Number(row.paused_inbound_unreviewed_count),
          messages: messages.rows.reverse().map(m => ({ id: m.id, actor: m.actor, type: m.type, text: m.content_ref ?? undefined, mediaId: m.media_id ?? undefined, at: m.sent_at instanceof Date ? m.sent_at.toISOString() : String(m.sent_at) })),
          sends: sends.rows.map(s => ({ sendTaskId: s.id, version: Number(s.version), sequence: s.sequence, status: s.status, content: s.content, at: new Date(s.created_at).toISOString(), approvalSource: s.approval_source, receiptLevel: s.status === 'DELIVERED' ? 'delivered' : s.status === 'SUBMITTED' ? 'accepted' : s.status === 'RESULT_UNKNOWN' ? 'unknown' : undefined, platformMessageId: s.receipt?.platformMessageId ?? undefined, correlationId: s.correlation_id })),
        });
      }
      return { items, connectionQueryStatus: 'unavailable' as const, faultQueryStatus: 'unavailable' as const };
    });
    if (!includeMessages) return projection;
    const origins = await new PgOwnerDataPort(this.#pool).listUnknownOrigins({ contactIds: projection.items.map(item => item.contactId) });
    const byMessage = new Map(origins.items.map(item => [`${item.contactId}:${item.messageId}`, item]));
    return { ...projection, items: projection.items.map(item => ({ ...item, messages: item.messages.map(message => {
      if (message.actor !== 'unknown') return message;
      const origin = byMessage.get(`${item.contactId}:${message.id}`);
      return { ...message, originStatus: 'unknown' as const, originEvidenceRefs: origin?.originEvidenceRefs ?? [] };
    }) })) };
  }

  async resumeAll(input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'resumeAll', expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string; result_details?: Record<string, unknown> }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', ['global', input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'ACTIVE', ...previous.result_details }; }
      const global = (await tx.query<{ pause_epoch: number | string; paused: boolean }>('SELECT pause_epoch,paused FROM dispatch_global_control WHERE singleton=true FOR UPDATE')).rows[0];
      if (!global || Number(global.pause_epoch) !== input.expectedVersion) fail('CONFLICT_VERSION');
      const version = await changeGlobalPause(tx, false);
      const conversations = (await tx.query<Row>('SELECT * FROM orch_conversations ORDER BY conversation_id FOR UPDATE')).rows;
      const restored: string[] = [], skipped: { contactId: string; reasons: string[] }[] = [];
      const correlationId = newId(this.#now());
      for (const row of conversations) {
        const result = await this.#restoreRoutine(tx, row, correlationId);
        if (result.reasons.length) skipped.push({ contactId: row.contact_id, reasons: result.reasons });
        else restored.push(row.contact_id);
      }
      const details = { restored, skipped, status: skipped.length ? 'PARTIAL_RESUME' : 'ACTIVE' };
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id,result_details) VALUES($1,$2,$3,$4,$5,$6::jsonb)', ['global', input.idempotencyKey, hash, version, correlationId, JSON.stringify(details)]);
      await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'GlobalPauseChanged', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId, causationId: correlationId, aggregateId: 'global', aggregateVersion: version, payload: { paused: false, resumeAll: true } });
      return { resultVersion: version, correlationId, ...details };
    });
  }

  /** Persist an explicit request as a normal collection batch; the worker generates the draft.
   * A request never confirms a plan, and only unplanned paused text in confirm mode is eligible. */
  async requestPausedReply(contactId: string, input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'requestPausedReply', contactId, expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [contactId, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'GENERATION_REQUESTED' }; }
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      await setContactScope(tx, contactId);
      if (!await this.#canRequestPausedReply(tx, row)) fail('POLICY_BLOCKED');
      const at = new Date(this.#now()).toISOString();
      const changed = await tx.query<{ version: number | string }>(`UPDATE orch_conversations SET state='COLLECTING',
        generation=(SELECT generation FROM dispatch_control WHERE conversation_id=$1),
        collection_started_at=$2::timestamptz,collection_due_at=$2::timestamptz,collection_message_ids=ARRAY[last_inbound_message_id],
        version=version+1,updated_at=now() WHERE conversation_id=$1 RETURNING version`, [row.conversation_id, at]);
      const version = Number(changed.rows[0]!.version);
      const correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [contactId, input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: 'GENERATION_REQUESTED' };
    });
  }

  async #canRequestPausedReply(tx: PgClient, row: Row): Promise<boolean> {
    if (row.state !== 'READY_CONFIRM' || row.pause_reasons.length || row.policy.agentEnabled !== true
      || row.policy.sendMode !== 'confirm' || !Number(row.paused_inbound_unreviewed_count) || !row.last_inbound_message_id) return false;
    const eligible = await tx.query(`SELECT m.id FROM data_messages m
      JOIN dispatch_control dc ON dc.conversation_id=$3
      JOIN dispatch_global_control gc ON gc.singleton=true
      WHERE m.id=$1 AND m.contact_id=$2 AND m.conversation_id=$3::uuid
        AND m.actor='contact' AND m.mode='live' AND m.type='text' AND m.deletion_status='active'
        AND dc.paused=false AND dc.unresolved_send_key IS NULL AND gc.paused=false
        AND NOT EXISTS (SELECT 1 FROM orch_plans p WHERE p.conversation_id=$3 AND m.id=ANY(p.trigger_message_ids))`,
      [row.last_inbound_message_id, row.contact_id, row.conversation_id]);
    return eligible.rows.length === 1;
  }

  /** Clears only the reminder; it never creates a plan or touches the pause state. */
  async acknowledgePausedInbound(contactId: string, input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'acknowledgePausedInbound', contactId, expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [contactId, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'REVIEWED' }; }
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      if (!Number(row.paused_inbound_unreviewed_count)) fail('VALIDATION_FAILED');
      const changed = await tx.query<{ version: number | string }>(`UPDATE orch_conversations SET paused_inbound_unreviewed_count=0,version=version+1,updated_at=now() WHERE conversation_id=$1 RETURNING version`, [row.conversation_id]);
      const version = Number(changed.rows[0]!.version);
      const correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [contactId, input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: 'REVIEWED' };
    });
  }

  /** Routine recovery preserves unresolved sends, special blocks and disabled agents. */
  async resumeRoutine(contactId: string, input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'resumeRoutine', contactId, expectedVersion: input.expectedVersion }));
      const prior = (await tx.query<{ command_hash: string; result_version: number; correlation_id: string; result_details: Record<string, unknown> }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [contactId,input.idempotencyKey])).rows[0];
      if (prior) { if (prior.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(prior.result_version), correlationId: prior.correlation_id, ...prior.result_details }; }
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      const correlationId = newId(this.#now());
      const result = await this.#restoreRoutine(tx,row,correlationId);
      const details = { status: result.reasons.length ? 'PARTIAL_RESUME' : 'RESUMED', remainingReasons: result.reasons };
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id,result_details) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [contactId,input.idempotencyKey,hash,result.version,correlationId,JSON.stringify(details)]);
      return { resultVersion: result.version, correlationId, ...details };
    });
  }

  async #restoreRoutine(tx: PgClient, row: Row, correlationId: string) {
    const control = (await tx.query<{ unresolved_send_key: string | null }>('SELECT unresolved_send_key FROM dispatch_control WHERE conversation_id=$1 FOR UPDATE', [row.conversation_id])).rows[0];
    if (control?.unresolved_send_key || row.pause_reasons.includes('UNKNOWN_SEND')) return { version: Number(row.version), reasons: [...new Set(['UNKNOWN_SEND',...row.pause_reasons,...(!row.policy.agentEnabled ? ['AGENT_DISABLED'] : [])])] };
    const clear = ['OWNER_PAUSE','OWNER_ORIGIN','OWNER_ORIGIN_UNMAPPED','AWAITING_MANUAL_RESUME','GLOBAL_PAUSE'];
    if ((await tx.query(`SELECT account_id FROM orch_account_health WHERE account_id=$1 AND healthy=true AND observed_at>=now()-interval '30 seconds'`, [row.account_id])).rows.length) clear.push('ACCOUNT_FAULT');
    const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
    const remaining = row.pause_reasons.filter(reason => !clear.includes(reason) || reason === 'GLOBAL_PAUSE' && global?.paused);
    const reasons = [...remaining, ...(!row.policy.agentEnabled ? ['AGENT_DISABLED'] : []), ...(global?.paused && !remaining.includes('GLOBAL_PAUSE') ? ['GLOBAL_PAUSE'] : [])];
    const state = deriveState(global?.paused ? [...remaining,'GLOBAL_PAUSE'] : remaining, row.policy.sendMode,row.policy.agentEnabled);
    if (remaining.join() === row.pause_reasons.join() && state === row.state) return { version: Number(row.version), reasons };
    await this.#invalidate(tx,row.conversation_id,'RESUME_REBASE');
    await changeContactPause(tx,row.conversation_id,state.startsWith('PAUSED_'));
    const updated = await tx.query<{ version: number }>(`UPDATE orch_conversations SET state=$2,pause_reasons=$3::text[],generation=(SELECT generation FROM dispatch_control WHERE conversation_id=$1),version=version+1,updated_at=now() WHERE conversation_id=$1 RETURNING version`, [row.conversation_id,state,remaining]);
    const version = Number(updated.rows[0]!.version);
    await appendOutbox(tx,{ eventId:newId(this.#now()),eventType:'ContactControlChanged',eventVersion:1,occurredAt:new Date(this.#now()).toISOString(),correlationId,causationId:correlationId,aggregateId:row.conversation_id,aggregateVersion:version,payload:{ paused:state.startsWith('PAUSED_'),state,clearedReason:'ROUTINE_RESUME' } });
    return { version,reasons };
  }

  async resumeContact(contactId: string, input: { expectedVersion: number; idempotencyKey: string; reason?: string }) {
    requireText(input.idempotencyKey);
    const reason = input.reason?.trim() || 'OWNER_PAUSE';
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'resumeContact', contactId, expectedVersion: input.expectedVersion, reason }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [contactId, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'RESUMED' }; }
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      const correlationId = newId(this.#now());
      const version = await this.#clearPauseReason(tx, row, reason, correlationId);
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [contactId, input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: 'RESUMED' };
    });
  }

  /** Clears one pause reason; the others keep the contact paused. Refuses while a send is unresolved. */
  async #clearPauseReason(tx: PgClient, row: Row, reason: string, correlationId: string): Promise<number> {
    if (reason === 'ACCOUNT_FAULT' && !(await tx.query('SELECT account_id FROM orch_account_health WHERE account_id=$1 AND healthy=true', [row.account_id])).rows.length) fail('POLICY_BLOCKED');
    const control = (await tx.query<{ unresolved_send_key: string | null }>('SELECT unresolved_send_key FROM dispatch_control WHERE conversation_id=$1 FOR UPDATE', [row.conversation_id])).rows[0];
    if (control?.unresolved_send_key) fail('SEND_RESULT_UNKNOWN');
    const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
    const remaining = row.pause_reasons.filter(value => value !== reason);
    const state = deriveState(global?.paused ? [...remaining, 'GLOBAL_PAUSE'] : remaining, row.policy.sendMode, row.policy.agentEnabled);
    await this.#invalidate(tx, row.conversation_id, 'RESUME_REBASE');
    await changeContactPause(tx, row.conversation_id, state.startsWith('PAUSED_'));
    const control2 = (await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id])).rows[0];
    const changed = await tx.query<{ version: number | string }>(
      `UPDATE orch_conversations SET state=$3,pause_reasons=$2::text[],generation=$4,version=version+1,updated_at=now() WHERE conversation_id=$1 RETURNING version`,
      [row.conversation_id, remaining, state, Number(control2?.generation)]);
    const version = Number(changed.rows[0]!.version);
    await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'ContactControlChanged', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId, causationId: correlationId, aggregateId: row.conversation_id, aggregateVersion: version, payload: { paused: state.startsWith('PAUSED_'), state, clearedReason: reason } });
    return version;
  }

  /** Owner policy edit. Any change invalidates pending plans and raises policy_version + generation. */
  async updatePolicy(contactId: string, input: { expectedVersion: number; idempotencyKey: string; policy: Partial<Omit<Policy, 'contactId' | 'version'>> }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      const next = { ...row.policy, ...input.policy, contactId: row.contact_id, version: Number(row.policy_version) + 1 } as Policy;
      if (!['confirm', 'auto'].includes(next.sendMode) || !next.timezone?.trim() || !next.goal?.trim() ||
        !Array.isArray(next.factScopes) || !Array.isArray(next.restrictions) || !Array.isArray(next.stylePreferences ?? [])) fail('VALIDATION_FAILED');
      await this.#invalidate(tx, row.conversation_id, 'POLICY_CHANGED');
      const control = (await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1 FOR UPDATE', [row.conversation_id])).rows[0];
      const generation = Number(control?.generation);
      const nextState = deriveState(row.pause_reasons, next.sendMode, next.agentEnabled);
      const changed = await tx.query<{ version: number | string }>(
        `UPDATE orch_conversations SET policy=$3::jsonb,policy_version=$2,generation=$4,state=$5,
         collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],version=version+1,updated_at=now()
         WHERE contact_id=$1 RETURNING version`, [contactId, next.version, JSON.stringify(next), generation, nextState]);
      await tx.query('UPDATE dispatch_control SET policy_version=$2,generation=$3,updated_at=now() WHERE conversation_id=$1', [row.conversation_id, next.version, generation]);
      const correlationId = newId(this.#now());
      await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'ContactPolicyChanged', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId, causationId: correlationId, aggregateId: row.conversation_id, aggregateVersion: Number(changed.rows[0]!.version), payload: { policyVersion: next.version, sendMode: next.sendMode, agentEnabled: next.agentEnabled } });
      return { resultVersion: Number(changed.rows[0]!.version), correlationId, status: 'UPDATED' };
    });
  }

  async getConversation(conversationId: string) {
    return withTransaction(this.#pool, async tx => {
      const row = await this.#conversation(tx, conversationId); if (!row) fail('NOT_FOUND');
      const plans = await tx.query<PlanRow>('SELECT * FROM orch_plans WHERE conversation_id=$1 ORDER BY created_at,id', [conversationId]);
      const tasks = await tx.query<TaskRow>('SELECT t.* FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id WHERE p.conversation_id=$1', [conversationId]);
      const sends = await tx.query<SendRow>('SELECT s.* FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id WHERE p.conversation_id=$1 ORDER BY s.sequence', [conversationId]);
      const auto = await tx.query<{ plan_id: string }>('SELECT a.plan_id FROM orch_mock_auto_approvals a JOIN orch_plans p ON p.id=a.plan_id WHERE p.conversation_id=$1', [conversationId]);
      return { contactId: row.contact_id, conversationId, policy: row.policy, control: { state: row.state, pauseReasons: row.pause_reasons, generation: Number(row.generation), revision: Number(row.revision) },
        plans: plans.rows.map(p => ({ id: p.id, version: Number(p.version), status: p.status, approvalSource: auto.rows.some(a => a.plan_id === p.id) ? 'mock_auto' : 'owner_confirmation', alternatives: p.alternatives, invalidationReasons: p.invalidation_reasons ?? [], task: tasks.rows.find(t => t.plan_id === p.id), sends: sends.rows.filter(s => s.plan_id === p.id) })) };
    });
  }

  async #recordSendResult(tx: PgClient, sendId: string, status: string, platformMessageId: string | null): Promise<void> {
    const found = await tx.query<{ plan_id: string; sequence: number; status: string; version: string | number; correlation_id: string }>('SELECT plan_id,sequence,status,version,correlation_id FROM orch_send_tasks WHERE id=$1 FOR UPDATE', [sendId]);
    const send = found.rows[0]; if (!send) return;
    if (send.status === 'DELIVERED' && status === 'SUBMITTED') return;
    if (send.status === status) return;
    await tx.query(`UPDATE orch_send_tasks SET status=$2,receipt=$3::jsonb,version=version+1,updated_at=now() WHERE id=$1`, [sendId, status, JSON.stringify({ status, platformMessageId })]);
    if(status==='DELIVERED'){
      const scope=(await tx.query<{contact_id:string}>('SELECT contact_id FROM orch_plans WHERE id=$1',[send.plan_id])).rows[0];
      if(scope)await this.#feedback.recordDelivered(tx,{contactId:scope.contact_id,planId:send.plan_id,at:new Date(this.#now()).toISOString()});
    }
    const job = (await tx.query<{ id: string }>('SELECT id FROM orch_reply_jobs WHERE plan_id=$1', [send.plan_id])).rows[0];
    if (job) {
      const parts = (await tx.query<{ status: string }>('SELECT status FROM orch_send_tasks WHERE plan_id=$1 ORDER BY sequence', [send.plan_id])).rows;
      const outcome: ReplyJobState = parts.some(p => p.status === 'RESULT_UNKNOWN') ? 'UNCERTAIN'
        : parts.some(p => ['FAILED_DEFINITE','CANCELLED_PRE_SUBMIT'].includes(p.status)) ? 'FAILED'
        : parts.every(p => p.status === 'DELIVERED') ? 'SENT'
        : parts.every(p => ['SUBMITTED','DELIVERED'].includes(p.status)) ? 'SUBMITTED' : 'SEND_QUEUED';
      await transitionReplyJob(tx,job.id,outcome,status === 'RESULT_UNKNOWN' ? 'SEND_RESULT_UNKNOWN' : undefined);
    }
    await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'SendTaskStateChanged', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId: send.correlation_id, causationId: sendId, aggregateId: sendId, aggregateVersion: Number(send.version) + 1, payload: { sendTaskId: sendId, status, platformMessageId } });
    const active = await tx.query<{ status: string; generation: string | number; current_generation: string | number }>(`SELECT p.status,p.generation,c.generation AS current_generation FROM orch_plans p JOIN orch_conversations c ON c.conversation_id=p.conversation_id WHERE p.id=$1 FOR UPDATE OF p,c`, [send.plan_id]);
    if (!active.rows[0] || active.rows[0].status === 'INVALIDATED' || Number(active.rows[0].generation) !== Number(active.rows[0].current_generation)) return;
    if (status === 'RESULT_UNKNOWN' || status === 'FAILED_DEFINITE') {
      await tx.query(`UPDATE orch_send_tasks SET status='CANCELLED_PRE_SUBMIT',version=version+1 WHERE plan_id=$1 AND sequence>$2 AND status='CREATED'`, [send.plan_id, send.sequence]);
      await tx.query('UPDATE orch_plans SET status=$2,version=version+1 WHERE id=$1', [send.plan_id, status === 'RESULT_UNKNOWN' ? 'RESULT_UNKNOWN' : 'FAILED']);
      const reason = status === 'RESULT_UNKNOWN' ? 'UNKNOWN_SEND' : 'SEND_FAILURE';
      await tx.query(`UPDATE orch_conversations SET state=$2,pause_reasons=array_append(pause_reasons,$3),version=version+1 WHERE conversation_id=(SELECT conversation_id FROM orch_plans WHERE id=$1) AND NOT ($3=ANY(pause_reasons))`, [send.plan_id, status === 'RESULT_UNKNOWN' ? 'PAUSED_UNKNOWN_SEND' : 'PAUSED_FAILURE', reason]);
      return;
    }
    if (['SUBMITTED','DELIVERED'].includes(status)) {
      const remaining = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM orch_send_tasks WHERE plan_id=$1 AND status NOT IN ('SUBMITTED','DELIVERED')`, [send.plan_id]);
      const complete = Number(remaining.rows[0]?.n) === 0;
      await tx.query('UPDATE orch_plans SET status=$2,version=version+1 WHERE id=$1', [send.plan_id, complete ? 'SENT' : 'PARTIALLY_SENT']);
      if (complete) await tx.query(`UPDATE orch_conversations SET state=CASE WHEN policy->>'sendMode'='auto' THEN 'READY_AUTO' ELSE 'READY_CONFIRM' END,version=version+1 WHERE conversation_id=(SELECT conversation_id FROM orch_plans WHERE id=$1) AND state IN ('SCHEDULED','PARTIALLY_SENT') AND cardinality(pause_reasons)=0`, [send.plan_id]);
    }
  }

  async #invalidate(tx: PgClient, conversationId: string, reason: string, staleSkillEpoch?: number): Promise<void> {
    await invalidateReplyJobs(tx,conversationId,reason,staleSkillEpoch);
    const unconfirmed = (await tx.query<{ id: string; contact_id: string }>(`SELECT id,contact_id FROM orch_plans
      WHERE conversation_id=$1 AND status='AWAITING_CONFIRMATION' AND ($2::bigint IS NULL OR skill_epoch<$2::bigint)`, [conversationId, staleSkillEpoch ?? null])).rows;
    const plans = await tx.query<{ id: string; version: string | number }>(`UPDATE orch_plans SET status='INVALIDATED',invalidation_reasons=array_append(invalidation_reasons,$2),version=version+1,updated_at=now() WHERE conversation_id=$1 AND status IN ('AWAITING_CONFIRMATION','APPROVED','PARTIALLY_SENT') AND ($3::bigint IS NULL OR skill_epoch<$3::bigint) RETURNING id,version`, [conversationId, reason, staleSkillEpoch ?? null]);
    for (const p of plans.rows) {
      const previous = unconfirmed.find(row => row.id === p.id);
      if (previous) await this.#feedback.recordOutcome(tx, { callerContactId: previous.contact_id, contactId: previous.contact_id,
        planId: p.id, action: reason === 'OWNER_REGENERATE' ? 'regenerated' : 'expired', invalidationReason: reason, at: new Date(this.#now()).toISOString() });
      await tx.query(`UPDATE orch_confirmation_tasks SET status='INVALIDATED',version=version+1 WHERE plan_id=$1 AND status='PENDING'`, [p.id]);
      await tx.query(`UPDATE orch_send_tasks SET status='CANCELLED_PRE_SUBMIT',version=version+1 WHERE plan_id=$1 AND status='CREATED'`, [p.id]);
      await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'ReplyPlanInvalidated', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId: newId(this.#now()), causationId: p.id, aggregateId: p.id, aggregateVersion: Number(p.version), payload: { planId: p.id, reason } });
    }
  }
  async #readProjection(tx: PgClient, row: Row, plan: PlanRow) {
    try {
      return await this.#data.readContextProjection(tx, { callerContactId: row.contact_id, contactId: row.contact_id, snapshotId: plan.context_snapshot_id, allowedScopes: row.policy.factScopes, expectedDependencyEpoch: Number(plan.dependency_epoch) });
    } catch (error) {
      if (error instanceof Error && error.message === 'STALE_CONTEXT') fail('STALE_PLAN');
      throw error;
    }
  }
  async #conversation(tx: PgClient, id: string, lock = false): Promise<Row | undefined> { return (await tx.query<Row>(`SELECT * FROM orch_conversations WHERE conversation_id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]; }
  async #plan(tx: PgClient, id: string, lock = false): Promise<PlanRow | undefined> { return (await tx.query<PlanRow>(`SELECT * FROM orch_plans WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]; }
  async #task(tx: PgClient, planId: string, lock = false): Promise<TaskRow | undefined> { return (await tx.query<TaskRow>(`SELECT * FROM orch_confirmation_tasks WHERE plan_id=$1${lock ? ' FOR UPDATE' : ''}`, [planId])).rows[0]; }
}
