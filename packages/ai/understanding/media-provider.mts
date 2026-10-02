/** 04-local binary provider boundary. 03 supplies private bytes; 04 has no platform tools. */
import { createHash, randomUUID } from 'node:crypto';
import type { MediaAsset } from '../../data/media/file-store.mts';
import type { MediaInterpretationDraft, PolicyProjection, Result, ScopedContext } from '../types.mts';
import { validateScopedContext, pendingContactBatch } from '../strategy/fake-decision.mts';
import { interpretWithGateway } from './media-gateway.mts';
import { prepareReplyForOrchestration } from '../strategy/orchestration-handoff.mts';

export type UnderstoodMediaType = 'image' | 'voice';
export interface PrivateMediaReader {
  readPrivate(input: { callerContactId: string; contactId: string; mediaId: string; signal?: AbortSignal }): Promise<{ asset: MediaAsset; bytes: Uint8Array }>;
}
export interface BinaryMediaProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly dataRegion: string;
  readonly retentionPolicy: string;
  /** Codec support must be declared by the adapter; this layer never guesses or transcodes. */
  readonly supportedMimeTypes: Readonly<Record<UnderstoodMediaType, readonly string[]>>;
  invoke(input: { mediaType: UnderstoodMediaType; mimeType: string; bytes: Uint8Array; signal: AbortSignal }): Promise<{
    interpretation: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;
}
export type MediaModelMeasurement = Readonly<{
  callId: string; contextSnapshotId: string;
  providerId: string; modelId: string; modelVersion: string; promptVersion: string;
  dataRegion: string; retentionPolicy: string; mediaType: UnderstoodMediaType;
  elapsedMs: number; outcome: 'ok' | 'uncertain' | 'error';
  inputTokens: number | null; outputTokens: number | null;
}>;
export type MediaUnderstandingOptions = Readonly<{
  source: PrivateMediaReader; provider: BinaryMediaProvider;
  /** Whole-batch deadline, including source reads and the final source-version check. */
  timeoutMs?: number; maxBytes?: number; maxMedia?: number;
  observe?: (measurement: MediaModelMeasurement) => void;
}>;

function failure(code: 'VALIDATION_FAILED' | 'MEDIA_UNCERTAIN' | 'UNSUPPORTED_CAPABILITY' | 'MODEL_UNAVAILABLE', retryable = false): Result<never> {
  return { ok: false, error: { code, message: '媒体未能完整可靠理解，需人工处理', retryable } };
}
function validOptions(options: MediaUnderstandingOptions, timeoutMs: number, maxBytes: number, maxMedia: number) {
  const provider = options?.provider;
  return options?.source && typeof options.source.readPrivate === 'function' && provider && typeof provider.invoke === 'function' &&
    [timeoutMs, maxBytes, maxMedia].every(n => Number.isSafeInteger(n) && n > 0) && maxMedia <= 32 &&
    [provider.providerId, provider.modelId, provider.modelVersion, provider.promptVersion, provider.dataRegion, provider.retentionPolicy]
      .every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$/.test(v)) &&
    ['image', 'voice'].every(type => Array.isArray(provider.supportedMimeTypes?.[type as UnderstoodMediaType]) &&
      provider.supportedMimeTypes[type as UnderstoodMediaType].every(mime => typeof mime === 'string' &&
        new RegExp(`^${type === 'image' ? 'image' : 'audio'}/[a-z0-9.+-]+$`).test(mime)));
}
function validAsset(result: { asset: MediaAsset; bytes: Uint8Array }, input: { mediaId: string; messageId: string; contactId: string; mediaType: UnderstoodMediaType }, maxBytes: number) {
  const a = result?.asset, bytes = result?.bytes;
  return a && bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= maxBytes &&
    a.id === input.mediaId && a.messageId === input.messageId && a.contactId === input.contactId && a.mediaType === input.mediaType &&
    a.fetchStatus === 'stored' && a.completeness === 'complete' && !!a.storageRef &&
    Number.isSafeInteger(a.version) && a.version > 0 && typeof a.mimeType === 'string' &&
    typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256) && createHash('sha256').update(bytes).digest('hex') === a.sha256;
}
function validInterpretation(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.text === 'string' && !!v.text.trim() && v.text.length <= 16_384 &&
    typeof v.uncertainty === 'string' && !!v.uncertainty.trim() && v.uncertainty.length <= 2048 &&
    ['complete', 'partial'].includes(String(v.completeness)) && typeof v.criticalUnclear === 'boolean';
}

