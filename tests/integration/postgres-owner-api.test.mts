/** Real PostgreSQL only: the owner management surface (reject/resume/policy/facts/media/analysis)
 * against the same migrations and RLS roles used by the rest of the gate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause, getDependencyEpoch } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgOwnerDataPort } from '../../packages/data/postgres/owner-data-port.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('real PostgreSQL: owner API covers reject, resume, policy, facts, media and analysis corrections', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_owner_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });

    const at = '2026-09-23T10:00:00.000Z';
    const clock = () => Date.parse(at);
    const authority = {};
    const accountId = newId(clock());
    const contactId = newId(clock()), conversationId = newId(clock());
    const otherContactId = newId(clock()), otherConversationId = newId(clock());
    const data = new PgDataProvider();

    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await data.createContact(tx, { id: contactId, conversationId, platformAccountId: accountId, externalContactRef: 'external', displayName: '合成联系人', enrollmentStatus: 'enrolled' });
      await setContactScope(tx, otherContactId);
      await data.createContact(tx, { id: otherContactId, conversationId: otherConversationId, platformAccountId: accountId, externalContactRef: 'other', displayName: '另一位联系人', enrollmentStatus: 'enrolled' });
      await changeGlobalPause(tx, false);
    });

    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority, clock });
    platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const intelligence = {
      async propose() { return { shouldReply: true, risks: ['ordinary' as const], timing: 'now' as const, generatorVersion: 'fake', alternatives: [{ key: 'a', strategySummary: '普通回应', parts: [{ key: 'p1', sequence: 1, type: 'text' as const, content: '第一条' }] }] }; },
      async checkEdited() { return { allowed: true, reasons: [] }; },
    };
    const service = new PgConfirmedService({ pool, data, intelligence, platform, authority, now: clock });
    await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: 'external', timezone: 'Asia/Shanghai', goal: '了解对方' });
    await service.enrollContact({ contactId: otherContactId, conversationId: otherConversationId, accountId, externalContactRef: 'other', timezone: 'Asia/Shanghai', goal: '保持联系' });

    const owner = new PgOwnerDataPort(pool);
    const scope = async () => ({ contactIds: await service.ownerContactIds() });
    const inbound = (id: string, text: string, conversation = conversationId, external = 'external') => platform.observe({
      platformEventId: id, platformMessageId: id, conversationRef: { accountId, conversationId: conversation, externalContactRef: external },
      sentAt: at, type: 'text', contentRef: text, direction: 'incoming', rawEventRef: `synthetic-${id}`, mode: 'live',
    })!;

    // Contact list, conversation projection and the confirmation task.
    assert.deepEqual(await service.ownerContactIds(), [contactId, otherContactId].sort());
    await service.ingestPlatformEvent(inbound('message-1', '你好'));
    const conversations = await service.ownerConversations();
    const first = conversations.items.find(item => item.contactId === contactId)!;
    assert.equal(first.contactName, '合成联系人');
    assert.deepEqual(first.messages.map(m => m.text), ['你好']);
    assert.deepEqual(first.pauseReasons, []);
    assert.deepEqual(first.allowedActions, ['pauseContact']);

    // reject is idempotent per key and does not touch the other contact.
    const pendingTask = (await service.ownerTasks()).items.find(item => item.contactId === contactId)!;
    const rejected = await service.rejectTask(pendingTask.taskId, { expectedVersion: pendingTask.taskVersion, idempotencyKey: 'reject-1' });
    assert.equal(rejected.status, 'REJECTED');
    const replay = await service.rejectTask(pendingTask.taskId, { expectedVersion: pendingTask.taskVersion, idempotencyKey: 'reject-1' });
    assert.equal(replay.status, rejected.status);
    assert.equal(replay.resultVersion, rejected.resultVersion, 'a replayed command must not apply twice');
    await assert.rejects(service.rejectTask(pendingTask.taskId, { expectedVersion: pendingTask.taskVersion + 1, idempotencyKey: 'reject-2' }), { message: 'STALE_PLAN' });
    assert.equal((await service.getConversation(conversationId)).plans[0]?.status, 'REJECTED');
    assert.deepEqual((await service.ownerConversations()).items.find(item => item.contactId === otherContactId)!.pauseReasons, []);

    // A policy edit invalidates pending plans, bumps the version and is idempotent per key.
    await service.ingestPlatformEvent(inbound('message-2', '再问一句'));
    const contactVersion = (await service.ownerContacts()).items.find(item => item.id === contactId)!.version;
    const policyEdit = await service.updatePolicy(contactId, { expectedVersion: contactVersion, idempotencyKey: 'policy-1', policy: { goal: '推进见面', restrictions: ['不提钱'], stylePreferences: ['简短', '口语化'] } });
    assert.equal(policyEdit.status, 'UPDATED');
    const plansAfterPolicy = (await service.getConversation(conversationId)).plans;
    assert.equal(plansAfterPolicy.at(-1)?.status, 'INVALIDATED');
    assert.deepEqual(plansAfterPolicy.at(-1)?.invalidationReasons, ['POLICY_CHANGED']);
    const updatedContact = (await service.ownerContacts()).items.find(item => item.id === contactId)!;
    assert.equal(updatedContact.goal, '推进见面');
    assert.equal(updatedContact.policyVersion, 2, 'the policy object carries its own monotonic version');
    assert.equal(policyEdit.resultVersion, contactVersion + 1, 'commands return the resource version they bumped');
    assert.deepEqual(updatedContact.restrictions, ['不提钱']);
    assert.deepEqual(updatedContact.stylePreferences, ['简短', '口语化']);
    await assert.rejects(service.updatePolicy(contactId, { expectedVersion: contactVersion, idempotencyKey: 'policy-2', policy: { goal: '再来' } }), { message: 'CONFLICT_VERSION' });

    // Pause then resume: only the named reason is cleared and the contact returns to confirm mode.
    const currentVersion = (await service.ownerContacts()).items.find(item => item.id === contactId)!.version;
    await service.pauseContact(contactId, { expectedVersion: currentVersion, idempotencyKey: 'pause-contact-2' });
    const pausedRow = (await service.ownerConversations()).items.find(item => item.contactId === contactId)!;
    assert.deepEqual(pausedRow.pauseReasons, ['OWNER_PAUSE']);
    assert.deepEqual(pausedRow.allowedActions, ['resumeContact']);
    const plansBeforePausedInbound = (await service.getConversation(conversationId)).plans.length;
    const pausedInbound = inbound('paused-message-1', '暂停期间的来信');
    assert.equal(await service.ingestPlatformEvent(pausedInbound), undefined);
    assert.equal(await service.ingestPlatformEvent(pausedInbound), undefined, 'duplicate delivery stays idempotent');
    assert.equal(await service.ingestPlatformEvent(inbound('paused-message-2', '另一条来信')), undefined);
    const pausedWithMessages = (await service.ownerConversations()).items.find(item => item.contactId === contactId)!;
    assert.equal(pausedWithMessages.unreviewedPausedInboundCount, 2);
    assert.deepEqual(pausedWithMessages.allowedActions, ['resumeContact', 'acknowledgePausedInbound']);
    await assert.rejects(service.requestPausedReply(contactId, { expectedVersion: pausedWithMessages.version, idempotencyKey: 'draft-while-paused' }), { message: 'POLICY_BLOCKED' });
    assert.equal((await service.getConversation(conversationId)).plans.length, plansBeforePausedInbound, 'paused inbound creates no plan');
    const resumed = await service.resumeContact(contactId, { expectedVersion: pausedWithMessages.version, idempotencyKey: 'resume-contact-1' });
    assert.equal(resumed.status, 'RESUMED');
    const resumedRow = (await service.ownerConversations()).items.find(item => item.contactId === contactId)!;
    assert.deepEqual(resumedRow.pauseReasons, []);
    assert.equal(resumedRow.status, 'READY_CONFIRM');
    assert.equal(resumedRow.unreviewedPausedInboundCount, 2, 'resume preserves the review reminder');
    assert.equal((await service.getConversation(conversationId)).plans.length, plansBeforePausedInbound, 'resume does not generate a reply');
    assert.equal((await service.ownerContacts()).items.find(item => item.id === otherContactId)?.unreviewedPausedInboundCount, 0);
    await assert.rejects(service.acknowledgePausedInbound(contactId, { expectedVersion: pausedWithMessages.version, idempotencyKey: 'review-stale' }), { message: 'CONFLICT_VERSION' });
    assert.ok(resumedRow.allowedActions.includes('requestPausedReply'));
    await assert.rejects(service.requestPausedReply(contactId, { expectedVersion: pausedWithMessages.version, idempotencyKey: 'draft-stale' }), { message: 'CONFLICT_VERSION' });
    const request = { expectedVersion: resumedRow.version, idempotencyKey: 'paused-draft-1' };
    const queued = await service.requestPausedReply(contactId, request);
    assert.equal(queued.status, 'GENERATION_REQUESTED');
    assert.deepEqual(await service.requestPausedReply(contactId, request), queued);
    await assert.rejects(service.requestPausedReply(contactId, { ...request, idempotencyKey: 'paused-draft-2' }), { message: 'CONFLICT_VERSION' });
    assert.equal((await service.ownerConversations()).items.find(item => item.contactId === contactId)?.status, 'COLLECTING');
    // A new service instance can finish the persisted request, with no send created.
    const restarted = new PgConfirmedService({ pool, data, intelligence, platform, authority, now: clock });
    await restarted.recover();
    const afterDraft = await restarted.getConversation(conversationId);
    assert.equal(afterDraft.plans.length, plansBeforePausedInbound + 1);
    assert.equal(afterDraft.plans.at(-1)?.status, 'AWAITING_CONFIRMATION');
    assert.equal(afterDraft.plans.at(-1)?.sends.length, 0);
    assert.equal(platform.submissionCount, 0);
    const draftTask = (await service.ownerTasks()).items.find(item => item.contactId === contactId && item.allowedActions.includes('confirmPlan'))!;
    assert.deepEqual(draftTask.triggerMessages.map(message => message.text), ['另一条来信']);
    await service.rejectTask(draftTask.taskId, { expectedVersion: draftTask.taskVersion, idempotencyKey: 'reject-paused-draft' });
    const afterRejection = (await service.ownerConversations()).items.find(item => item.contactId === contactId)!;
    assert.equal(afterRejection.allowedActions.includes('requestPausedReply'), false, 'a previously planned message cannot be requested again');
    await assert.rejects(service.requestPausedReply(contactId, { expectedVersion: afterRejection.version, idempotencyKey: 'draft-after-reject' }), { message: 'POLICY_BLOCKED' });
    const reviewed = await service.acknowledgePausedInbound(contactId, { expectedVersion: afterRejection.version, idempotencyKey: 'review-1' });
    assert.equal(reviewed.status, 'REVIEWED');
    assert.equal((await service.acknowledgePausedInbound(contactId, { expectedVersion: afterRejection.version, idempotencyKey: 'review-1' })).resultVersion, reviewed.resultVersion);
    assert.equal((await service.ownerContacts()).items.find(item => item.id === contactId)?.unreviewedPausedInboundCount, 0);
    assert.equal((await service.ownerConversations()).items.find(item => item.contactId === contactId)?.messages.filter(message => message.text?.includes('来信')).length, 2, 'clearing the reminder keeps messages');

    // Global pause then resume covers every conversation.
    const globalVersion = (await service.ownerOverview()).version;
    await service.pauseAll({ expectedVersion: globalVersion, idempotencyKey: 'pause-all-2' });
    assert.equal((await service.ownerOverview()).globalPaused, true);
    assert.equal(await service.ingestPlatformEvent(inbound('global-paused-message', '全局暂停时的来信', otherConversationId, 'other')), undefined);
    assert.equal((await service.ownerContacts()).items.find(item => item.id === otherContactId)?.unreviewedPausedInboundCount, 1);
    const globallyPaused = (await service.ownerConversations()).items.find(item => item.contactId === otherContactId)!;
    assert.equal(globallyPaused.allowedActions.includes('requestPausedReply'), false);
    await assert.rejects(service.requestPausedReply(otherContactId, { expectedVersion: globallyPaused.version, idempotencyKey: 'draft-global-paused' }), { message: 'POLICY_BLOCKED' });
    const resumedAll = await service.resumeAll({ expectedVersion: globalVersion + 1, idempotencyKey: 'resume-all-1' });
    assert.equal(resumedAll.status, 'ACTIVE');
    assert.equal((await service.ownerOverview()).globalPaused, false);
    assert.deepEqual((await service.ownerConversations()).items.map(item => item.status), ['READY_CONFIRM', 'READY_CONFIRM']);
    assert.equal((await service.ownerContacts()).items.find(item => item.id === otherContactId)?.unreviewedPausedInboundCount, 1, 'global resume preserves the reminder');

    // Facts: confirmed owner fact, a model inference candidate, correction, deletion and isolation.
    const epochBefore = await withTransaction(pool, tx => getDependencyEpoch(tx, conversationId));
    const confirmedFact = await withTransaction(pool, async tx => data.createFact(tx, contactId, {
      subject: 'current_personal_status_or_schedule', scope: contactId, content: '今晚加班到 21 点', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: at,
    }, newId(clock())));
    const candidateFact = await withTransaction(pool, async tx => data.createFact(tx, contactId, {
      subject: '对方偏好', scope: contactId, content: '可能喜欢安静场合', sourceCategory: 'model-inference', evidenceRefs: [], validFrom: at,
    }, newId(clock())));
    await withTransaction(pool, async tx => {
      await setContactScope(tx, otherContactId);
      await data.createFact(tx, otherContactId, { subject: 'other', scope: otherContactId, content: '其他联系人的私密资料', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: at }, newId(clock()));
    });
    const facts = (await owner.listFacts(await scope())).items as { id: string; content: string; confirmed: boolean; allowedActions: string[]; scope: string }[];
    assert.equal(facts.some(f => f.content === '其他联系人的私密资料'), true);
    const scopedFacts = (await owner.listFacts({ contactIds: [contactId] })).items as { id: string; allowedActions: string[]; confirmed: boolean }[];
    assert.equal(scopedFacts.length, 2, 'only this contact owns rows under a single-contact scope');
    assert.deepEqual(scopedFacts.find(f => f.id === confirmedFact.id)!.allowedActions, ['correctFact', 'deleteFact']);
    assert.deepEqual(scopedFacts.find(f => f.id === candidateFact.id)!.allowedActions, ['correctFact', 'deleteFact'], 'a model inference can never be confirmed by the owner UI');
    await assert.rejects(owner.changeFact(await scope(), { factId: candidateFact.id, expectedVersion: 1, action: 'confirm' }), { message: 'VALIDATION_FAILED' });
    const corrected = await owner.changeFact(await scope(), { factId: candidateFact.id, expectedVersion: 1, action: 'correct', content: '对方明确说过喜欢安静场合' });
    assert.equal(corrected.status, 'CORRECTED');
    assert.equal(corrected.resultVersion, 2);
    await assert.rejects(owner.changeFact(await scope(), { factId: candidateFact.id, expectedVersion: 1, action: 'correct', content: '过期版本' }), { message: 'CONFLICT_VERSION' });
    const deleted = await owner.changeFact(await scope(), { factId: confirmedFact.id, expectedVersion: 1, action: 'delete' });
    assert.equal(deleted.status, 'DELETED');
    assert.equal((await owner.listFacts({ contactIds: [contactId] })).items.length, 1, 'deleted facts leave the management list');
    const epochAfter = await withTransaction(pool, tx => getDependencyEpoch(tx, conversationId));
    assert.ok(epochAfter > epochBefore, 'fact changes raise the dependency epoch');

    // Media: only stickers can be approved, and approval is versioned per platform list.
    const stickerId = newId(clock()), imageId = newId(clock());
    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      for (const [id, type] of [[stickerId, 'sticker_static'], [imageId, 'image']] as const) {
        await tx.query(`INSERT INTO data_media_assets(id,contact_id,media_type,storage_ref,sha256,fetch_status,completeness,interpretation_status,platform_metadata,approval_status,approval_version,allowed_platforms,version,created_at,updated_at)
          VALUES($1,$2,$3,'synthetic-ref',$4,'stored','complete','complete','{}'::jsonb,'unapproved',1,'{}'::text[],1,$5::timestamptz,$5::timestamptz)`,
          [id, contactId, type, 'a'.repeat(64), at]);
      }
    });
    const media = (await owner.listMedia(await scope())).items as { id: string; status: string; allowedActions: string[] }[];
    assert.equal(media.length, 2);
    assert.equal(media.find(m => m.id === stickerId)!.status, 'UNAPPROVED');
    assert.deepEqual(media.find(m => m.id === stickerId)!.allowedActions, ['approveAsset', 'revokeAsset']);
    await assert.rejects(owner.setMediaApproval(await scope(), { mediaId: imageId, expectedVersion: 1, action: 'approveAsset', allowedPlatforms: ['qq'] }), { message: 'UNSUPPORTED_CAPABILITY' });
    await assert.rejects(owner.setMediaApproval(await scope(), { mediaId: stickerId, expectedVersion: 1, action: 'approveAsset', allowedPlatforms: ['telegram'] }), { message: 'VALIDATION_FAILED' });
    const approved = await owner.setMediaApproval(await scope(), { mediaId: stickerId, expectedVersion: 1, action: 'approveAsset', allowedPlatforms: ['qq'] });
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.resultVersion, 2);
    await assert.rejects(owner.setMediaApproval(await scope(), { mediaId: stickerId, expectedVersion: 1, action: 'revokeAsset' }), { message: 'CONFLICT_VERSION' });
    assert.equal((await owner.setMediaApproval(await scope(), { mediaId: stickerId, expectedVersion: 2, action: 'revokeAsset' })).status, 'REVOKED');

    // Analyses: owner correction invalidates the snapshot and raises the epoch.
    const analysisId = newId(clock());
    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await tx.query(`INSERT INTO data_analyses(id,contact_id,analysis_version,cutoff,sample_range,claims,stage_hypotheses,trend,supporting_evidence,counter_evidence,uncertainty,corrections,status,version,created_at,updated_at)
        VALUES($1,$2,'fake-analysis-1',$3::timestamptz,'{"taxonomyVersion":"draft-1"}'::jsonb,'[]'::jsonb,'[]'::jsonb,NULL,'[]'::jsonb,'[]'::jsonb,'{"note":"draft"}'::jsonb,'[]'::jsonb,'valid',1,$3::timestamptz,$3::timestamptz)`,
        [analysisId, contactId, at]);
    });
    const analyses = (await owner.listAnalyses(await scope())).items as { id: string; status: string; allowedActions: string[] }[];
    assert.equal(analyses.length, 1);
    assert.deepEqual(analyses[0]!.allowedActions, ['correctAnalysis']);
    const epochBeforeCorrection = await withTransaction(pool, tx => getDependencyEpoch(tx, conversationId));
    const correctedAnalysis = await owner.correctAnalysis(await scope(), { analysisId, expectedVersion: 1, correction: '证据不足，不应判断性格' });
    assert.equal(correctedAnalysis.status, 'INVALIDATED');
    assert.equal(correctedAnalysis.resultVersion, 2);
    assert.ok(await withTransaction(pool, tx => getDependencyEpoch(tx, conversationId)) > epochBeforeCorrection);
    assert.deepEqual((await owner.listAnalyses(await scope())).items[0]!.allowedActions, []);
    await assert.rejects(owner.correctAnalysis(await scope(), { analysisId, expectedVersion: 2, correction: '重复纠正' }), { message: 'VALIDATION_FAILED' });

    // Audit stays an honest empty projection until decision writers exist.
    assert.deepEqual(await owner.listAudit(), { items: [] });
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
