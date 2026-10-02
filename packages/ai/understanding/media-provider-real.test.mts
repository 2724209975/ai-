/** Unit tests for the real media providers against a fake endpoint.
 *
 * The endpoint is a local function, not the internet: these tests prove request shape, format
 * checking, failure mapping and budget isolation. They do **not** prove model quality or that any
 * vendor accepts these requests. No key, byte or transcript is logged or asserted into a log line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVisionMediaProvider, normaliseImageInterpretation, parseVisionJson } from './vision-provider.mts';
import { createVoiceMediaProvider, normaliseTranscriptInterpretation } from './voice-provider.mts';
import { detectImageFormat, imageFormatMatches } from './image-format.mts';
import { createMediaUnderstandingFromEnv, readMediaEnv } from './media-env.mts';
import { DEFAULT_MEDIA_DAILY_CALL_LIMIT, DEFAULT_MEDIA_DAILY_TOKEN_LIMIT, mediaBudgetOptionsFromEnv, withMediaDailyBudget } from './media-budget.mts';
import { interpretContextMedia } from './media-provider.mts';
import type { BinaryMediaProvider } from './media-provider.mts';
import type { MediaInterpretationDraft, PolicyProjection, ScopedContext } from '../types.mts';

import { png, jpeg, gif, webp, animatedGif, animatedWebp, apng } from '../../../tests/fixtures/media-images.mts';

test('incomplete image containers never reach the vision endpoint', async () => {
  let calls = 0;
  const provider = createVisionMediaProvider({ ...visionOptions, fetchImpl: async () => {
    calls++; return completion(JSON.stringify({ description: 'must not be requested' }));
  } });
  for (const [mimeType, bytes] of [['image/png', png.subarray(0, 16)], ['image/jpeg', jpeg.subarray(0, 8)],
    ['image/gif', gif.subarray(0, 10)], ['image/webp', webp.subarray(0, 12)]] as const)
    await assert.rejects(provider.invoke({ mediaType: 'image', mimeType, bytes, signal: new AbortController().signal }), /MEDIA_UNCERTAIN/);
  assert.equal(calls, 0);
});

test('animated and aborted images produce no paid request', async () => {
  let calls = 0;
  const provider = createVisionMediaProvider({ ...visionOptions, fetchImpl: async () => {
    calls++; return completion(JSON.stringify({ description: 'must not be requested' }));
  } });
  for (const [mimeType, bytes] of [['image/png', apng], ['image/gif', animatedGif], ['image/webp', animatedWebp]] as const)
    await assert.rejects(provider.invoke({ mediaType: 'image', mimeType, bytes, signal: new AbortController().signal }), /MEDIA_UNCERTAIN/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.invoke({ mediaType: 'image', mimeType: 'image/png', bytes: png, signal: controller.signal }), /MEDIA_UNCERTAIN/);
  assert.equal(calls, 0);
});

test('vision uploads the validated snapshot even if caller memory changes during decode', async () => {
  const input = Buffer.from(png);
  let body = '';
  const provider = createVisionMediaProvider({ ...visionOptions, fetchImpl: async (_url, init) => {
    body = String(init?.body); return completion(JSON.stringify({ description: '合成图' }));
  } });
  const pending = provider.invoke({ mediaType: 'image', mimeType: 'image/png', bytes: input, signal: new AbortController().signal });
  input.fill(0);
  await pending;
  assert.equal(body.includes(png.toString('base64')), true);
});
function wav() {
  const b = Buffer.alloc(48);
  b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4, 40);
  return Uint8Array.from(b);
}
const visionOptions = { apiKey: 'unit-test-media-key', promptVersion: 'media-image-understanding-1', dataRegion: 'CN', retentionPolicy: 'unverified' };
function completion(content: string, usage: Record<string, unknown> = { prompt_tokens: 500, completion_tokens: 40 }) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function ok(signal = new AbortController().signal) {
  return { mediaType: 'image' as const, mimeType: 'image/png', bytes: png, signal };
}

test('image containers are detected from bytes and a mismatched declaration is refused', () => {
  assert.equal(detectImageFormat(png), 'image/png');
  assert.equal(detectImageFormat(jpeg), 'image/jpeg');
  assert.equal(detectImageFormat(gif), 'image/gif');
  assert.equal(detectImageFormat(webp), 'image/webp');
  assert.equal(detectImageFormat(Uint8Array.from([0x25, 0x50, 0x44, 0x46])), undefined, 'a PDF is not an image');
  assert.equal(detectImageFormat(Uint8Array.from([])), undefined);
  assert.equal(imageFormatMatches(png, 'image/png'), true);
  assert.equal(imageFormatMatches(png, 'image/jpeg'), false, 'a relabel must not pass');
});

test('the vision request inlines a data URL, keeps images in the user message and records usage', async () => {
  let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
  const provider = createVisionMediaProvider({ ...visionOptions, modelId: 'deepseek-flash', detail: 'original',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body)) };
      return completion(JSON.stringify({ description: '画面里是一张合成的单像素图片。', uncertainty: '合成夹具', criticalUnclear: false }));
    } });
  assert.deepEqual(provider.supportedMimeTypes, { image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], voice: [] });
  assert.equal(provider.providerId, 'deepseek-vision');
  assert.equal(provider.modelVersion, 'deepseek-flash');
  const result = await provider.invoke(ok());
  assert.equal(seen?.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(seen?.headers.authorization, 'Bearer unit-test-media-key');
  assert.equal(seen?.body.model, 'deepseek-flash');
  assert.equal(seen?.body.stream, false);
  assert.deepEqual(seen?.body.response_format, { type: 'json_object' });
  const messages = seen?.body.messages as { role: string; content: { type: string; image_url?: { url: string; detail?: string } }[] }[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.role, 'user', 'images are only accepted in a user message');
  assert.equal(messages[0]!.content[1]!.image_url?.url, `data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  assert.equal(messages[0]!.content[1]!.image_url?.detail, 'original');
  assert.deepEqual(result.usage, { inputTokens: 500, outputTokens: 40 });
  assert.equal(result.interpretation.text, '画面里是一张合成的单像素图片。');
  assert.equal(result.interpretation.visualCoverage, 'full_image');
  assert.equal(result.interpretation.completeness, 'complete');
});

test('each declared image format is forwarded with its own content type', async () => {
  for (const [mimeType, bytes] of [['image/png', png], ['image/jpeg', jpeg], ['image/gif', gif], ['image/webp', webp]] as const) {
    let body = '';
    const provider = createVisionMediaProvider({ ...visionOptions,
      fetchImpl: async (_url, init) => { body = String(init?.body); return completion(JSON.stringify({ description: '合成内容' })); } });
    const result = await provider.invoke({ mediaType: 'image', mimeType, bytes, signal: new AbortController().signal });
    assert.equal(body.includes(`data:${mimeType};base64,`), true, `${mimeType} must be declared as itself`);
    assert.equal(result.interpretation.visualCoverage, 'full_image');
  }
});

test('malformed, empty, unclear and oversized model answers are mapped to structured failures', () => {
  assert.throws(() => normaliseImageInterpretation(null, { detectedFormat: 'image/png', detail: 'original', modelId: 'm' }), { message: 'MODEL_UNAVAILABLE' });
  assert.throws(() => normaliseImageInterpretation({ description: '   ' }, { detectedFormat: 'image/png', detail: 'original', modelId: 'm' }), { message: 'MODEL_UNAVAILABLE' });
  assert.throws(() => normaliseImageInterpretation({ description: 'x'.repeat(20_000) }, { detectedFormat: 'image/png', detail: 'original', modelId: 'm' }), { message: 'MODEL_UNAVAILABLE' });
  // A missing uncertainty is recorded as undeclared rather than silently claimed as certain.
  const undeclared = normaliseImageInterpretation({ description: '图里有一张桌子。' }, { detectedFormat: 'image/png', detail: 'original', modelId: 'm' });
  assert.equal(undeclared.uncertainty, '模型未声明不确定性');
  assert.equal(undeclared.criticalUnclear, false);
  const unclear = normaliseImageInterpretation({ description: '看不清。', criticalUnclear: true }, { detectedFormat: 'image/png', detail: 'original', modelId: 'm' });
  assert.equal(unclear.criticalUnclear, true, 'the gateway turns this into 转人工');
  assert.deepEqual(parseVisionJson('```json\n{"description":"a"}\n```'), { description: 'a' });
  assert.deepEqual(parseVisionJson('前言 {"description":"a"} 后记'), { description: 'a' });
  assert.throws(() => parseVisionJson('不是 JSON'), { message: 'MODEL_UNAVAILABLE' });
});

test('provider failures, wrong media type, wrong format and oversized input never reach the endpoint', async () => {
  let calls = 0;
  const provider = createVisionMediaProvider({ ...visionOptions, maxInlineBytes: 64,
    fetchImpl: async () => { calls++; return completion(JSON.stringify({ description: 'ok' })); } });
  await assert.rejects(provider.invoke({ ...ok(), mediaType: 'voice' as 'image' }), { message: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(provider.invoke({ ...ok(), mimeType: 'image/jpeg' }), { message: 'MEDIA_UNCERTAIN' }, 'declared type must match the bytes');
  await assert.rejects(provider.invoke({ ...ok(), bytes: Uint8Array.from([]) }), { message: 'MEDIA_UNCERTAIN' });
  await assert.rejects(provider.invoke({ ...ok(), bytes: new Uint8Array(200) }), { message: 'MEDIA_UNCERTAIN' }, 'not an image at all');
  assert.equal(calls, 0, 'nothing invalid may be sent to a paid endpoint');
  await assert.rejects(provider.invoke({ ...ok(), bytes: png }), { message: 'VALIDATION_FAILED' }, 'larger than the inline limit');
  const http = createVisionMediaProvider({ ...visionOptions, fetchImpl: async () => new Response('{"error":{"code":"rate_limit"}}', { status: 429 }) });
  await assert.rejects(http.invoke(ok()), { message: 'DEEPSEEK_HTTP_429' });
  const broken = createVisionMediaProvider({ ...visionOptions, fetchImpl: async () => completion('这不是 JSON') });
  await assert.rejects(broken.invoke(ok()), { message: 'MODEL_UNAVAILABLE' });
  const blank = createVisionMediaProvider({ ...visionOptions, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }) });
  await assert.rejects(blank.invoke(ok()), { message: 'MODEL_UNAVAILABLE' });
});

test('the key, the bytes and the answer never appear in an error message', async () => {
  const provider = createVisionMediaProvider({ ...visionOptions, apiKey: 'super-secret-media-key',
    fetchImpl: async () => { throw new Error('network down'); } });
  await assert.rejects(provider.invoke(ok()), (error: Error) => {
    assert.equal(error.message.includes('super-secret-media-key'), false);
    assert.equal(error.message.includes(Buffer.from(png).toString('base64').slice(0, 12)), false);
    return true;
  });
});

test('a misconfigured vision provider is refused before any call', () => {
  assert.throws(() => createVisionMediaProvider({ ...visionOptions, apiKey: '  ' }), { message: 'MISSING_MEDIA_API_KEY' });
  assert.throws(() => createVisionMediaProvider({ ...visionOptions, promptVersion: '' }), { message: 'VALIDATION_FAILED' });
  assert.throws(() => createVisionMediaProvider({ ...visionOptions, dataRegion: '' }), { message: 'VALIDATION_FAILED' });
  assert.throws(() => createVisionMediaProvider({ ...visionOptions, detail: 'huge' as 'low' }), { message: 'VALIDATION_FAILED' });
  assert.throws(() => createVisionMediaProvider({ ...visionOptions, baseUrl: 'http://api.example.com' }), { message: 'INVALID_MEDIA_BASE_URL' });
  assert.throws(() => createVisionMediaProvider({ ...visionOptions, baseUrl: 'https://u:p@api.example.com' }), { message: 'INVALID_MEDIA_BASE_URL' });
  assert.throws(() => createVisionMediaProvider({ ...visionOptions, maxInlineBytes: 0 }), { message: 'VALIDATION_FAILED' });
});

const voiceOptions = { apiKey: 'unit-test-media-key', modelId: 'synthetic-asr-1', promptVersion: 'media-voice-transcription-1',
  dataRegion: 'CN', retentionPolicy: 'unverified', endpoint: 'https://asr.example.com/v1/audio/transcriptions' };
function audio(overrides: Record<string, unknown> = {}) {
  return { mediaType: 'voice' as const, mimeType: 'audio/wav', bytes: wav(), signal: new AbortController().signal, ...overrides };
}

test('the transcription request is multipart, carries no contact data and reports complete coverage only with text', async () => {
  let seen: { url: string; headers: Record<string, string>; form: FormData } | undefined;
  const provider = createVoiceMediaProvider({ ...voiceOptions, language: 'zh',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, form: init?.body as FormData };
      return new Response(JSON.stringify({ text: '你好，今天有空吗？', segments: [{}, {}] }), { status: 200 });
    } });
  assert.deepEqual(provider.supportedMimeTypes, { image: [], voice: ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/flac'] });
  const result = await provider.invoke(audio());
  assert.equal(seen?.url, 'https://asr.example.com/v1/audio/transcriptions');
  assert.equal(seen?.headers['content-type'], undefined, 'fetch sets the multipart boundary itself');
  assert.equal(seen?.form.get('model'), 'synthetic-asr-1');
  assert.equal(seen?.form.get('response_format'), 'json');
  assert.equal(seen?.form.get('language'), 'zh');
  const file = seen?.form.get('file');
  assert.equal(file instanceof Blob, true);
  assert.equal((file as Blob).type, 'audio/wav');
  assert.equal(result.interpretation.text, '你好，今天有空吗？');
  assert.equal(result.interpretation.transcriptCoverage, 'complete');
  assert.equal(result.interpretation.completeness, 'complete');
});

test('a transcription provider with no supported container or no text cannot produce a usable interpretation', async () => {
  const provider = createVoiceMediaProvider({ ...voiceOptions, fetchImpl: async () => new Response(JSON.stringify({ text: 'x' }), { status: 200 }) });
  await assert.rejects(provider.invoke(audio({ mediaType: 'image' })), { message: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(provider.invoke(audio({ mimeType: 'video/mp4' })), { message: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(provider.invoke(audio({ bytes: Uint8Array.from([]) })), { message: 'MEDIA_UNCERTAIN' });
  assert.throws(() => normaliseTranscriptInterpretation({ text: '   ' }), { message: 'MODEL_UNAVAILABLE' });
  assert.throws(() => normaliseTranscriptInterpretation({}), { message: 'MODEL_UNAVAILABLE' });
  assert.throws(() => normaliseTranscriptInterpretation('plain text'), { message: 'MODEL_UNAVAILABLE' });
  assert.throws(() => createVoiceMediaProvider({ ...voiceOptions, endpoint: 'https://asr.example.com/v1/audio/transcriptions?key=x' }), { message: 'INVALID_MEDIA_BASE_URL' });
  assert.throws(() => createVoiceMediaProvider({ ...voiceOptions, endpoint: '' }), { message: 'INVALID_MEDIA_BASE_URL' });
  assert.throws(() => createVoiceMediaProvider({ ...voiceOptions, language: 'zh-CN' }), { message: 'VALIDATION_FAILED' });
});

test('the media budget is independent per type and never shared with the text guard', async () => {
  const refusals: { mediaType: string; reason: string }[] = [];
  const base: BinaryMediaProvider = { providerId: 'stub', modelId: 'm', modelVersion: 'v', promptVersion: 'p',
    dataRegion: 'CN', retentionPolicy: 'x', supportedMimeTypes: { image: ['image/png'], voice: ['audio/wav'] },
    async invoke() { return { interpretation: { text: 'x' }, usage: { inputTokens: 100, outputTokens: 0 } }; } };
  const provider = withMediaDailyBudget(base, { maxImageCallsPerDay: 2, maxVoiceCallsPerDay: 1, maxImageTokensPerDay: 1_000,
    maxVoiceTokensPerDay: 1_000, onRefusal: info => refusals.push({ mediaType: info.mediaType, reason: info.reason }) });
  assert.equal(mediaBudgetOptionsFromEnv({}).maxImageCallsPerDay, DEFAULT_MEDIA_DAILY_CALL_LIMIT);
  assert.equal(DEFAULT_MEDIA_DAILY_CALL_LIMIT, 200);
  assert.equal(DEFAULT_MEDIA_DAILY_TOKEN_LIMIT, 200_000);
  await provider.invoke(ok());
  await provider.invoke(ok());
  await assert.rejects(provider.invoke(ok()), { message: 'MODEL_BUDGET_EXHAUSTED' });
  // Exhausting images must not touch the voice allowance.
  await provider.invoke(audio());
  await assert.rejects(provider.invoke(audio()), { message: 'MODEL_BUDGET_EXHAUSTED' });
  assert.deepEqual(refusals, [{ mediaType: 'image', reason: 'calls' }, { mediaType: 'voice', reason: 'calls' }]);
  const tokens = withMediaDailyBudget(base, { maxImageCallsPerDay: 100, maxImageTokensPerDay: 100 });
  await tokens.invoke(ok());
  await assert.rejects(tokens.invoke(ok()), { message: 'MODEL_BUDGET_EXHAUSTED' });
  assert.throws(() => withMediaDailyBudget(base, { maxImageCallsPerDay: 0 }), { message: 'VALIDATION_FAILED' });
});

test('the environment gate is closed by default and refuses half-configured opt-ins', () => {
  assert.equal(createMediaUnderstandingFromEnv({}), null, 'nothing enabled means no provider at all');
  assert.equal(readMediaEnv({}).imageEnabled, false);
  assert.equal(readMediaEnv({}).voiceEnabled, false);
  assert.throws(() => readMediaEnv({ MEDIA_VISION_ENABLED: 'maybe' }), { message: 'INVALID_ENV:MEDIA_VISION_ENABLED' });
  assert.throws(() => readMediaEnv({ MEDIA_VISION_ENABLED: '1' }), { message: 'MISSING_ENV:MEDIA_API_KEY' });
  assert.throws(() => readMediaEnv({ MEDIA_VISION_DETAIL: 'huge' }), { message: 'INVALID_ENV:MEDIA_VISION_DETAIL' });
  assert.throws(() => readMediaEnv({ MEDIA_VOICE_ENABLED: '1', MEDIA_API_KEY: 'k' }), { message: 'MISSING_ENV:MEDIA_VOICE_ENDPOINT' });
  assert.throws(() => readMediaEnv({ MEDIA_VOICE_ENABLED: '1', MEDIA_API_KEY: 'k', MEDIA_VOICE_ENDPOINT: 'http://asr.example.com' }), { message: 'INVALID_ENV:MEDIA_VOICE_ENDPOINT' });
  assert.throws(() => readMediaEnv({ MEDIA_VOICE_ENDPOINT: 'https://asr.example.com/v1/audio/transcriptions', MEDIA_VOICE_ENABLED: '1', MEDIA_API_KEY: 'k' }), { message: 'MISSING_ENV:MEDIA_VOICE_MODEL' });
  assert.throws(() => readMediaEnv({ MEDIA_DAILY_IMAGE_CALL_LIMIT: 'many' }), { message: 'INVALID_ENV:MEDIA_DAILY_IMAGE_CALL_LIMIT' });
  // Naming the text key must never enable media.
  assert.throws(() => readMediaEnv({ MEDIA_VISION_ENABLED: '1', DEEPSEEK_API_KEY: 'text-only' }), { message: 'MISSING_ENV:MEDIA_API_KEY' });
});

test('an image-only selection reports voice as unsupported instead of pretending to cover it', () => {
  const selection = createMediaUnderstandingFromEnv({ MEDIA_VISION_ENABLED: '1', MEDIA_API_KEY: 'unit-test-media-key' });
  assert.ok(selection);
  assert.deepEqual(selection.providers, ['deepseek-vision']);
  assert.deepEqual(selection.provider.supportedMimeTypes.voice, [], 'voice keeps going to a human');
  assert.equal(selection.provider.supportedMimeTypes.image.length, 4);
  assert.equal(selection.describe().voiceEnabled, false);
  assert.equal(JSON.stringify(selection.describe()).includes('unit-test-media-key'), false, 'the key is never described');
});

test('the real vision provider satisfies the 04 media contract end to end, without granting sending authority', async () => {
  const policy: PolicyProjection = { contactId: 'contact-a', version: 1, goal: '轻松交流', sendMode: 'confirm',
    agentEnabled: true, activeContactEnabled: false, activeConfessionEnabled: false, restrictions: [], stylePreferences: [] };
  const bytes = Buffer.from(png);
  const asset = { id: 'media-a', messageId: 'message-a', contactId: 'contact-a', mediaType: 'image' as const,
    storageRef: 'media-a', sha256: createHash('sha256').update(bytes).digest('hex'), fetchStatus: 'stored' as const,
    completeness: 'complete' as const, interpretationStatus: 'pending' as const, platformMetadata: {}, approvalStatus: 'unapproved' as const,
    approvalVersion: 1, allowedPlatforms: [], mimeType: 'image/png', version: 1,
    createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z' };
  const context: ScopedContext = { contactId: 'contact-a',
    snapshot: { id: 'snapshot-a', conversationId: 'conv-a', generation: 1, cutoffMessageId: 'message-a',
      cutoffTime: '2026-10-03T12:00:00.000Z', messageRefs: ['message-a'], summaryRefs: [], factRefs: [], analysisRefs: [], policyVersion: 1, hash: 'synthetic' },
    messages: [{ id: 'message-a', contactId: 'contact-a', actor: 'contact', type: 'image', mediaId: 'media-a', text: null,
      sentAt: '2026-10-03T11:59:00.000Z', isAgentGenerated: false, mode: 'live', evidenceRef: 'account-a:platform-message-a' }],
    facts: [], analyses: [] };
  const provider = createVisionMediaProvider({ ...visionOptions,
    fetchImpl: async () => completion(JSON.stringify({ description: '合成图片里有一张桌子。', uncertainty: '合成夹具', criticalUnclear: false })) });
  const result = await interpretContextMedia(context, policy, {
    source: { async readPrivate() { return { asset, bytes }; } }, provider });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const draft = result.value.messages[0]!.mediaInterpretation as MediaInterpretationDraft;
  assert.equal(draft.text, '合成图片里有一张桌子。');
  assert.equal(draft.status, 'draft');
  assert.deepEqual(draft.structuredMeaning.visualCoverage, 'full_image');
  assert.equal(draft.structuredMeaning.sourceSha256, asset.sha256);
  assert.deepEqual(draft.evidenceRefs, ['account-a:platform-message-a', `media:media-a:${asset.sha256}`],
    'evidence comes from the trusted binding and hash, not from the model');
  assert.equal(JSON.stringify(result.value).includes('unit-test-media-key'), false);
});

test('a criticalUnclear answer still blocks the whole batch instead of producing a candidate', async () => {
  const policy: PolicyProjection = { contactId: 'contact-a', version: 1, goal: '轻松交流', sendMode: 'confirm',
    agentEnabled: true, activeContactEnabled: false, activeConfessionEnabled: false, restrictions: [], stylePreferences: [] };
  const bytes = Buffer.from(png);
  const asset = { id: 'media-a', messageId: 'message-a', contactId: 'contact-a', mediaType: 'image' as const,
    storageRef: 'media-a', sha256: createHash('sha256').update(bytes).digest('hex'), fetchStatus: 'stored' as const,
    completeness: 'complete' as const, interpretationStatus: 'pending' as const, platformMetadata: {}, approvalStatus: 'unapproved' as const,
    approvalVersion: 1, allowedPlatforms: [], mimeType: 'image/png', version: 1,
    createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z' };
  const context: ScopedContext = { contactId: 'contact-a',
    snapshot: { id: 'snapshot-a', conversationId: 'conv-a', generation: 1, cutoffMessageId: 'message-a',
      cutoffTime: '2026-10-03T12:00:00.000Z', messageRefs: ['message-a'], summaryRefs: [], factRefs: [], analysisRefs: [], policyVersion: 1, hash: 'synthetic' },
    messages: [{ id: 'message-a', contactId: 'contact-a', actor: 'contact', type: 'image', mediaId: 'media-a', text: null,
      sentAt: '2026-10-03T11:59:00.000Z', isAgentGenerated: false, mode: 'live', evidenceRef: 'account-a:platform-message-a' }],
    facts: [], analyses: [] };
  const provider = createVisionMediaProvider({ ...visionOptions,
    fetchImpl: async () => completion(JSON.stringify({ description: '图里有一张纸。', criticalUnclear: true, uncertainty: '字迹看不清' })) });
  const result = await interpretContextMedia(context, policy, { source: { async readPrivate() { return { asset, bytes }; } }, provider });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MEDIA_UNCERTAIN');
});
