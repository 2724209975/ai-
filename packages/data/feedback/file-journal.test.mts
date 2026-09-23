import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileFeedbackJournal } from './file-journal.mts';

test('feedback persists, deduplicates and stays scoped to the plan contact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'data-feedback-'));
  try {
    const resolve = async (plan: string) => plan === 'plan-A' ? 'A' : null;
    const journal = new FileFeedbackJournal(root, resolve);
    const input = { callerContactId: 'A', contactId: 'A', planId: 'plan-A', shownAlternativeIds: ['alt-1'], action: 'edited' as const, originalContent: ['old'], finalContent: ['new'], source: 'owner' as const, idempotencyKey: 'feedback-1' };
    const saved = await journal.recordFeedback(input);
    assert.equal((await journal.recordFeedback(input)).id, saved.id);
    await assert.rejects(journal.recordFeedback({ ...input, finalContent: ['different'] }));
    const reopened = new FileFeedbackJournal(root, resolve);
    assert.equal((await reopened.readFeedback({ callerContactId: 'A', contactId: 'A', idempotencyKey: 'feedback-1' })).id, saved.id);
    await assert.rejects(reopened.readFeedback({ callerContactId: 'B', contactId: 'A', idempotencyKey: 'feedback-1' }));
    await assert.rejects(reopened.readFeedback({ callerContactId: 'B', contactId: 'B', idempotencyKey: 'feedback-1' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
