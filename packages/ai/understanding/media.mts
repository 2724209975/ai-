import type { MediaInput, MediaInterpretationDraft, Result } from '../types.mts';

/** Verified provider output can be wrapped; fake mode never invents media semantics. */
export function interpretFakeMedia(input: MediaInput): Result<MediaInterpretationDraft> {
  if (!input || !input.mediaId || !input.sourceRef) return { ok: false, error: { code: 'VALIDATION_FAILED', message: '媒体输入无效', retryable: false } };
  const verified = input.verifiedInterpretation;
  if (!verified) return { ok: false, error: { code: 'UNSUPPORTED_CAPABILITY', message: '假模型没有媒体理解能力', retryable: false, details: [input.mediaId] } };
  if (verified.completeness !== 'complete' || !verified.text?.trim() || !verified.evidenceRefs?.length || verified.criticalUnclear ||
    (input.mediaType === 'voice' && verified.transcriptCoverage !== 'complete') ||
    (input.mediaType === 'sticker_animated' && verified.visualCoverage !== 'temporal_sequence') ||
    ((input.mediaType === 'image' || input.mediaType === 'sticker_static') && verified.visualCoverage !== 'full_image')) {
    return { ok: false, error: { code: 'MEDIA_UNCERTAIN', message: '媒体关键内容未完整理解，需转人工', retryable: false, details: [input.mediaId] } };
  }
  return { ok: true, value: {
    mediaId: input.mediaId,
    interpreterVersion: 'verified-fixture-1',
    text: verified.text,
    structuredMeaning: { mediaType: input.mediaType, visualCoverage: verified.visualCoverage, transcriptCoverage: verified.transcriptCoverage },
    completeness: 'complete',
    uncertainty: '仅为已验证夹具的结构包装，未验证真实媒体模型能力',
    evidenceRefs: verified.evidenceRefs,
    correctedByOwner: false,
    status: 'draft',
  } };
}
