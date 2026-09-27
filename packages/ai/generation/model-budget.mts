/** A runaway guard for a paid model, not an accounting system.
 *
 * It counts attempted calls and reported tokens per UTC day inside one process and refuses to call the provider once a
 * limit is reached; 04's gateway turns that refusal into MODEL_UNAVAILABLE, which 02 handles by
 * pausing the contact for a human — never by silently continuing to spend. Restarting the process
 * resets the counters, so this bounds a loop; it does not bound a month, and it must not be
 * presented as a billing control.
 */
import type { TextModelMeasurement, TextModelProvider } from './text-provider-contract.mts';

export type ModelBudgetOptions = {
  maxCallsPerDay?: number;
  maxTokensPerDay?: number;
  now?: () => number;
  onRefusal?(info: { reason: 'calls' | 'tokens'; calls: number; tokens: number }): void;
};

export const DEFAULT_DAILY_CALL_LIMIT = 300;
export const DEFAULT_DAILY_TOKEN_LIMIT = 500_000;

export function withDailyBudget(provider: TextModelProvider, options: ModelBudgetOptions = {}): TextModelProvider {
  const maxCalls = options.maxCallsPerDay ?? DEFAULT_DAILY_CALL_LIMIT;
  const maxTokens = options.maxTokensPerDay ?? DEFAULT_DAILY_TOKEN_LIMIT;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new Error('VALIDATION_FAILED');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('VALIDATION_FAILED');
  let day = '';
  let calls = 0;
  let tokens = 0;
  // Usage arrives after the request. Serialize admissions so a burst cannot all pass the same
  // pre-call check; this also keeps a late response from being charged to the next UTC day.
  let tail: Promise<void> = Promise.resolve();

  const rollover = (): void => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) { day = today; calls = 0; tokens = 0; }
  };

  return {
    providerId: provider.providerId, modelId: provider.modelId, modelVersion: provider.modelVersion,
    promptVersion: provider.promptVersion, dataRegion: provider.dataRegion, retentionPolicy: provider.retentionPolicy,
    async invoke(input) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        rollover();
        if (calls >= maxCalls) { options.onRefusal?.({ reason: 'calls', calls, tokens }); throw new Error('MODEL_BUDGET_EXHAUSTED'); }
        if (tokens >= maxTokens) { options.onRefusal?.({ reason: 'tokens', calls, tokens }); throw new Error('MODEL_BUDGET_EXHAUSTED'); }
        calls += 1; // Even a timeout or provider error is a paid attempt until proved otherwise.
        const result = await provider.invoke(input);
        tokens += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
        return result;
      } finally { release(); }
    },
  };
}

/** Same guard, driven by the operator's numbers; absent values fall back to the documented defaults. */
export function budgetOptionsFromEnv(env: Record<string, string | undefined>, onRefusal?: ModelBudgetOptions['onRefusal']): ModelBudgetOptions {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw.trim());
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`INVALID_ENV:${name}`);
    return value;
  };
  return {
    maxCallsPerDay: read('DEEPSEEK_DAILY_CALL_LIMIT', DEFAULT_DAILY_CALL_LIMIT),
    maxTokensPerDay: read('DEEPSEEK_DAILY_TOKEN_LIMIT', DEFAULT_DAILY_TOKEN_LIMIT),
    onRefusal,
  };
}

export type { TextModelMeasurement };
