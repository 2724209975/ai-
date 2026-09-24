/** Isolated pg_dump/pg_restore plus private raw-event files. No production data or adapter. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { commitReceived } from '../../packages/infrastructure/postgres/event-store.mts';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { FileMediaStore } from '../../packages/data/media/file-store.mts';
import { recoverAmbiguous } from '../../packages/infrastructure/postgres/dispatch-journal.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const dumpBin = process.env.PG_DUMP_BIN;
const restoreBin = process.env.PG_RESTORE_BIN;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPg(bin: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync(bin, args, { input, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(bin === dumpBin ? 'PG_DUMP_FAILED' : 'PG_RESTORE_FAILED');
  return result.stdout;
}

test('real PostgreSQL: database and raw-event backup restores into a separate database with dispatch paused', {
  skip: !databaseUrl && !process.env.CI ? 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' : undefined,
}, async t => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  if (!dumpBin || !restoreBin) {
    if (process.env.CI) throw new Error('PG_DUMP_BIN and PG_RESTORE_BIN are required in CI');
    return t.skip('set PG_DUMP_BIN and PG_RESTORE_BIN to PostgreSQL 17 client binaries');
  }
  const { Client } = await import('pg');
  const schema = `test_backup_${randomBytes(8).toString('hex')}`;
  const restoredDb = `test_restore_${randomBytes(8).toString('hex')}`;
  const restoreUrl = new URL(databaseUrl);
  restoreUrl.pathname = `/${restoredDb}`;
  const source = new Client({ connectionString: databaseUrl });
  let restored: InstanceType<typeof Client> | undefined;
  let sourceSchemaCreated = false;
  let restoreDbCreated = false;
  const files = await mkdtemp(join(tmpdir(), 'chat-agent-backup-'));
  try {
    await source.connect();
    await source.query(`CREATE SCHEMA ${schema}`); sourceSchemaCreated = true;
    await source.query(`SET search_path TO ${schema}`);
    await applyMigrations(source, resolve(root, 'db/migrations'));
    const accountId = randomUUID(), contactId = randomUUID(), conversationId = randomUUID();
    const messageId = randomUUID(), sendTaskId = randomUUID(), sendKey = 'backup-unknown-send';
    const now = new Date().toISOString();
    const rawBytes = Buffer.from(JSON.stringify({ synthetic: true, platform: 'qq', message_id: 'backup-fixture' }));
    const rawSha = createHash('sha256').update(rawBytes).digest('hex');
    const rawRoot = join(files, 'raw');
    const rawRef = await createFileRawEventStore(rawRoot).put({ accountId, receivedAt: now, sha256: rawSha, bytes: rawBytes });
    // Private media lives outside the database too, so the restore procedure has to carry it.
    const mediaRoot = join(files, 'media');
    const mediaBytes = Buffer.from('synthetic-image-bytes-for-backup');
    const media = await new FileMediaStore(mediaRoot, async () => contactId).storeMedia({ callerContactId: contactId,
      contactId, messageId, mediaType: 'image', mimeType: 'image/png', bytes: mediaBytes, completeness: 'complete' });
    assert.equal(media.sha256, createHash('sha256').update(mediaBytes).digest('hex'));
    const event = { eventId: randomUUID(), eventType: 'PlatformInboundObserved', eventVersion: 1,
      occurredAt: now, correlationId: randomUUID(), causationId: randomUUID(), aggregateId: conversationId,
      aggregateVersion: 1, payload: { adapter: 'mock', fixture: true } };
    await source.query('BEGIN');
    try {
      await source.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,'synthetic','合成联系人','enrolled',3,$4,$4)`, [contactId, conversationId, accountId, now]);
      await source.query(`INSERT INTO data_messages(id,contact_id,conversation_id,platform_account_id,platform_message_id,platform_event_id,actor,type,content_ref,sent_at,received_at,provenance,is_agent_generated,mode,version,deletion_status,input_hash,created_at,updated_at)
        VALUES($1,$2,$3,$4,'backup-msg','backup-event','contact','text','合成消息',$5,$5,'{}'::jsonb,false,'live',2,'active',$6,$5,$5)`,
        [messageId, contactId, conversationId, accountId, now, rawSha]);
      await source.query(`INSERT INTO dispatch_control(conversation_id,account_id,paused,unresolved_send_key) VALUES($1,$2,true,$3)`, [conversationId, accountId, sendKey]);
      // Note: data_media_assets has no mime_type column, so the byte-format check 01 needs for
      // approved stickers can only come from the private store until that column exists.
      await source.query(`INSERT INTO data_media_assets(id,message_id,contact_id,media_type,storage_ref,sha256,fetch_status,completeness,interpretation_status,platform_metadata,approval_status,approval_version,allowed_platforms,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$15)`,
        [media.id, messageId, contactId, media.mediaType, media.storageRef, media.sha256, media.fetchStatus, media.completeness,
          media.interpretationStatus, JSON.stringify(media.platformMetadata), media.approvalStatus, media.approvalVersion,
          media.allowedPlatforms, media.version, now]);
      await source.query(`INSERT INTO dispatch_attempts(send_task_id,plan_id,conversation_id,account_id,send_key,sequence,mode,content_sha256,expected_generation,expected_policy_version,expected_dependency_epoch,expected_skill_epoch,expected_pause_epoch,expected_global_pause_epoch,status)
        VALUES($1,$2,$3,$4,$5,1,'live',$6,1,1,0,0,0,0,'SUBMITTING')`, [sendTaskId, randomUUID(), conversationId, accountId, sendKey, 'a'.repeat(64)]);
      assert.deepEqual(await commitReceived(source, { rawId: randomUUID(), platform: 'qq', accountId, conversationId,
        eventKey: 'backup-event', payloadRef: rawRef, payloadSha256: rawSha, event }), { inserted: true });
      await source.query('COMMIT');
    } catch (error) { await source.query('ROLLBACK'); throw error; }

    const archive = runPg(dumpBin, [`--dbname=${databaseUrl}`, '--format=custom', `--schema=${schema}`, '--no-owner', '--no-acl']);
    assert.ok(archive.length > 0);
    await cp(rawRoot, join(files, 'raw-restored'), { recursive: true });
    await cp(mediaRoot, join(files, 'media-restored'), { recursive: true });
    await source.query(`CREATE DATABASE ${restoredDb}`); restoreDbCreated = true;
    runPg(restoreBin, [`--dbname=${restoreUrl.toString()}`, '--no-owner', '--no-acl'], archive);
    restored = new Client({ connectionString: restoreUrl.toString() }); await restored.connect();
    await restored.query(`SET search_path TO ${schema}`);
    assert.deepEqual((await restored.query('SELECT version FROM data_contacts WHERE id=$1', [contactId])).rows, [{ version: '3' }]);
    assert.deepEqual((await restored.query('SELECT version,content_ref FROM data_messages WHERE id=$1', [messageId])).rows,
      [{ version: '2', content_ref: '合成消息' }]);
    assert.equal((await restored.query('SELECT count(*)::int AS n FROM event_outbox WHERE published_at IS NULL')).rows[0]?.n, 1);
    assert.equal((await restored.query('SELECT status FROM dispatch_attempts WHERE send_key=$1', [sendKey])).rows[0]?.status, 'SUBMITTING');
    assert.equal((await restored.query('SELECT paused,unresolved_send_key FROM dispatch_control WHERE conversation_id=$1', [conversationId])).rows[0]?.unresolved_send_key, sendKey);
    assert.equal((await restored.query('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0]?.paused, true);
    const rawRow = (await restored.query<{ payload_ref: string; payload_sha256: string }>('SELECT payload_ref,payload_sha256 FROM platform_inbox_raw')).rows[0]!;
    const restoredBytes = await readFile(join(files, 'raw-restored', rawRow.payload_ref));
    assert.equal(createHash('sha256').update(restoredBytes).digest('hex'), rawRow.payload_sha256);
    assert.deepEqual(restoredBytes, rawBytes);
    const mediaRow = (await restored.query<{ storage_ref: string; sha256: string }>('SELECT storage_ref,sha256 FROM data_media_assets WHERE id=$1', [media.id])).rows[0]!;
    assert.equal(mediaRow.storage_ref, media.id);
    assert.equal(mediaRow.sha256, media.sha256);
    // Reading through the restored private store also re-checks the digest and the metadata.
    const restoredMedia = await new FileMediaStore(join(files, 'media-restored'), async () => contactId)
      .readPrivate({ callerContactId: contactId, contactId, mediaId: media.id });
    assert.deepEqual(Buffer.from(restoredMedia.bytes), mediaBytes);
    assert.equal(restoredMedia.asset.sha256, media.sha256);
    assert.equal(restoredMedia.asset.mimeType, 'image/png');
    await restored.query('BEGIN');
    assert.equal(await recoverAmbiguous(restored), 1);
    await restored.query('COMMIT');
    assert.equal((await restored.query('SELECT status FROM dispatch_attempts WHERE send_key=$1', [sendKey])).rows[0]?.status, 'RESULT_UNKNOWN');
    assert.equal((await restored.query('SELECT unresolved_send_key FROM dispatch_control WHERE conversation_id=$1', [conversationId])).rows[0]?.unresolved_send_key, sendKey);
  } finally {
    if (restored) await restored.end();
    if (restoreDbCreated) await source.query(`DROP DATABASE ${restoredDb} WITH (FORCE)`);
    if (sourceSchemaCreated) await source.query(`DROP SCHEMA ${schema} CASCADE`);
    await source.end().catch(() => {});
    await rm(files, { recursive: true, force: true });
  }
});
