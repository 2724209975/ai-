/** 03 private media metadata and versioned interpretations. Caller owns transaction/scope/lock. */
import { createHash, randomUUID } from 'node:crypto';
import type { PgClient } from '../../infrastructure/postgres/transaction.mts';
import type { MediaAsset } from '../media/file-store.mts';
import type { MediaInterpretationRef } from '../../contracts/index.mts';

type Ref = { id: string; version: number };
export type MediaDraftInput = Readonly<{
  mediaId: string; interpreterVersion: string; text: string; structuredMeaning: Record<string, unknown>;
  completeness: 'complete'; uncertainty: string; evidenceRefs: readonly string[]; correctedByOwner: false; status: 'draft';
}>;
export type StoredMediaInterpretation = Readonly<{
  id: string; version: number; mediaId: string; contactId: string; messageId: string;
  interpreterVersion: string; text: string; structuredMeaning: Record<string, unknown>;
  completeness: 'complete'; coverage: 'full_image' | 'complete_transcript'; uncertainty: string;
  evidenceRefs: string[]; sourceVersions: Ref[]; correctedByOwner: boolean; status: 'valid';
}>;
type Source = Record<string, unknown> & {
  id: string; message_id: string; contact_id: string; media_type: string; version: string | number;
  sha256: string; fetch_status: string; completeness: string; storage_ref: string | null;
  message_version: string | number; message_type: string; actor: string; mode: string;
  platform_account_id: string; platform_message_id: string; sent_at: Date | string;
};
type Interpretation = Record<string, unknown> & {
  id: string; version: string | number; media_id: string; contact_id: string; status: string;
  interpreter_version: string; text_content: string | null; structured_meaning: Record<string, unknown>;
  completeness: string; coverage: string; uncertainty: string; evidence_refs: string[]; corrected_by_owner: boolean;
};
const version = (n: unknown) => Number.isSafeInteger(Number(n)) && Number(n) >= 1;
const text = (s: unknown, max = 16_384): s is string => typeof s === 'string' && !!s.trim() && s.length <= max;
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sourceRefs = (s: Source): Ref[] => [{ id: s.message_id, version: Number(s.message_version) }, { id: s.id, version: Number(s.version) }];
const evidence = (s: Source) => [`${s.platform_account_id}:${s.platform_message_id}`, `media:${s.id}:${s.sha256}`];

export class PgMediaRepository {
  private readonly tx: PgClient;
  private readonly contactId: string;
  constructor(tx: PgClient, contactId: string) { this.tx = tx; this.contactId = contactId; }

