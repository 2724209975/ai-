import type { MediaInput, MediaInterpretationDraft, Result } from '../types.mts';
import { interpretFakeMedia } from './media.mts';

type MediaType = MediaInput['mediaType'];

/** Provider-neutral contract. D06 selects and validates a real implementation later. */
export interface MediaGateway {
  readonly version: string;
  readonly promptVersion: string;
  readonly supportedTypes: readonly MediaType[];
  interpret(input: { mediaId: string; mediaType: MediaType; sourceRef: string; signal: AbortSignal }): Promise<unknown>;
}

function providerOutput(value: unknown): value is NonNullable<MediaInput['verifiedInterpretation']> & { uncertainty: string } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.text === 'string' && typeof v.uncertainty === 'string' && !!v.uncertainty.trim() &&
    (v.completeness === 'complete' || v.completeness === 'partial') &&
    Array.isArray(v.evidenceRefs) && v.evidenceRefs.length > 0 && v.evidenceRefs.every(ref => typeof ref === 'string' && !!ref.trim()) &&
    (v.visualCoverage === undefined || ['full_image', 'single_frame', 'temporal_sequence'].includes(String(v.visualCoverage))) &&
    (v.transcriptCoverage === undefined || ['complete', 'partial'].includes(String(v.transcriptCoverage))) &&
    (v.criticalUnclear === undefined || typeof v.criticalUnclear === 'boolean');
}

export async function interpretWithGateway(input: Omit<MediaInput, 'verifiedInterpretation'>, gateway: MediaGateway, timeoutMs = 3000): Promise<Result<MediaInterpretationDraft>> {
  if (!input?.mediaId || !input.sourceRef || !['image', 'voice', 'sticker_static', 'sticker_animated'].includes(input.mediaType) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ok: false, error: { code: 'VALIDATION_FAILED', message: '媒体或超时参数无效', retryable: false } };
  }
  if (!gateway.supportedTypes.includes(input.mediaType)) return { ok: false, error: { code: 'UNSUPPORTED_CAPABILITY', message: '模型不支持该媒体类型，需转人工', retryable: false, details: [input.mediaId] } };
  if (!gateway.version?.trim() || !gateway.promptVersion?.trim()) return { ok: false, error: { code: 'VALIDATION_FAILED', message: '媒体模型版本缺失', retryable: false } };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      gateway.interpret({ ...input, signal: controller.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('MODEL_TIMEOUT')); }, timeoutMs); }),
    ]);
    if (!providerOutput(raw)) return { ok: false, error: { code: 'MODEL_UNAVAILABLE', message: '媒体模型返回结构无效', retryable: false, details: [input.mediaId] } };
    const wrapped = interpretFakeMedia({ ...input, verifiedInterpretation: raw });
    if (!wrapped.ok) return wrapped;
    return { ok: true, value: { ...wrapped.value, interpreterVersion: gateway.version, uncertainty: raw.uncertainty,
      structuredMeaning: { ...wrapped.value.structuredMeaning, promptVersion: gateway.promptVersion } } };
  } catch (error) {
    return { ok: false, error: { code: 'MODEL_UNAVAILABLE', message: error instanceof Error && error.message === 'MODEL_TIMEOUT' ? '媒体模型响应超时' : '媒体模型暂不可用', retryable: true, details: [input.mediaId] } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function interpretWithFallback(input: Omit<MediaInput, 'verifiedInterpretation'>, primary: MediaGateway, fallback: MediaGateway | null, timeoutMs = 3000): Promise<Result<MediaInterpretationDraft>> {
  const first = await interpretWithGateway(input, primary, timeoutMs);
  if (first.ok || !fallback || !['MODEL_UNAVAILABLE', 'UNSUPPORTED_CAPABILITY'].includes(first.error.code)) return first;
  return interpretWithGateway(input, fallback, timeoutMs);
}
