import type { CandidateGateway } from './fake-provider.mts';
import type { ReplyDecision, ScopedContext } from '../types.mts';

/** Provider selection, region and retention are D06 decisions, not defaults here. */
export interface TextModelProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly dataRegion: string;
  readonly retentionPolicy: string;
  invoke(input: { context: ScopedContext; decision: ReplyDecision; signal: AbortSignal }): Promise<{
    alternatives: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;
}

export type TextModelMeasurement = Readonly<{
  providerId: string; modelId: string; modelVersion: string; promptVersion: string;
  dataRegion: string; retentionPolicy: string; elapsedMs: number;
  outcome: 'ok' | 'error';
  inputTokens: number | null; outputTokens: number | null;
}>;

/** Bridges any later selected text provider into 04's checked candidate gateway. */
export function createTextCandidateGateway(provider: TextModelProvider, observe?: (measurement: TextModelMeasurement) => void): CandidateGateway {
  if (![provider.providerId, provider.modelId, provider.modelVersion, provider.promptVersion, provider.dataRegion, provider.retentionPolicy].every(v => typeof v === 'string' && !!v.trim())) {
    throw new Error('VALIDATION_FAILED');
  }
  return {
    version: `${provider.providerId}/${provider.modelId}@${provider.modelVersion}`,
    promptVersion: provider.promptVersion,
    async generate({ context, decision, signal }) {
      const started = performance.now();
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      let outcome: TextModelMeasurement['outcome'] = 'error';
      try {
        const result = await provider.invoke({ context, decision, signal });
        usage = result?.usage;
        outcome = 'ok';
        return result?.alternatives;
      } finally {
        const validCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
        try {
          observe?.({ providerId: provider.providerId, modelId: provider.modelId, modelVersion: provider.modelVersion,
            promptVersion: provider.promptVersion, dataRegion: provider.dataRegion, retentionPolicy: provider.retentionPolicy,
            elapsedMs: performance.now() - started, outcome,
            inputTokens: validCount(usage?.inputTokens) ? usage!.inputTokens! : null,
            outputTokens: validCount(usage?.outputTokens) ? usage!.outputTokens! : null });
        } catch {
          // Optional telemetry cannot turn a checked provider result into a model failure.
        }
      }
    },
  };
}
