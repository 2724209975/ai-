/** Real image understanding behind 04's `BinaryMediaProvider` contract.
 *
 * Rows are narrow on purpose. It receives exactly one already-validated image (bytes, media type,
 * MIME type, abort signal) from `interpretContextMedia`, and returns an interpretation for the
 * gateway to re-validate. It never sees a contact, a message id, a file path, a policy or another
 * chat; it never decides whether a reply may be sent, and it never logs the key, the bytes or the
 * answer. Provider, region and retention are the owner's declarations, recorded per call.
 *
 * Facts pinned from the provider's own guide on 2026-10-03 (docs/reports/P4-3-proposal-2026-10-03.md):
 * JPEG/PNG/GIF/WebP are accepted and the format is decided from file content, not the declared MIME
 * type; inline base64 counts against a 48 MiB request body; images may only appear in `user`
 * messages; a scaled image costs at most 1024 tokens. A mismatch between the declared type and the
 * bytes is refused here rather than forwarded.
 */
import { createHash } from 'node:crypto';
import type { BinaryMediaProvider } from './media-provider.mts';
import { detectImageFormat, SUPPORTED_IMAGE_FORMATS } from './image-format.mts';
import { validateImageBytes } from '../../data/media/image-validation.mts';
import { DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DeepSeekHttpError, providerErrorCode } from '../generation/deepseek-provider.mts';

/** One prompt version per media kind, mirroring `generation/prompt-versions.mts`. Bump on any edit. */
export const IMAGE_UNDERSTANDING_PROMPT = 'media-image-understanding-1';
export const IMAGE_UNDERSTANDING_INSTRUCTION = [
  '请用中文如实描述这张图片里可以看到的内容，供本人判断是否回复对方。',
  '只输出一个 JSON 对象，不要输出解释、Markdown 或代码块围栏。',
  'JSON 结构：{"description":"...","uncertainty":"...","criticalUnclear":false}',
  '规则：',
  '1) description 只写图中确实可见的信息：场景、人物数量与可辨认的动作、明显文字、可辨认物体；不要推测人物关系、身份、意图或不在图里的信息；',
  '2) 有任何看不清、被遮挡、分辨率不足或无法确认的地方，把 criticalUnclear 设为 true 并在 uncertainty 里说明；',
  '3) 不要给出建议、结论或评价，不要复述这些规则。',
].join('\n');

export type ImageDetail = 'low' | 'high' | 'original' | 'auto';
export const VISION_DETAIL_LEVELS: readonly ImageDetail[] = ['low', 'high', 'original', 'auto'];

export type VisionProviderOptions = {
  apiKey: string;
  /** Omitted means the pinned multimodal default; recorded as both model id and version. */
  modelId?: string;
  modelVersion?: string;
  promptVersion: string;
  dataRegion: string;
  retentionPolicy: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  /** `original` keeps the whole image, which is what a "full_image" coverage claim needs. */
  detail?: ImageDetail;
  /** Inline base64 limit for one image; stays under the provider's 48 MiB request body. */
  maxInlineBytes?: number;
};

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_BYTES = 24 * 1024 * 1024;
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_CHARS = 16_384;
const MAX_UNCERTAINTY_CHARS = 2_048;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Strips a code fence or surrounding prose; models add them even when told not to. */
export function parseVisionJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* fall through to the brace slice */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('MODEL_UNAVAILABLE');
}

/** Normalises the model's answer into the shape 04's media gateway validates. */
export function normaliseImageInterpretation(raw: unknown, options: { detectedFormat: string; detail: ImageDetail; modelId: string }): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MODEL_UNAVAILABLE');
  const value = raw as Record<string, unknown>;
  const description = text(value.description ?? value.text ?? value.content);
  if (!description) throw new Error('MODEL_UNAVAILABLE');
  if (description.length > MAX_TEXT_CHARS) throw new Error('MODEL_UNAVAILABLE');
  const criticalUnclear = value.criticalUnclear === true;
  const declared = text(value.uncertainty).slice(0, MAX_UNCERTAINTY_CHARS);
  // A missing uncertainty is not a licence to claim certainty; it is recorded as undeclared.
  const uncertainty = declared || '模型未声明不确定性';
  return {
    text: description,
    completeness: 'complete',
    uncertainty,
    // An unclear image is still a full-image read; the gateway turns criticalUnclear into 转人工.
    visualCoverage: 'full_image',
    criticalUnclear,
    // Structural placeholder only: `interpretContextMedia` discards it and substitutes the canonical
    // evidence built from the platform binding and file hash. Nothing model-authored becomes evidence.
    evidenceRefs: [`image:${createHash('sha256').update(description).digest('hex').slice(0, 16)}`],
    generatedBy: `${options.modelId}/${options.detail}/${options.detectedFormat}`,
  };
}