/** Enriches only the current contact batch. Results remain unpersisted drafts, never send authority.
 * The caller must commit interpretations and dependency versions through 03 before production use. */
export async function interpretContextMedia(context: ScopedContext, policy: PolicyProjection, options: MediaUnderstandingOptions): Promise<Result<ScopedContext>> {
  const timeoutMs = options?.timeoutMs ?? 15_000, maxBytes = options?.maxBytes ?? 10 * 1024 * 1024, maxMedia = options?.maxMedia ?? 8;
  if (!validOptions(options, timeoutMs, maxBytes, maxMedia)) return failure('VALIDATION_FAILED');
  // Trusted configuration is captured once so an asynchronous adapter cannot alter log fields.
  const provider = options.provider;
  const metadata = { providerId: provider.providerId, modelId: provider.modelId, modelVersion: provider.modelVersion,
    promptVersion: provider.promptVersion, dataRegion: provider.dataRegion, retentionPolicy: provider.retentionPolicy };
  const supportedMimeTypes = structuredClone(provider.supportedMimeTypes);
  let copy: ScopedContext;
  try {
    copy = structuredClone(context);
    const valid = validateScopedContext(copy, policy);
    if (!valid.ok) return valid;
    if (copy.snapshot.messageRefs.length !== new Set(copy.snapshot.messageRefs).size || copy.messages.some(m =>
      !['owner', 'contact', 'agent', 'system', 'platform', 'unknown'].includes(m.actor) ||
      !['text', 'image', 'voice', 'sticker_static', 'sticker_animated', 'unsupported'].includes(m.type) ||
      !['live', 'import', 'trial', 'replay'].includes(m.mode))) return failure('VALIDATION_FAILED');
  } catch { return failure('VALIDATION_FAILED'); }
  const pending = pendingContactBatch(copy);
  // Refuse the entire batch before any read/call if actor, mode or type is unsupported.
  if (pending.some(m => m.actor === 'unknown')) return failure('MEDIA_UNCERTAIN');
  if (pending.some(m => m.type === 'unsupported' || m.type.startsWith('sticker_'))) return failure('UNSUPPORTED_CAPABILITY');
  const media = pending.filter(m => m.type !== 'text');
  if (media.some(m => m.actor !== 'contact' || !m.mediaId || !['image', 'voice'].includes(m.type)) ||
    new Set(media.map(m => m.mediaId)).size !== media.length || media.length > maxMedia) return failure('MEDIA_UNCERTAIN');
  if (media.some(m => m.mode !== 'live')) return failure('UNSUPPORTED_CAPABILITY');
  if (!policy.agentEnabled || !media.length) return { ok: true, value: copy };
  const controller = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('MEDIA_DEADLINE')), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    if (controller.signal.aborted) throw new Error('MEDIA_DEADLINE');
    return await Promise.race([operation(), deadline]);
  }
  try {
    for (const message of media) {
      const binding = { mediaId: message.mediaId!, messageId: message.id, contactId: copy.contactId, mediaType: message.type as UnderstoodMediaType };
      const readInput = { callerContactId: copy.contactId, contactId: copy.contactId, mediaId: binding.mediaId, signal: controller.signal };
      let source: { asset: MediaAsset; bytes: Uint8Array };
      try { source = await bounded(() => options.source.readPrivate(readInput)); }
      catch { return failure(controller.signal.aborted ? 'MODEL_UNAVAILABLE' : 'MEDIA_UNCERTAIN', controller.signal.aborted); }
      if (!validAsset(source, binding, maxBytes)) return failure('MEDIA_UNCERTAIN');
      // Capture metadata before the asynchronous provider call; never trust a mutable reader object.
      const asset = structuredClone(source.asset);
      if (!supportedMimeTypes[binding.mediaType].includes(asset.mimeType)) return failure('UNSUPPORTED_CAPABILITY');
      const evidenceRefs = [message.evidenceRef, `media:${asset.id}:${asset.sha256}`];
      const started = performance.now();
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      let outcome: MediaModelMeasurement['outcome'] = 'error';
      try {
        // Only media bytes and codec go to the provider; no identities, paths, policy or other messages.
        const raw = await bounded(() => provider.invoke({ mediaType: binding.mediaType, mimeType: asset.mimeType,
          bytes: Uint8Array.from(source.bytes), signal: controller.signal }));
        usage = raw?.usage;
        if (!validInterpretation(raw?.interpretation)) return failure('MODEL_UNAVAILABLE');
        const result = await interpretWithGateway({ mediaId: asset.id, mediaType: binding.mediaType, sourceRef: message.evidenceRef }, {
          version: `${metadata.providerId}/${metadata.modelId}@${metadata.modelVersion}`,
          promptVersion: metadata.promptVersion, supportedTypes: ['image', 'voice'],
          // Evidence comes from trusted bindings, never from model-generated references.
          interpret: async () => ({ ...raw.interpretation as Record<string, unknown>, evidenceRefs }),
        });
        if (!result.ok) { outcome = result.error.code === 'MEDIA_UNCERTAIN' ? 'uncertain' : 'error'; return result; }
        let current: { asset: MediaAsset; bytes: Uint8Array };
        try { current = await bounded(() => options.source.readPrivate(readInput)); }
        catch { return failure(controller.signal.aborted ? 'MODEL_UNAVAILABLE' : 'MEDIA_UNCERTAIN', controller.signal.aborted); }
        if (!validAsset(current, binding, maxBytes) || current.asset.version !== asset.version || current.asset.sha256 !== asset.sha256 ||
          current.asset.mimeType !== asset.mimeType || current.asset.storageRef !== asset.storageRef) return failure('MEDIA_UNCERTAIN');
        message.mediaInterpretation = { ...result.value, structuredMeaning: { ...result.value.structuredMeaning,
          sourceAssetVersion: asset.version, sourceSha256: asset.sha256,
          dataRegion: metadata.dataRegion, retentionPolicy: metadata.retentionPolicy } };
        outcome = 'ok';
      } catch { return failure('MODEL_UNAVAILABLE', true); }
      finally {
        const count = (n: unknown): number | null => Number.isSafeInteger(n) && (n as number) >= 0 ? n as number : null;
        try {
          options.observe?.({ callId: randomUUID(), contextSnapshotId: copy.snapshot.id, ...metadata, mediaType: binding.mediaType,
            elapsedMs: performance.now() - started, outcome, inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens) });
        } catch { /* Optional metadata observations do not change the business result. */ }
      }
    }
    return { ok: true, value: copy };
  } finally { clearTimeout(timer); }
}

/** Explicit 04 handoff for development/integration: persist returned drafts via 03 before dispatch. */
export async function prepareReplyWithMedia(port: Parameters<typeof prepareReplyForOrchestration>[0], context: ScopedContext,
  policy: PolicyProjection, options: MediaUnderstandingOptions) {
  const interpreted = await interpretContextMedia(context, policy, options);
  if (!interpreted.ok) return interpreted;
  const prepared = await prepareReplyForOrchestration(port, interpreted.value, policy);
  if (!prepared.ok) return prepared;
  return { ok: true as const, value: { ...prepared.value,
    mediaInterpretations: pendingContactBatch(interpreted.value).flatMap(m => m.mediaInterpretation ? [m.mediaInterpretation] : []) as MediaInterpretationDraft[] } };
}