  async #source(mediaId: string): Promise<Source> {
    const found = await this.tx.query<Source>(`SELECT a.*,m.version AS message_version,m.type AS message_type,m.actor,m.mode,
      m.platform_account_id,m.platform_message_id,m.sent_at FROM data_media_assets a
      JOIN data_messages m ON m.id=a.message_id AND m.contact_id=a.contact_id AND m.media_id=a.id
      WHERE a.id=$1 AND a.contact_id=$2 AND m.contact_id=$2 AND m.deletion_status='active'`, [mediaId, this.contactId]);
    const s = found.rows[0];
    if (!s) throw new Error('NOT_FOUND');
    if (!['image', 'voice'].includes(s.media_type) || s.message_type !== s.media_type || s.actor !== 'contact' || s.mode !== 'live' ||
      !version(s.version) || !version(s.message_version) || s.fetch_status !== 'stored' || s.completeness !== 'complete' ||
      !s.storage_ref || !/^[a-f0-9]{64}$/.test(s.sha256 ?? '')) throw new Error('MEDIA_UNCERTAIN');
    return s;
  }
  async #latest(mediaId: string): Promise<Interpretation | undefined> {
    const result = await this.tx.query<Interpretation>(`SELECT * FROM data_media_interpretations
      WHERE media_id=$1 AND contact_id=$2 ORDER BY version DESC,id DESC LIMIT 2`, [mediaId, this.contactId]);
    if (result.rows.length === 2 && Number(result.rows[0]!.version) === Number(result.rows[1]!.version)) throw new Error('STALE_CONTEXT');
    return result.rows[0];
  }

  /** Registers metadata produced by 03's private byte store, not a browser-supplied path. */
  async register(asset: MediaAsset, expectedMessageVersion: number): Promise<Ref & { duplicate: boolean }> {
    if (asset?.contactId !== this.contactId || !asset.id || !asset.messageId || !['image', 'voice'].includes(asset.mediaType) ||
      asset.fetchStatus !== 'stored' || asset.completeness !== 'complete' || !asset.storageRef ||
      !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || !version(asset.version) || !version(expectedMessageVersion) ||
      typeof asset.mimeType !== 'string' || !/^(image|audio)\/[a-z0-9.+-]+$/.test(asset.mimeType) ||
      (asset.mediaType === 'image') !== asset.mimeType.startsWith('image/') || asset.approvalStatus !== 'unapproved') throw new Error('VALIDATION_FAILED');
    const message = (await this.tx.query<Record<string, unknown>>(`SELECT * FROM data_messages
      WHERE id=$1 AND contact_id=$2 AND deletion_status='active' FOR UPDATE`, [asset.messageId, this.contactId])).rows[0];
    if (!message) throw new Error('NOT_FOUND');
    const prior = (await this.tx.query<Record<string, unknown>>('SELECT * FROM data_media_assets WHERE id=$1 AND contact_id=$2', [asset.id, this.contactId])).rows[0];
    if (prior) {
      if (prior.message_id !== asset.messageId || message.media_id !== asset.id || prior.sha256 !== asset.sha256 ||
        prior.storage_ref !== asset.storageRef || prior.media_type !== asset.mediaType || prior.fetch_status !== 'stored' ||
        prior.completeness !== 'complete' || Number(prior.version) !== asset.version ||
        (prior.platform_metadata as Record<string, unknown>)?.mimeType !== asset.mimeType ||
        Number(message.version) !== expectedMessageVersion + 1 && Number(message.version) !== expectedMessageVersion) throw new Error('CONFLICT_VERSION');
      return { id: asset.id, version: Number(prior.version), duplicate: true };
    }
    if (Number(message.version) !== expectedMessageVersion) throw new Error('CONFLICT_VERSION');
    if (message.type !== asset.mediaType || message.actor !== 'contact' || message.mode !== 'live' ||
      message.media_id && message.media_id !== asset.id) throw new Error('VALIDATION_FAILED');
    await this.tx.query(`INSERT INTO data_media_assets(id,message_id,contact_id,media_type,storage_ref,sha256,fetch_status,completeness,
      interpretation_status,platform_metadata,approval_status,approval_version,allowed_platforms,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'stored','complete','pending',$7::jsonb,'unapproved',1,'{}',$8,now(),now())`,
      [asset.id, asset.messageId, this.contactId, asset.mediaType, asset.storageRef, asset.sha256,
        JSON.stringify({ ...asset.platformMetadata, mimeType: asset.mimeType }), asset.version]);
    await this.tx.query('UPDATE data_messages SET media_id=$2,version=version+1,updated_at=now() WHERE id=$1 AND contact_id=$3',
      [asset.messageId, asset.id, this.contactId]);
    return { id: asset.id, version: asset.version, duplicate: false };
  }

  async #write(s: Source, value: { interpreterVersion: string; text: string; structuredMeaning: Record<string, unknown>; uncertainty: string;
    evidenceRefs: readonly string[] }, next: number, correctedByOwner: boolean): Promise<Ref> {
    // Superseded bodies are not retained as usable historical text; immutable snapshots keep refs.
    await this.tx.query(`UPDATE data_media_interpretations SET status='invalid',text_content=NULL,structured_meaning='{}',
      evidence_refs='[]',uncertainty='解释已失效',updated_at=now() WHERE media_id=$1 AND contact_id=$2`, [s.id, this.contactId]);
    const id = randomUUID(), coverage = s.media_type === 'image' ? 'full_image' : 'complete_transcript';
    await this.tx.query(`INSERT INTO data_media_interpretations(id,media_id,contact_id,interpreter_version,text_content,structured_meaning,
      completeness,coverage,uncertainty,evidence_refs,corrected_by_owner,status,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,'complete',$7,$8,$9::jsonb,$10,'valid',$11,now(),now())`,
      [id, s.id, this.contactId, value.interpreterVersion, value.text, JSON.stringify(value.structuredMeaning), coverage,
        value.uncertainty, JSON.stringify(value.evidenceRefs), correctedByOwner, next]);
    for (const [kind, ref] of [['message', sourceRefs(s)[0]!], ['media', sourceRefs(s)[1]!]] as const)
      await this.tx.query(`INSERT INTO data_evidence(owner_kind,owner_id,source_kind,source_id,source_version,contact_id)
        VALUES('interpretation',$1,$2,$3,$4,$5)`, [id, kind, ref.id, ref.version, this.contactId]);
    await this.tx.query(`UPDATE data_media_assets SET interpretation_status='complete',updated_at=now() WHERE id=$1 AND contact_id=$2`, [s.id, this.contactId]);
    return { id, version: next };
  }

  async store(input: { draft: MediaDraftInput; expectedMessageVersion: number; expectedAssetVersion: number;
    expectedInterpretationVersion: number; cutoffTime: string }): Promise<Ref & { duplicate: boolean }> {
    const d = input.draft, meaning = d?.structuredMeaning;
    if (!d || d.status !== 'draft' || d.correctedByOwner !== false || d.completeness !== 'complete' ||
      !text(d.interpreterVersion, 512) || !text(d.text) || !text(d.uncertainty, 2048) ||
      !meaning || typeof meaning !== 'object' || Array.isArray(meaning) || !Array.isArray(d.evidenceRefs) ||
      !version(input.expectedMessageVersion) || !version(input.expectedAssetVersion) ||
      !Number.isSafeInteger(input.expectedInterpretationVersion) || input.expectedInterpretationVersion < 0 ||
      !Number.isFinite(Date.parse(input.cutoffTime))) throw new Error('VALIDATION_FAILED');
    const s = await this.#source(d.mediaId);
    if (Number(s.version) !== input.expectedAssetVersion || Number(s.message_version) !== input.expectedMessageVersion) throw new Error('CONFLICT_VERSION');
    if (new Date(s.sent_at).getTime() > Date.parse(input.cutoffTime)) throw new Error('VALIDATION_FAILED');
    if (meaning.mediaType !== s.media_type || meaning.sourceAssetVersion !== Number(s.version) || meaning.sourceSha256 !== s.sha256 ||
      !text(meaning.promptVersion, 256) || !text(meaning.dataRegion, 128) || !text(meaning.retentionPolicy, 128) ||
      s.media_type === 'image' && meaning.visualCoverage !== 'full_image' ||
      s.media_type === 'voice' && meaning.transcriptCoverage !== 'complete' || JSON.stringify(d.evidenceRefs) !== JSON.stringify(evidence(s))) throw new Error('MEDIA_UNCERTAIN');
    const value = { interpreterVersion: d.interpreterVersion, text: d.text, uncertainty: d.uncertainty, evidenceRefs: evidence(s),
      structuredMeaning: { mediaType: s.media_type, promptVersion: meaning.promptVersion, sourceAssetVersion: Number(s.version),
        sourceSha256: s.sha256, dataRegion: meaning.dataRegion, retentionPolicy: meaning.retentionPolicy,
        ...(s.media_type === 'image' ? { visualCoverage: 'full_image' } : { transcriptCoverage: 'complete' }) } };
    const inputHash = sha(value);
    const latest = await this.#latest(s.id);
    if (latest?.status === 'valid' && !latest.corrected_by_owner && latest.structured_meaning.inputHash === inputHash &&
      Number(latest.version) === input.expectedInterpretationVersion + 1) return { id: latest.id, version: Number(latest.version), duplicate: true };
    if (Number(latest?.version ?? 0) !== input.expectedInterpretationVersion) throw new Error('CONFLICT_VERSION');
    const ref = await this.#write(s, { ...value, structuredMeaning: { ...value.structuredMeaning, inputHash } }, input.expectedInterpretationVersion + 1, false);
    return { ...ref, duplicate: false };
  }

  async change(input: { mediaId: string; expectedInterpretationVersion: number; action: 'correct' | 'delete'; text?: string }): Promise<Ref> {
    if (!version(input.expectedInterpretationVersion) || !['correct', 'delete'].includes(input.action) ||
      input.action === 'correct' && !text(input.text)) throw new Error('VALIDATION_FAILED');
    const s = await this.#source(input.mediaId), current = await this.read(input.mediaId);
    if (!current) throw new Error('NOT_FOUND');
    if (current.version !== input.expectedInterpretationVersion) throw new Error('CONFLICT_VERSION');
    if (input.action === 'correct') return await this.#write(s, { ...current, text: input.text!,
      structuredMeaning: { ...current.structuredMeaning, inputHash: undefined }, uncertainty: '本人纠正的媒体解释，仍仅作为该联系人聊天内容' }, current.version + 1, true);
    await this.tx.query(`UPDATE data_media_interpretations SET status='invalid',text_content=NULL,structured_meaning='{}',evidence_refs='[]',uncertainty='解释已删除',
      version=CASE WHEN id=$3 THEN version+1 ELSE version END,updated_at=now() WHERE media_id=$1 AND contact_id=$2`, [s.id, this.contactId, current.id]);
    await this.tx.query(`UPDATE data_media_assets SET interpretation_status='pending',updated_at=now() WHERE id=$1 AND contact_id=$2`, [s.id, this.contactId]);
    return { id: current.id, version: current.version + 1 };
  }

  /** Parent message deletion already emits the single dependency invalidation event. */
  async purgeMessage(messageId: string): Promise<void> {
    await this.tx.query(`UPDATE data_media_interpretations SET status='invalid',text_content=NULL,structured_meaning='{}',evidence_refs='[]',uncertainty='源消息已删除',
      version=version+1,updated_at=now() WHERE contact_id=$2 AND media_id IN
      (SELECT id FROM data_media_assets WHERE message_id=$1 AND contact_id=$2)`, [messageId, this.contactId]);
    await this.tx.query(`UPDATE data_media_assets SET storage_ref=NULL,fetch_status='failed',completeness='unavailable',
      interpretation_status='failed',version=version+1,updated_at=now() WHERE message_id=$1 AND contact_id=$2`, [messageId, this.contactId]);
  }

  async read(mediaId: string): Promise<StoredMediaInterpretation | undefined> {
    const latest = await this.#latest(mediaId);
    if (!latest || latest.status !== 'valid') return;
    let s: Source;
    try { s = await this.#source(mediaId); } catch (error) {
      if (error instanceof Error && ['NOT_FOUND', 'MEDIA_UNCERTAIN'].includes(error.message)) return;
      throw error;
    }
    const source = await this.tx.query<{ source_kind: string; source_id: string; source_version: string | number; contact_id: string }>(
      `SELECT source_kind,source_id,source_version,contact_id FROM data_evidence WHERE owner_kind='interpretation' AND owner_id=$1
       ORDER BY CASE WHEN source_kind='message' THEN 0 ELSE 1 END,source_id`, [latest.id]);
    const refs = source.rows.map(r => ({ id: r.source_id, version: Number(r.source_version) }));
    const coverage = s.media_type === 'image' ? 'full_image' : 'complete_transcript';
    if (source.rows.length !== 2 || source.rows[0]?.source_kind !== 'message' || source.rows[1]?.source_kind !== 'media' ||
      source.rows.some(r => r.contact_id !== this.contactId) || JSON.stringify(refs) !== JSON.stringify(sourceRefs(s)) ||
      latest.completeness !== 'complete' || latest.coverage !== coverage || !text(latest.text_content) || !text(latest.uncertainty, 2048) ||
      latest.structured_meaning?.sourceAssetVersion !== Number(s.version) || latest.structured_meaning?.sourceSha256 !== s.sha256 ||
      latest.structured_meaning?.mediaType !== s.media_type || s.interpretation_status !== 'complete' ||
      s.media_type === 'image' && latest.structured_meaning.visualCoverage !== 'full_image' ||
      s.media_type === 'voice' && latest.structured_meaning.transcriptCoverage !== 'complete' ||
      JSON.stringify(latest.evidence_refs) !== JSON.stringify(evidence(s))) return;
    return { id: latest.id, version: Number(latest.version), mediaId, contactId: this.contactId, messageId: s.message_id,
      interpreterVersion: latest.interpreter_version, text: latest.text_content!, structuredMeaning: latest.structured_meaning,
      completeness: 'complete', coverage, uncertainty: latest.uncertainty, evidenceRefs: latest.evidence_refs,
      sourceVersions: refs, correctedByOwner: latest.corrected_by_owner, status: 'valid' };
  }
}
export function interpretationRef(i: StoredMediaInterpretation): MediaInterpretationRef {
  return { id: i.id, version: i.version, completeness: i.completeness, coverage: i.coverage,
    evidenceRefs: i.sourceVersions, correctedByOwner: i.correctedByOwner };
}
