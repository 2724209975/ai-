/** Composition for the real media providers: explicit opt-in, named key, independent budget.
 *
 * Nothing here is enabled by default and nothing falls back to the text model's key: enabling a
 * media type requires its own switch, and the key must be supplied explicitly. That is deliberate —
 * a media call is a separate paid request that sends a contact's image or voice to a model, so it
 * must be an operator decision rather than a side effect of the text configuration. Region and
 * retention are recorded declarations, not vendor promises.
 */
import { mediaBudgetOptionsFromEnv, withMediaDailyBudget, type MediaBudgetOptions } from './media-budget.mts';
import { createVisionMediaProvider, IMAGE_UNDERSTANDING_PROMPT, VISION_DETAIL_LEVELS, type ImageDetail } from './vision-provider.mts';
import { createVoiceMediaProvider, VOICE_TRANSCRIPTION_PROMPT } from './voice-provider.mts';
import type { BinaryMediaProvider } from './media-provider.mts';
import {unifiedMoneyFromEnv} from '../generation/unified-budget.mts';

export type EnvLike = Record<string, string | undefined>;
export type MediaEnv = {
  imageEnabled: boolean;
  voiceEnabled: boolean;
  visionModelId: string;
  visionModelVersion: string;
  voiceModelId: string;
  voiceModelVersion: string;
  voiceEndpoint: string | null;
  language: string | null;
  detail: ImageDetail;
  baseUrl: string;
  dataRegion: string;
  retentionPolicy: string;
  timeoutMs: number;
  voiceTimeoutMs: number;
  maxTokens: number;
  temperature: number;
  budget: MediaBudgetOptions;
};

function text(env: EnvLike, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}
function number(env: EnvLike, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) throw new Error(`INVALID_ENV:${name}`);
  return value;
}
function flag(env: EnvLike, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return (() => { throw new Error(`INVALID_ENV:${name}`); })();
}
/** Operators paste into a file by hand, so tolerate quotes and a repeated variable name. */
function normaliseKey(raw: string | undefined): string {
  let value = (raw ?? '').trim();
  for (let pass = 0; pass < 2; pass++) {
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1).trim();
    }
    if (/^MEDIA_(?:VISION_|VOICE_)?API_KEY=/i.test(value)) value = value.slice(value.indexOf('=') + 1).trim();
  }
  return value;
}

/** Fails on malformed or half-configured values even when a type is disabled, so mistakes surface
 *  at startup instead of at the first inbound image. */