export function createVisionMediaProvider(options: VisionProviderOptions): BinaryMediaProvider {
  const apiKey = text(options?.apiKey);
  if (!apiKey) throw new Error('MISSING_MEDIA_API_KEY');
  const modelId = text(options.modelId) || DEEPSEEK_DEFAULT_MODEL;
  const promptVersion = text(options.promptVersion);
  const dataRegion = text(options.dataRegion);
  const retentionPolicy = text(options.retentionPolicy);
  if (!promptVersion || !dataRegion || !retentionPolicy) throw new Error('VALIDATION_FAILED');
  const detail = options.detail ?? 'original';
  if (!VISION_DETAIL_LEVELS.includes(detail)) throw new Error('VALIDATION_FAILED');
  let endpoint: URL;
  try { endpoint = new URL('chat/completions', text(options.baseUrl) || DEEPSEEK_DEFAULT_BASE_URL); }
  catch { throw new Error('INVALID_MEDIA_BASE_URL'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('INVALID_MEDIA_BASE_URL');
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxTokens = options.maxTokens ?? 800;
  const temperature = options.temperature ?? 1;
  const maxInlineBytes = options.maxInlineBytes ?? MAX_INLINE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error('VALIDATION_FAILED');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 64 || maxTokens > 32_768) throw new Error('VALIDATION_FAILED');
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('VALIDATION_FAILED');
  if (!Number.isSafeInteger(maxInlineBytes) || maxInlineBytes < 1 || maxInlineBytes > MAX_INLINE_BYTES) throw new Error('VALIDATION_FAILED');

  return {
    providerId: 'deepseek-vision',
    modelId,
    modelVersion: text(options.modelVersion) || modelId,
    promptVersion,
    dataRegion,
    retentionPolicy,
    supportedMimeTypes: { image: [...SUPPORTED_IMAGE_FORMATS], voice: [] },
    async invoke({ mediaType, mimeType, bytes, signal }) {
      if (mediaType !== 'image') throw new Error('UNSUPPORTED_CAPABILITY');
      if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_MEDIA_BYTES) throw new Error('MEDIA_UNCERTAIN');
      // Validate and upload the same immutable byte snapshot, not caller-owned memory after await.
      bytes = Buffer.from(bytes);
      // The provider decides the format from content, so a wrong declaration is caught here.
      const detectedFormat = detectImageFormat(bytes);
      if (!detectedFormat || detectedFormat !== mimeType) throw new Error('MEDIA_UNCERTAIN');
      if (bytes.length > maxInlineBytes) throw new Error('VALIDATION_FAILED');
      const checked = await validateImageBytes(bytes, mimeType, { signal });
      if (!checked.ok || signal?.aborted) throw new Error('MEDIA_UNCERTAIN');
      const request = {
        model: modelId,
        messages: [{ role: 'user', content: [
          { type: 'text', text: IMAGE_UNDERSTANDING_INSTRUCTION },
          { type: 'image_url', image_url: { url: `data:${detectedFormat};base64,${Buffer.from(bytes).toString('base64')}`, detail } },
        ] }],
        temperature, max_tokens: maxTokens, response_format: { type: 'json_object' }, stream: false,
      };
      const body = JSON.stringify(request);
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error('VALIDATION_FAILED');
      const timer = new AbortController();
      const onAbort = (): void => timer.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const local = setTimeout(() => timer.abort(), timeoutMs);
      try {
        const response = await call(endpoint.toString(), {
          method: 'POST', signal: timer.signal, redirect: 'error', cache: 'no-store',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body,
        });
        if (!response.ok) throw new DeepSeekHttpError(response.status, await providerErrorCode(response));
        const payload = await response.json() as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('MODEL_UNAVAILABLE');
        const interpretation = normaliseImageInterpretation(parseVisionJson(content), { detectedFormat, detail, modelId });
        const count = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
        return { interpretation, usage: { inputTokens: count(payload.usage?.prompt_tokens), outputTokens: count(payload.usage?.completion_tokens) } };
      } finally {
        clearTimeout(local);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
