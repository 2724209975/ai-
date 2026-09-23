import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDataContextStore } from '../context/store.mts';
import { MemoryImportService } from './service.mts';

const now = '2026-09-23T10:00:00.000Z';
test('preview requires identity mapping, import is isolated from live and repeated source is idempotent', () => {
  const data = new MemoryDataContextStore(() => Date.parse(now));
  const a = data.createContact({ conversationId: 'conv-A', platformAccountId: 'acct', externalContactRef: 'A', displayName: 'A', enrollmentStatus: 'enrolled' });
  const importer = new MemoryImportService(data, () => Date.parse(now));
  const rows = [{ line: 1, externalConversationRef: 'A', platformMessageId: 'p1', platformEventId: 'e1', senderRef: 'self', type: 'text' as const, contentRef: 'history', sentAt: now }];
  const job = importer.previewImport({ format: 'fixture', sourceBytes: Buffer.from('source-1'), rows });
  assert.equal(job.preview[0]?.messageCount, 1);
  assert.equal(data.queryMessages({ callerContactId: a.id, contactId: a.id, cutoffTime: now }).length, 0);
  assert.throws(() => importer.commitImport({ jobId: job.id, platformAccountId: 'acct', identityMapping: {}, confirmedScope: ['A'] }));
  const input = { jobId: job.id, platformAccountId: 'acct', identityMapping: { A: { contactId: a.id, conversationId: a.conversationId, ownerSenderRef: 'self', peerSenderRef: 'A' } }, confirmedScope: ['A'] };
  assert.equal(importer.commitImport(input).inserted, 1);
  assert.equal(importer.commitImport(input).inserted, 0);
  assert.equal(importer.previewImport({ format: 'fixture', sourceBytes: Buffer.from('source-1'), rows }).status, 'committed');
  assert.equal(data.queryMessages({ callerContactId: a.id, contactId: a.id, cutoffTime: now }).length, 0);
  assert.equal(data.queryMessages({ callerContactId: a.id, contactId: a.id, cutoffTime: now, mode: 'import' }).length, 1);
});
