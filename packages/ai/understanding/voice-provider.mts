/** Real speech-to-text behind 04's `BinaryMediaProvider` contract.
 *
 * This is a generic adapter for the OpenAI-compatible multipart `/audio/transcriptions` shape, not a
 * guess about any one vendor: no provider is named here, and no vendor is claimed to support it. It
 * is created only when an operator explicitly supplies an endpoint and a key, so an unconfigured
 * installation reports an empty voice codec list and every voice message keeps going to a human.
 *
 * The adapter receives one already-validated audio file (bytes, media type, MIME type, abort signal).
 * It never sees a contact, a message id, a path or a policy, and it never logs the key or the text.
 * Transcripts are described as complete coverage only when the provider returned a non-empty
 * transcript; a model that returns nothing is a failure, never an empty success.
 */
import { DeepSeekHttpError, providerErrorCode } from '../generation/deepseek-provider.mts';
import type { BinaryMediaProvider } from './media-provider.mts';

export const VOICE_TRANSCRIPTION_PROMPT = 'media-voice-transcription-1';

/** Containers this adapter will forward. The provider must still tell the truth about what it accepts. */
export const SUPPORTED_AUDIO_FORMATS: readonly string[] =
  ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/flac'];

export type VoiceProviderOptions = {
  apiKey: string;
  modelId: string;
  modelVersion?: string;
  promptVersion: string;
  dataRegion: string;
  retentionPolicy: string;
  /** Full transcriptions endpoint, e.g. `https://host/v1/audio/transcriptions`. */
  endpoint: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Optional ISO-639-1 hint; omitted unless the operator sets it. */
  language?: string;
};

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 16_384;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Normalises the provider's answer into the shape 04's media gateway validates. */
export function normaliseTranscriptInterpretation(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MODEL_UNAVAILABLE');
  const value = raw as Record<string, unknown>;
  const transcript = text(value.text ?? value.transcript);
  if (!transcript || transcript.length > MAX_TEXT_CHARS) throw new Error('MODEL_UNAVAILABLE');
  const segments = Array.isArray(value.segments) ? value.segments.length : 0;
  return {
    text: transcript,
    completeness: 'complete',
    uncertainty: '转写只覆盖语音本身，音色、情绪与说话人身份均未核实',
    transcriptCoverage: 'complete',
    criticalUnclear: false,
    // Structural placeholder only: `interpretContextMedia` substitutes the canonical evidence built
    // from the platform binding and file hash. Nothing model-authored becomes evidence.
    evidenceRefs: [`transcript:${segments}`],
    generatedBy: 'voice-transcription',
  };
}

export function createVoiceMediaProvider(options: VoiceProviderOptions): BinaryMediaProvider {
  const apiKey = text(options?.apiKey);
  if (!apiKey) throw new Error('MISSING_MEDIA_API_KEY');
  const modelId = text(options.modelId);
  const promptVersion = text(options.promptVersion);
  const dataRegion = text(options.dataRegion);
  const retentionPolicy = text(options.retentionPolicy);
  if (!modelId || !promptVersion || !dataRegion || !retentionPolicy) throw new Error('VALIDATION_FAILED');
  let endpoint: URL;
  try { endpoint = new URL(text(options.endpoint)); }
  catch { throw new Error('INVALID_MEDIA_BASE_URL'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('INVALID_MEDIA_BASE_URL');
  const language = text(options.language);
  if (language && !/^[a-z]{2}$/.test(language)) throw new Error('VALIDATION_FAILED');
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 180_000) throw new Error('VALIDATION_FAILED');

  return {
    providerId: 'openai-compatible-transcription',
    modelId,
    modelVersion: text(options.modelVersion) || modelId,
    promptVersion,
    dataRegion,
    retentionPolicy,
    supportedMimeTypes: { image: [], voice: [...SUPPORTED_AUDIO_FORMATS] },
    async invoke({ mediaType, mimeType, bytes, signal }) {
      if (mediaType !== 'voice') throw new Error('UNSUPPORTED_CAPABILITY');
      if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_AUDIO_BYTES) throw new Error('MEDIA_UNCERTAIN');
      if (!SUPPORTED_AUDIO_FORMATS.includes(mimeType)) throw new Error('UNSUPPORTED_CAPABILITY');
      const form = new FormData();
      form.set('file', new Blob([Uint8Array.from(bytes)], { type: mimeType }), 'audio');
      form.set('model', modelId);
      form.set('response_format', 'json');
      if (language) form.set('language', language);
      const timer = new AbortController();
      const onAbort = (): void => timer.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const local = setTimeout(() => timer.abort(), timeoutMs);
      try {
        const response = await call(endpoint.toString(), {
          method: 'POST', signal: timer.signal, redirect: 'error', cache: 'no-store',
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
        });
        if (!response.ok) throw new DeepSeekHttpError(response.status, await providerErrorCode(response));
        const payload = await response.json() as { text?: unknown; transcript?: unknown; segments?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown } };
        const interpretation = normaliseTranscriptInterpretation(payload);
        const count = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
        return { interpretation, usage: {
          inputTokens: count(payload.usage?.input_tokens ?? payload.usage?.prompt_tokens),
          outputTokens: count(payload.usage?.output_tokens ?? payload.usage?.completion_tokens),
        } };
      } finally {
        clearTimeout(local);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
