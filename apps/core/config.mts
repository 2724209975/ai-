/** Production core-runtime configuration.
 *
 * The core process owns the owner API, the aggregation/collection worker and the internal skill
 * outbox pump. It never dispatches: platform sending stays with the per-account bridge, which is
 * the only process that holds 02's dispatch lease. Configuration therefore fails closed:
 *  - the HTTP surface binds loopback unless an operator explicitly widens it;
 *  - a non-loopback origin must be HTTPS;
 *  - the process starts paused unless an operator explicitly opts out;
 *  - the intelligence provider must be named, so nobody can assume a real model is wired in.
 */
import { isLogLevel, type LogLevel } from '../../packages/infrastructure/observability/logger.mts';
import { isPasswordHash } from '../../packages/infrastructure/auth/password.mts';
import { readDeepSeekEnv } from '../../packages/ai/generation/deepseek-env.mts';
import { readMediaEnv } from '../../packages/ai/understanding/media-env.mts';
import { readCoreImageDirectory } from './media-wiring.mts';

export const CORE_PLATFORMS = ['wechat', 'qq'] as const;
export type CorePlatform = (typeof CORE_PLATFORMS)[number];
export const SUPPORTED_INTELLIGENCE_PROVIDERS = ['persistent-fake', 'deepseek'] as const;
export type IntelligenceProvider = (typeof SUPPORTED_INTELLIGENCE_PROVIDERS)[number];

export type CoreConfig = {
  databaseUrl: string;
  ownerId: string;
  ownerPasswordHash: string;
  publicOrigin: string;
  platform: CorePlatform;
  host: string;
  port: number;
  secureCookies: boolean;
  sessionDir: string;
  buildDir: string;
  startPaused: boolean;
  collectionEnabled: boolean;
  aggregationWindowMs: number;
  maxAggregationMs: number;
  workerIntervalMs: number;
  skillOutboxIntervalMs: number;
  pgPoolMax: number;
  logLevel: LogLevel;
  intelligenceProvider: IntelligenceProvider;
  /** Safe to log; the API key is read at wiring time and never stored on the config. */
  deepSeekModelId: string | null;
  /** Explicitly enabled images require a private directory; runtime voice is unsupported. */
  mediaImageEnabled: boolean;
  mediaVoiceEnabled: boolean;
  mediaVisionModelId: string | null;
};

export type EnvLike = Record<string, string | undefined>;

function required(env: EnvLike, name: string): string {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`MISSING_ENV:${name}`);
  return value.trim();
}
function invalid(name: string): never { throw new Error(`INVALID_ENV:${name}`); }
function text(env: EnvLike, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : raw.trim();
}
function flag(env: EnvLike, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return invalid(name);
}
function integer(env: EnvLike, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) return invalid(name);
  return value;
}
/** Loopback means the process is reachable only from the machine itself; anything else is a choice. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value.startsWith('127.');
}

export function readCoreConfig(env: EnvLike): CoreConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  const ownerId = required(env, 'OWNER_ID');
  const ownerPasswordHash = required(env, 'OWNER_PASSWORD_HASH');
  if (!isPasswordHash(ownerPasswordHash)) throw invalid('OWNER_PASSWORD_HASH');
  const publicOrigin = required(env, 'PUBLIC_ORIGIN').replace(/\/+$/, '');
  const platformRaw = required(env, 'CORE_PLATFORM').toLowerCase();
  if (!CORE_PLATFORMS.includes(platformRaw as CorePlatform)) throw invalid('CORE_PLATFORM');
  const platform = platformRaw as CorePlatform;

  let origin: URL;
  try { origin = new URL(publicOrigin); } catch { throw invalid('PUBLIC_ORIGIN'); }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') throw invalid('PUBLIC_ORIGIN');
  if ((origin.pathname !== '/' && origin.pathname !== '') || origin.search || origin.hash) throw invalid('PUBLIC_ORIGIN');
  if (origin.protocol === 'http:' && !isLoopbackHost(origin.hostname)) throw new Error('INSECURE_ORIGIN');

  const host = text(env, 'HOST', '127.0.0.1');
  if (!isLoopbackHost(host) && !flag(env, 'ALLOW_NON_LOOPBACK_BIND', false)) throw new Error('NON_LOOPBACK_BIND_REFUSED');

  const intelligenceProvider = text(env, 'INTELLIGENCE_PROVIDER', 'persistent-fake').toLowerCase();
  if (!SUPPORTED_INTELLIGENCE_PROVIDERS.includes(intelligenceProvider as IntelligenceProvider)) throw new Error('UNSUPPORTED_INTELLIGENCE_PROVIDER');
  // Fail before the process starts rather than on the first inbound message.
  const deepSeekModelId = intelligenceProvider === 'deepseek' ? readDeepSeekEnv(env).modelId : null;
  // Fail fast on media switches, limits and the private directory before assembling providers.
  const media = readMediaEnv(env);
  readCoreImageDirectory(env);

  const logLevelRaw = text(env, 'LOG_LEVEL', 'info').toLowerCase();
  if (!isLogLevel(logLevelRaw)) throw invalid('LOG_LEVEL');

  const aggregationWindowMs = integer(env, 'AGGREGATION_WINDOW_MS', 0, 0, 600_000);
  const maxAggregationMs = integer(env, 'MAX_AGGREGATION_MS', 30_000, 1, 3_600_000);
  if (aggregationWindowMs > maxAggregationMs) throw invalid('AGGREGATION_WINDOW_MS');

  return {
    databaseUrl, ownerId, ownerPasswordHash, publicOrigin, platform, host,
    port: integer(env, 'PORT', 8787, 1, 65_535),
    secureCookies: flag(env, 'SECURE_COOKIES', origin.protocol === 'https:'),
    sessionDir: text(env, 'SESSION_DIR', '.local-sessions'),
    buildDir: text(env, 'WEB_BUILD_DIR', 'apps/web/build'),
    startPaused: flag(env, 'START_PAUSED', true),
    collectionEnabled: flag(env, 'COLLECTION_ENABLED', true),
    aggregationWindowMs, maxAggregationMs,
    workerIntervalMs: integer(env, 'WORKER_INTERVAL_MS', 2_000, 100, 600_000),
    skillOutboxIntervalMs: integer(env, 'SKILL_OUTBOX_INTERVAL_MS', 2_000, 100, 600_000),
    pgPoolMax: integer(env, 'PG_POOL_MAX', 8, 1, 100),
    logLevel: logLevelRaw,
    intelligenceProvider,
    deepSeekModelId,
    mediaImageEnabled: media.imageEnabled,
    mediaVoiceEnabled: media.voiceEnabled,
    mediaVisionModelId: media.imageEnabled ? media.visionModelId : null,
  };
}
