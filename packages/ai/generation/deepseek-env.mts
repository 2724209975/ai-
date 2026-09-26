/** Reads only the DeepSeek provider's own variables, so both composition roots agree on them.
 *
 * The API key never leaves this object: it is not copied into a public config, not logged, and not
 * echoed in errors. Region and retention are operator declarations recorded with every measurement,
 * not promises from the provider.
 */
import { createDeepSeekTextProvider, DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_PROMPT_VERSION, type DeepSeekProviderOptions } from './deepseek-provider.mts';
import type { TextModelProvider } from './text-provider-contract.mts';

export type EnvLike = Record<string, string | undefined>;
export type DeepSeekEnv = {
  apiKey: string; modelId: string; modelVersion: string; baseUrl: string;
  dataRegion: string; retentionPolicy: string; timeoutMs: number; maxTokens: number; temperature: number;
  thinking: 'disabled' | 'enabled';
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

export function readDeepSeekEnv(env: EnvLike): DeepSeekEnv {
  const apiKey = normaliseKey(env.DEEPSEEK_API_KEY);
  if (!apiKey) throw new Error('MISSING_ENV:DEEPSEEK_API_KEY');
  const modelId = text(env, 'DEEPSEEK_MODEL', DEEPSEEK_DEFAULT_MODEL);
  return {
    apiKey, modelId,
    modelVersion: text(env, 'DEEPSEEK_MODEL_VERSION', modelId),
    baseUrl: text(env, 'DEEPSEEK_BASE_URL', DEEPSEEK_DEFAULT_BASE_URL),
    dataRegion: text(env, 'DEEPSEEK_DATA_REGION', 'CN'),
    // Honest default: nobody has verified the provider's retention terms for this project.
    retentionPolicy: text(env, 'DEEPSEEK_RETENTION_POLICY', 'provider-default-unverified'),
    timeoutMs: number(env, 'DEEPSEEK_TIMEOUT_MS', 30_000),
    maxTokens: number(env, 'DEEPSEEK_MAX_TOKENS', 2_000),
    temperature: number(env, 'DEEPSEEK_TEMPERATURE', 1),
    thinking: readThinking(env),
  };
}

/** Operators paste into a file by hand, so tolerate quotes and a repeated variable name. */
function normaliseKey(raw: string | undefined): string {
  let value = (raw ?? '').trim();
  for (let pass = 0; pass < 2; pass++) {
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1).trim();
    }
    if (/^DEEPSEEK_API_KEY=/i.test(value)) value = value.slice(value.indexOf('=') + 1).trim();
  }
  return value;
}

function readThinking(env: EnvLike): 'disabled' | 'enabled' {
  const value = text(env, 'DEEPSEEK_THINKING', 'disabled').toLowerCase();
  if (value !== 'disabled' && value !== 'enabled') throw new Error('INVALID_ENV:DEEPSEEK_THINKING');
  return value;
}

export function createDeepSeekFromEnv(env: EnvLike, overrides: Partial<DeepSeekProviderOptions> = {}): TextModelProvider {
  const config = readDeepSeekEnv(env);
  return createDeepSeekTextProvider({
    apiKey: config.apiKey, modelId: config.modelId, modelVersion: config.modelVersion,
    promptVersion: DEEPSEEK_PROMPT_VERSION, dataRegion: config.dataRegion, retentionPolicy: config.retentionPolicy,
    baseUrl: config.baseUrl, timeoutMs: config.timeoutMs, maxTokens: config.maxTokens, temperature: config.temperature,
    thinking: config.thinking,
    ...overrides,
  });
}

/** Safe to log: everything except the key. */
export function describeDeepSeekEnv(config: DeepSeekEnv): Record<string, string | number> {
  return { modelId: config.modelId, modelVersion: config.modelVersion, baseUrl: config.baseUrl,
    dataRegion: config.dataRegion, retentionPolicy: config.retentionPolicy, timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens, thinking: config.thinking };
}
