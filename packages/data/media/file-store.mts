/** Private-volume media store. Root must be outside the web static directory. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError } from '../context/store.mts';

export type MediaAsset = Readonly<{ id: string; messageId: string; contactId: string; mediaType: 'image' | 'voice' | 'sticker_static' | 'sticker_animated'; storageRef: string | null; sha256: string | null; fetchStatus: 'stored' | 'failed'; completeness: 'complete' | 'partial' | 'unavailable' | 'unknown'; interpretationStatus: 'pending' | 'complete' | 'uncertain' | 'failed'; platformMetadata: Record<string, unknown>; approvalStatus: 'unapproved' | 'approved' | 'revoked'; approvalVersion: number; allowedPlatforms: readonly string[]; mimeType: string; version: number; createdAt: string; updatedAt: string }>;

export class FileMediaStore {
  private readonly root: string;
  private readonly messageContact: (messageId: string) => Promise<string | null>;
  private readonly clock: () => number;
  constructor(root: string, messageContact: (messageId: string) => Promise<string | null>, clock: () => number = Date.now) { this.root = root; this.messageContact = messageContact; this.clock = clock; }
  #meta(id: string) { return join(this.root, `${id}.json`); }
  #body(id: string) { return join(this.root, `${id}.bin`); }
  async #read(id: string): Promise<MediaAsset> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new DataError('NOT_FOUND');
    try { return JSON.parse(await readFile(this.#meta(id), 'utf8')) as MediaAsset; } catch { throw new DataError('NOT_FOUND'); }
  }
  async storeMedia(input: { callerContactId: string; contactId: string; messageId: string; mediaType: MediaAsset['mediaType']; mimeType: string; bytes: Uint8Array; completeness: MediaAsset['completeness']; platformMetadata?: Record<string, unknown> }): Promise<MediaAsset> {
    if (input.callerContactId !== input.contactId) throw new DataError('FORBIDDEN');
    if (await this.messageContact(input.messageId) !== input.contactId) throw new DataError('NOT_FOUND');
    if (!['image','voice','sticker_static','sticker_animated'].includes(input.mediaType) || !input.mimeType?.trim() || !input.bytes?.length || input.completeness !== 'complete') throw new DataError('VALIDATION_FAILED');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID(); const t = new Date(this.clock()).toISOString();
    const asset: MediaAsset = { id, messageId: input.messageId, contactId: input.contactId, mediaType: input.mediaType, storageRef: id, sha256: createHash('sha256').update(input.bytes).digest('hex'), fetchStatus: 'stored', completeness: input.completeness, interpretationStatus: 'pending', platformMetadata: structuredClone(input.platformMetadata ?? {}), approvalStatus: 'unapproved', approvalVersion: 1, allowedPlatforms: [], mimeType: input.mimeType, version: 1, createdAt: t, updatedAt: t };
    await writeFile(this.#body(id), input.bytes, { flag: 'wx', mode: 0o600 });
    try { await writeFile(this.#meta(id), JSON.stringify(asset), { flag: 'wx', mode: 0o600 }); }
    catch (e) { await rm(this.#body(id), { force: true }); throw e; }
    return structuredClone(asset);
  }
  async readPrivate(input: { callerContactId: string; contactId: string; mediaId: string }): Promise<{ asset: MediaAsset; bytes: Uint8Array }> {
    if (input.callerContactId !== input.contactId) throw new DataError('FORBIDDEN');
    const asset = await this.#read(input.mediaId);
    if (asset.contactId !== input.contactId || await this.messageContact(asset.messageId) !== input.contactId) throw new DataError('NOT_FOUND');
    const bytes = await readFile(this.#body(asset.id));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new DataError('VALIDATION_FAILED');
    return { asset: structuredClone(asset), bytes };
  }
  async approveSticker(input: { callerContactId: string; contactId: string; mediaId: string; expectedVersion: number; allowedPlatforms: readonly string[] }): Promise<MediaAsset> {
    const { asset } = await this.readPrivate(input);
    if (asset.version !== input.expectedVersion) throw new DataError('CONFLICT_VERSION');
    if (!asset.mediaType.startsWith('sticker_') || !input.allowedPlatforms?.length || input.allowedPlatforms.some(x => !x.trim())) throw new DataError('VALIDATION_FAILED');
    const next: MediaAsset = { ...asset, approvalStatus: 'approved', approvalVersion: asset.approvalVersion + 1, allowedPlatforms: [...new Set(input.allowedPlatforms)], version: asset.version + 1, updatedAt: new Date(this.clock()).toISOString() };
    await writeFile(`${this.#meta(asset.id)}.tmp`, JSON.stringify(next), { mode: 0o600 }); await rename(`${this.#meta(asset.id)}.tmp`, this.#meta(asset.id));
    return structuredClone(next);
  }
  async readApproved(input: { callerContactId: string; contactId: string; mediaId: string; platform: string; approvalVersion: number }) {
    const result = await this.readPrivate(input);
    if (result.asset.approvalStatus !== 'approved' || result.asset.approvalVersion !== input.approvalVersion || !result.asset.allowedPlatforms.includes(input.platform)) throw new DataError('FORBIDDEN');
    return result;
  }
  async deleteMedia(input: { callerContactId: string; contactId: string; mediaId: string }): Promise<void> {
    await this.readPrivate(input);
    await rm(this.#body(input.mediaId), { force: true });
    await rm(this.#meta(input.mediaId), { force: true });
  }
}
