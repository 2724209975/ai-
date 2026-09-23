import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMediaStore } from './file-store.mts';

test('private media persists across instances and approved read checks contact/platform/version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'data-media-'));
  try {
    const resolve = async (id: string) => id === 'message-A' ? 'A' : null;
    const store = new FileMediaStore(root, resolve);
    const saved = await store.storeMedia({ callerContactId: 'A', contactId: 'A', messageId: 'message-A', mediaType: 'sticker_static', mimeType: 'image/png', bytes: Buffer.from('png fixture'), completeness: 'complete' });
    await assert.rejects(store.readPrivate({ callerContactId: 'B', contactId: 'A', mediaId: saved.id }));
    const reopened = new FileMediaStore(root, resolve);
    assert.equal((await reopened.readPrivate({ callerContactId: 'A', contactId: 'A', mediaId: saved.id })).asset.sha256, saved.sha256);
    await assert.rejects(reopened.readApproved({ callerContactId: 'A', contactId: 'A', mediaId: saved.id, platform: 'qq', approvalVersion: 1 }));
    const approved = await reopened.approveSticker({ callerContactId: 'A', contactId: 'A', mediaId: saved.id, expectedVersion: 1, allowedPlatforms: ['qq'] });
    assert.equal(approved.approvalVersion, 2);
    await assert.rejects(reopened.readApproved({ callerContactId: 'A', contactId: 'A', mediaId: saved.id, platform: 'wechat', approvalVersion: 2 }));
    assert.deepEqual((await reopened.readApproved({ callerContactId: 'A', contactId: 'A', mediaId: saved.id, platform: 'qq', approvalVersion: 2 })).bytes, Buffer.from('png fixture'));
    await reopened.deleteMedia({ callerContactId: 'A', contactId: 'A', mediaId: saved.id });
    await assert.rejects(reopened.readPrivate({ callerContactId: 'A', contactId: 'A', mediaId: saved.id }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