export function readMediaEnv(env: EnvLike): MediaEnv {
  const imageEnabled = flag(env, 'MEDIA_VISION_ENABLED', false);
  const voiceEnabled = flag(env, 'MEDIA_VOICE_ENABLED', false);
  const detail = text(env, 'MEDIA_VISION_DETAIL', 'original') as ImageDetail;
  if (!VISION_DETAIL_LEVELS.includes(detail)) throw new Error('INVALID_ENV:MEDIA_VISION_DETAIL');
  const voiceEndpoint = text(env, 'MEDIA_VOICE_ENDPOINT', '');
  if (voiceEndpoint) {
    let parsed: URL;
    try { parsed = new URL(voiceEndpoint); } catch { throw new Error('INVALID_ENV:MEDIA_VOICE_ENDPOINT'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('INVALID_ENV:MEDIA_VOICE_ENDPOINT');
  }
  const language = text(env, 'MEDIA_VOICE_LANGUAGE', '').toLowerCase();
  if (language && !/^[a-z]{2}$/.test(language)) throw new Error('INVALID_ENV:MEDIA_VOICE_LANGUAGE');
  const visionModelId = text(env, 'MEDIA_VISION_MODEL', 'deepseek-flash');
  const voiceModelId = text(env, 'MEDIA_VOICE_MODEL', '');
  if (imageEnabled && !normaliseKey(env.MEDIA_VISION_API_KEY ?? env.MEDIA_API_KEY)) throw new Error('MISSING_ENV:MEDIA_API_KEY');
  if (voiceEnabled) {
    if (!voiceEndpoint) throw new Error('MISSING_ENV:MEDIA_VOICE_ENDPOINT');
    if (!voiceModelId) throw new Error('MISSING_ENV:MEDIA_VOICE_MODEL');
    if (!normaliseKey(env.MEDIA_VOICE_API_KEY ?? env.MEDIA_API_KEY)) throw new Error('MISSING_ENV:MEDIA_API_KEY');
  }
  const shared = {
    imageEnabled, voiceEnabled, visionModelId,
    visionModelVersion: text(env, 'MEDIA_VISION_MODEL_VERSION', visionModelId),
    voiceModelId, voiceModelVersion: text(env, 'MEDIA_VOICE_MODEL_VERSION', voiceModelId || 'unset'),
    voiceEndpoint: voiceEndpoint || null, language: language || null, detail,
    baseUrl: text(env, 'MEDIA_BASE_URL', 'https://api.deepseek.com'),
    dataRegion: text(env, 'MEDIA_DATA_REGION', 'CN'),
    retentionPolicy: text(env, 'MEDIA_RETENTION_POLICY', 'provider-default-unverified'),
  };
  // Limits are validated even when a type is disabled, so a typo cannot hide until it is switched on.
  const budget = mediaBudgetOptionsFromEnv(env);
  return { ...shared, timeoutMs: number(env, 'MEDIA_TIMEOUT_MS', 30_000), voiceTimeoutMs: number(env, 'MEDIA_VOICE_TIMEOUT_MS', 60_000),
    maxTokens: number(env, 'MEDIA_MAX_TOKENS', 800), temperature: number(env, 'MEDIA_TEMPERATURE', 1), budget };
}

export type MediaProviderSelection = Readonly<{
  provider: BinaryMediaProvider;
  providers: readonly string[];
  budget: MediaBudgetOptions;
  /** Safe to log: no key, no endpoint query, no contact data. */
  describe(): Record<string, string | number | boolean | null>;
}>;

/**
 * Builds one media provider covering the enabled types, wrapped in the media-only daily budget.
 * Returns `null` when nothing is enabled, so a composition root cannot mistake "off" for "ready".
 */
export function createMediaUnderstandingFromEnv(env: EnvLike, overrides: Partial<{ budget: MediaBudgetOptions;
  onRefusal: MediaBudgetOptions['onRefusal'] }> = {}): MediaProviderSelection | null {
  const config = readMediaEnv(env);
  if (!config.imageEnabled && !config.voiceEnabled) return null;
  const key = normaliseKey(env.MEDIA_API_KEY);
  const visionKey = normaliseKey(env.MEDIA_VISION_API_KEY) || key;
  const voiceKey = normaliseKey(env.MEDIA_VOICE_API_KEY) || key;
  const providers: BinaryMediaProvider[] = [];
  if (config.imageEnabled) providers.push(createVisionMediaProvider({
    apiKey: visionKey, modelId: config.visionModelId, modelVersion: config.visionModelVersion,
    promptVersion: IMAGE_UNDERSTANDING_PROMPT, dataRegion: config.dataRegion, retentionPolicy: config.retentionPolicy,
    baseUrl: config.baseUrl, timeoutMs: config.timeoutMs, maxTokens: config.maxTokens, temperature: config.temperature, detail: config.detail,
  }));
  if (config.voiceEnabled && config.voiceEndpoint) providers.push(createVoiceMediaProvider({
    apiKey: voiceKey, modelId: config.voiceModelId, modelVersion: config.voiceModelVersion,
    promptVersion: VOICE_TRANSCRIPTION_PROMPT, dataRegion: config.dataRegion, retentionPolicy: config.retentionPolicy,
    endpoint: config.voiceEndpoint, timeoutMs: config.voiceTimeoutMs, ...(config.language ? { language: config.language } : {}),
  }));
  if (!providers.length) return null;
  const money=unifiedMoneyFromEnv(env);
  const combined: BinaryMediaProvider = {
    // Named per enabled type so a log line never implies a single provider covers both.
    providerId: providers.map(p => p.providerId).join('+'),
    modelId: providers.map(p => p.modelId).join('+'),
    modelVersion: providers.map(p => p.modelVersion).join('+'),
    promptVersion: providers.map(p => p.promptVersion).join('+'),
    dataRegion: config.dataRegion, retentionPolicy: config.retentionPolicy,
    supportedMimeTypes: { image: providers.flatMap(p => [...p.supportedMimeTypes.image]),
      voice: providers.flatMap(p => [...p.supportedMimeTypes.voice]) },
    async invoke(input) {
      const target = providers.find(p => p.supportedMimeTypes[input.mediaType].includes(input.mimeType));
      if (!target) throw new Error('UNSUPPORTED_CAPABILITY');
      if(money){const prefix=input.mediaType==='image'?'MEDIA_VISION':'MEDIA_VOICE';await money.reserve(input.mediaType,target.modelId,input.mediaType==='image'?65536+4096:input.bytes.byteLength+4096,config.maxTokens,{inputPerMillion:Number(env[prefix+'_INPUT_CNY_PER_MILLION']),outputPerMillion:Number(env[prefix+'_OUTPUT_CNY_PER_MILLION'])});}
      return await target.invoke(input);
    },
  };
  const budget: MediaBudgetOptions = { ...mediaBudgetOptionsFromEnv(env, overrides.onRefusal), ...overrides.budget };
  return {
    provider: withMediaDailyBudget(combined, budget),
    providers: providers.map(p => p.providerId),
    budget,
    describe: () => ({ imageEnabled: config.imageEnabled, voiceEnabled: config.voiceEnabled,
      visionModelId: config.imageEnabled ? config.visionModelId : 'n/a', voiceModelId: config.voiceEnabled ? config.voiceModelId : 'n/a',
      detail: config.detail, dataRegion: config.dataRegion, retentionPolicy: config.retentionPolicy,
      maxImageCallsPerDay: budget.maxImageCallsPerDay ?? null, maxVoiceCallsPerDay: budget.maxVoiceCallsPerDay ?? null }),
  };
}
