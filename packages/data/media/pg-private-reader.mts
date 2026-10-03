/** 03 verifies current RLS-scoped bindings before exposing bytes from its private volume. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { PgPool } from '../../infrastructure/postgres/transaction.mts';
import { setContactScope, withTransaction } from '../../infrastructure/postgres/transaction.mts';
import type { MediaAsset } from './file-store.mts';
import { readBoundedImageFile } from './bounded-image-file.mts';
import { IMAGE_MAX_BYTES } from './image-validation.mts';
type AssetRow = Record<string, unknown> & { platform_metadata: Record<string, unknown>; created_at: Date | string; updated_at: Date | string };

export class PgPrivateImageReader {
  private readonly pool: PgPool;
  private readonly root: string;
  constructor(pool: PgPool, root: string) { this.pool = pool; this.root = root; }
  async readPrivate(input: { callerContactId: string; contactId: string; mediaId: string; signal?: AbortSignal }) {
    if (input.callerContactId !== input.contactId) throw new Error('FORBIDDEN');
    if (!/^[0-9a-f-]{36}$/.test(input.mediaId) || input.signal?.aborted) throw new Error('MEDIA_UNCERTAIN');
    const asset = await withTransaction(this.pool, async tx => {
      await setContactScope(tx, input.contactId);
      const a = (await tx.query<AssetRow>(`SELECT a.* FROM data_media_assets a JOIN data_messages m
        ON m.id=a.message_id AND m.contact_id=a.contact_id AND m.media_id=a.id
        WHERE a.id=$1 AND a.contact_id=$2 AND m.actor='contact' AND m.mode='live' AND m.type='image' AND m.deletion_status='active'`,
        [input.mediaId, input.contactId])).rows[0];
      if (!a || a.media_type !== 'image' || a.storage_ref !== a.id || a.fetch_status !== 'stored' || a.completeness !== 'complete') throw new Error('MEDIA_UNCERTAIN');
      const latest = (await tx.query('SELECT status FROM data_media_interpretations WHERE media_id=$1 AND contact_id=$2 ORDER BY version DESC,id DESC LIMIT 1',
        [input.mediaId, input.contactId])).rows[0];
      // A deleted/invalidated interpretation is an owner review boundary, not permission to rerun.
      if (latest && latest.status !== 'valid') throw new Error('MEDIA_UNCERTAIN');
      return { id: a.id, messageId: a.message_id, contactId: a.contact_id, mediaType: a.media_type,
        storageRef: a.storage_ref, sha256: a.sha256, fetchStatus: a.fetch_status, completeness: a.completeness,
        interpretationStatus: a.interpretation_status, platformMetadata: a.platform_metadata,
        mimeType: a.platform_metadata?.mimeType, version: Number(a.version), approvalStatus: a.approval_status,
        approvalVersion: Number(a.approval_version), allowedPlatforms: a.allowed_platforms,
        createdAt: new Date(a.created_at).toISOString(), updatedAt: new Date(a.updated_at).toISOString() } as MediaAsset;
    });
    const bytes = await readBoundedImageFile(join(this.root, `${asset.id}.bin`), IMAGE_MAX_BYTES, input.signal ?? new AbortController().signal);
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('MEDIA_UNCERTAIN');
    return { asset, bytes };
  }
}
