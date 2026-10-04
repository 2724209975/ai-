/** QQ media acquisition boundary. No direct CDN URL, local file path, or credential access. */
import { createHash } from 'node:crypto';
import { WireError } from './onebot-codec.mts';
import type { WireMessage, WirePart } from './onebot-codec.mts';
import { validateImageBytes, IMAGE_MAX_BYTES } from '../../data/media/image-validation.mts';

type MediaPart = Extract<WirePart, { kind: 'media' }>;
export type MediaPointer = {
  externalAccountRef: string; externalContactRef: string; platformMessageId: string;
  rawEventRef: string; segmentIndex: number; mediaKind: MediaPart['mediaKind'];
};
export type SourceArtifact = {
  bytes: Uint8Array;
  // Bridge claims are retained as provenance, not upgraded to verified completeness.
  representation: 'original' | 'thumbnail' | 'single_frame' | 'transcoded' | 'unknown';
  reportedMime?: string;
};
export type MediaSource = {
  /** Resolve the authenticated raw event privately, then fetch/transfer bytes within maxBytes. */
  read(pointer: MediaPointer, maxBytes: number): Promise<SourceArtifact | undefined>;
};
export type PrivateMediaStore = {
  /** 03 persists bytes privately and returns a durable, non-public asset reference. */
  put(input: { pointer: MediaPointer; bytes: Uint8Array; sha256: string; detectedMime: string; representation: SourceArtifact['representation']; reportedMime?: string }): Promise<string>;
};
export type MediaReadGate = {
  /** 02/03 must keep enrollment/scope authorization valid through read and private write. */
  withAuthorizedRead<T>(pointer: MediaPointer, action: () => Promise<T>): Promise<T>;
};
export type MediaAcquisitionResult =
  | { fetchStatus: 'fetched'; completeness: 'unknown' | 'partial' | 'complete'; assetRef: string; sha256: string; byteLength: number;
      detectedMime: string; animation: 'unknown' | 'static'; representation: SourceArtifact['representation']; reason?: 'MEDIA_UNCERTAIN' }
  | { fetchStatus: 'unavailable'; completeness: 'unknown'; code: 'MEDIA_UNCERTAIN' | 'POLICY_BLOCKED'; retryable: false };

function detectMime(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 9 && b.toString('ascii', 0, 9) === '#!SILK_V3') return 'audio/silk';
  return 'application/octet-stream';
}

/** Legacy callers keep uncertain completeness; the explicit original profile adds full decoding. */
export async function acquireQqMedia(message: WireMessage, segmentIndex: number, deps: {
  source: MediaSource; store: PrivateMediaStore; gate: MediaReadGate; maxBytes: number;
  /** Explicit profile enables full decoding; only operator-verified originals can become complete. */
  originalVerified?: boolean;
}): Promise<MediaAcquisitionResult> {
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0 || !Number.isSafeInteger(deps.maxBytes) || deps.maxBytes < 1) throw new WireError();
  const part = message.parts[segmentIndex];
  if (message.kind !== 'message' || part?.kind !== 'media' || part.segmentIndex !== segmentIndex || part.originalEventRef !== message.rawEventRef) throw new WireError('VALIDATION_FAILED');
  const pointer: MediaPointer = { externalAccountRef: message.externalAccountRef, externalContactRef: message.externalContactRef,
    platformMessageId: message.platformMessageId, rawEventRef: message.rawEventRef, segmentIndex, mediaKind: part.mediaKind };
  try {
    return await deps.gate.withAuthorizedRead(structuredClone(pointer), async () => {
      const artifact = await deps.source.read(structuredClone(pointer), deps.maxBytes);
      if (!artifact || !(artifact.bytes instanceof Uint8Array) || !artifact.bytes.byteLength || artifact.bytes.byteLength > deps.maxBytes
        || !['original', 'thumbnail', 'single_frame', 'transcoded', 'unknown'].includes(artifact.representation)) {
        return { fetchStatus: 'unavailable', completeness: 'unknown', code: 'MEDIA_UNCERTAIN', retryable: false } as const;
      }
      const bytes = new Uint8Array(artifact.bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const detectedMime = detectMime(bytes);
      const checked = deps.originalVerified !== undefined && pointer.mediaKind === 'image';
      if (checked && (bytes.length > IMAGE_MAX_BYTES || ['thumbnail','single_frame','transcoded'].includes(artifact.representation)
        || !(await validateImageBytes(bytes, detectedMime)).ok || deps.originalVerified !== true))
        return { fetchStatus: 'unavailable', completeness: 'unknown', code: 'MEDIA_UNCERTAIN', retryable: false } as const;
      const assetRef = await deps.store.put({ pointer: structuredClone(pointer), bytes, sha256, detectedMime,
        representation: artifact.representation, reportedMime: artifact.reportedMime });
      if (typeof assetRef !== 'string' || !assetRef.trim()) throw new WireError('MEDIA_UNCERTAIN');
      const partial = ['thumbnail', 'single_frame', 'transcoded'].includes(artifact.representation);
      return { fetchStatus: 'fetched', completeness: checked ? 'complete' : partial ? 'partial' : 'unknown', assetRef, sha256,
        byteLength: bytes.byteLength, detectedMime, animation: checked ? 'static' : 'unknown', representation: artifact.representation,
        ...(partial ? { reason: 'MEDIA_UNCERTAIN' as const } : {}) } as const;
    });
  } catch (error) {
    return { fetchStatus: 'unavailable', completeness: 'unknown', code: error instanceof WireError && error.code === 'POLICY_BLOCKED' ? 'POLICY_BLOCKED' : 'MEDIA_UNCERTAIN', retryable: false };
  }
}
