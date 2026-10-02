/** Independent runaway guard for paid media calls.
 *
 * The text guard in `generation/model-budget.mts` bounds one text provider. Media is a separate
 * paid surface with its own prompt and price, and an image loop must not be able to spend the text
 * allowance (or the reverse), so this guard keeps a counter set per media type. Like the text
 * guard it counts attempted calls and reported tokens per UTC day inside one process and resets on
 * restart: it bounds a loop, it is not a monthly budget and must never be presented as a billing
 * control. D06 is still undecided, so the defaults below are the conservative values the owner
 * confirmed on 2026-10-03, not a cost plan.
 */
import type { BinaryMediaProvider, UnderstoodMediaType } from './media-provider.mts';

export type MediaRefusal = Readonly<{ reason: 'calls' | 'tokens'; mediaType: UnderstoodMediaType; calls: number; tokens: number }>;
export type MediaBudgetOptions = {
  maxImageCallsPerDay?: number;
  maxImageTokensPerDay?: number;
  maxVoiceCallsPerDay?: number;
  maxVoiceTokensPerDay?: number;
  now?: () => number;
  onRefusal?(info: MediaRefusal): void;
};

export const DEFAULT_MEDIA_DAILY_CALL_LIMIT = 200;
export const DEFAULT_MEDIA_DAILY_TOKEN_LIMIT = 200_000;

type Counters = { day: string; calls: number; tokens: number };

/** Wraps one media provider. Identity fields and the declared codec support pass through unchanged. */
export function withMediaDailyBudget(provider: BinaryMediaProvider, options: MediaBudgetOptions = {}): BinaryMediaProvider {
  const limits: Record<UnderstoodMediaType, { calls: number; tokens: number }> = {
    image: { calls: options.maxImageCallsPerDay ?? DEFAULT_MEDIA_DAILY_CALL_LIMIT,
      tokens: options.maxImageTokensPerDay ?? DEFAULT_MEDIA_DAILY_TOKEN_LIMIT },
    voice: { calls: options.maxVoiceCallsPerDay ?? DEFAULT_MEDIA_DAILY_CALL_LIMIT,
      tokens: options.maxVoiceTokensPerDay ?? DEFAULT_MEDIA_DAILY_TOKEN_LIMIT },
  };
  for (const limit of Object.values(limits)) {
    if (!Number.isSafeInteger(limit.calls) || limit.calls < 1) throw new Error('VALIDATION_FAILED');
    if (!Number.isSafeInteger(limit.tokens) || limit.tokens < 1) throw new Error('VALIDATION_FAILED');
  }
  const now = options.now ?? Date.now;
  const counters: Record<UnderstoodMediaType, Counters> = {
    image: { day: '', calls: 0, tokens: 0 },
    voice: { day: '', calls: 0, tokens: 0 },
  };
  const rollover = (counter: Counters): void => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== counter.day) { counter.day = today; counter.calls = 0; counter.tokens = 0; }
  };
  // Usage arrives after the response, so admissions are serialized per provider: a burst cannot all
  // pass the same pre-call check, and a late response is charged to the day it was admitted.
  let tail: Promise<void> = Promise.resolve();

  return {
    providerId: provider.providerId, modelId: provider.modelId, modelVersion: provider.modelVersion,
    promptVersion: provider.promptVersion, dataRegion: provider.dataRegion, retentionPolicy: provider.retentionPolicy,
    supportedMimeTypes: { image: [...provider.supportedMimeTypes.image], voice: [...provider.supportedMimeTypes.voice] },
    async invoke(input) {
      const mediaType = input?.mediaType;
      const limit = limits[mediaType as UnderstoodMediaType];
      const counter = counters[mediaType as UnderstoodMediaType];
      if (!limit || !counter) return await provider.invoke(input);
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        rollover(counter);
        const refusal = (reason: MediaRefusal['reason']): never => {
          try { options.onRefusal?.({ reason, mediaType, calls: counter.calls, tokens: counter.tokens }); }
          catch { /* Optional telemetry cannot change the guard's decision. */ }
          throw new Error('MODEL_BUDGET_EXHAUSTED');
        };
        if (counter.calls >= limit.calls) refusal('calls');
        if (counter.tokens >= limit.tokens) refusal('tokens');
        counter.calls += 1; // A timeout or provider error is still a paid attempt until proved otherwise.
        const result = await provider.invoke(input);
        counter.tokens += (result?.usage?.inputTokens ?? 0) + (result?.usage?.outputTokens ?? 0);
        return result;
      } finally { release(); }
    },
  };
}

/** Operator numbers; absent values fall back to the confirmed defaults. */
export function mediaBudgetOptionsFromEnv(env: Record<string, string | undefined>, onRefusal?: MediaBudgetOptions['onRefusal']): MediaBudgetOptions {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw.trim());
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`INVALID_ENV:${name}`);
    return value;
  };
  return {
    maxImageCallsPerDay: read('MEDIA_DAILY_IMAGE_CALL_LIMIT', DEFAULT_MEDIA_DAILY_CALL_LIMIT),
    maxImageTokensPerDay: read('MEDIA_DAILY_IMAGE_TOKEN_LIMIT', DEFAULT_MEDIA_DAILY_TOKEN_LIMIT),
    maxVoiceCallsPerDay: read('MEDIA_DAILY_VOICE_CALL_LIMIT', DEFAULT_MEDIA_DAILY_CALL_LIMIT),
    maxVoiceTokensPerDay: read('MEDIA_DAILY_VOICE_TOKEN_LIMIT', DEFAULT_MEDIA_DAILY_TOKEN_LIMIT),
    onRefusal,
  };
}
