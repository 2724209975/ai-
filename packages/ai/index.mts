import type { CandidateGateway } from './generation/fake-provider.mts';
import { FakeCandidateGateway, proposeWithFallback, proposeWithGateway } from './generation/fake-provider.mts';
import { makeFakeDecision, validateScopedContext } from './strategy/fake-decision.mts';
import { checkFakeReply } from './checks/reply-check.mts';
import { analyzeFakeContact } from './analysis/draft-analysis.mts';
import { interpretFakeMedia } from './understanding/media.mts';
import { interpretWithFallback, interpretWithGateway } from './understanding/media-gateway.mts';
import { adaptDataContextProjection } from './understanding/context-adapter.mts';
import { prepareReplyForOrchestration } from './strategy/orchestration-handoff.mts';
import { createPersistentFakeIntelligence, createPgPersistentFakeIntelligence, createPgTextModelIntelligence, createTextModelIntelligence } from './strategy/persistent-fake.mts';
import { createTextCandidateGateway } from './generation/text-provider-contract.mts';
import { createDeepSeekTextProvider } from './generation/deepseek-provider.mts';
import { createDeepSeekFromEnv, describeDeepSeekEnv, readDeepSeekEnv } from './generation/deepseek-env.mts';
import type { PolicyProjection, ReplyDecision, ReplyPartProposal, ScopedContext } from './types.mts';

export type * from './types.mts';
export { FakeCandidateGateway, proposeWithFallback, proposeWithGateway, validateScopedContext, adaptDataContextProjection, prepareReplyForOrchestration, interpretWithGateway, interpretWithFallback, createPersistentFakeIntelligence, createPgPersistentFakeIntelligence, createTextModelIntelligence, createPgTextModelIntelligence, createTextCandidateGateway, createDeepSeekTextProvider, createDeepSeekFromEnv, readDeepSeekEnv, describeDeepSeekEnv };
export type { TextModelProvider, TextModelMeasurement } from './generation/text-provider-contract.mts';
export type { DeepSeekProviderOptions } from './generation/deepseek-provider.mts';
export type { DeepSeekEnv } from './generation/deepseek-env.mts';
export { DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_PROMPT_VERSION } from './generation/deepseek-provider.mts';
export type { MediaGateway } from './understanding/media-gateway.mts';
export { interpretContextMedia, prepareReplyWithMedia } from './understanding/media-provider.mts';
export type { BinaryMediaProvider, PrivateMediaReader, MediaUnderstandingOptions, MediaModelMeasurement } from './understanding/media-provider.mts';

export function createFakeIntelligencePort(gateway: CandidateGateway = new FakeCandidateGateway(), fallback: CandidateGateway | null = null) {
  return {
    interpretMedia: interpretFakeMedia,
    analyzeContact: ({ context, policy }: { context: ScopedContext; policy: PolicyProjection }) => analyzeFakeContact(context, policy),
    makeDecision: ({ context, policy }: { context: ScopedContext; policy: PolicyProjection }) => makeFakeDecision(context, policy),
    proposeReply: ({ context, policy, decision }: { context: ScopedContext; policy: PolicyProjection; decision: ReplyDecision }) => {
      const valid = validateScopedContext(context, policy);
      if (!valid.ok) return Promise.resolve(valid);
      return proposeWithFallback(context, decision, policy, gateway, fallback).then(result => {
        if (!result.ok) return result;
        for (const alternative of result.value.alternatives) {
          const check = checkFakeReply(context, policy, decision, alternative.parts);
          if (!check.ok) return check;
          if (check.value.status === 'blocked') return { ok: false as const, error: { code: 'MISSING_FACT' as const, message: '候选包含无依据事实或触及停止联系边界', retryable: false } };
        }
        return result;
      });
    },
    checkReply: ({ context, policy, decision, parts }: { context: ScopedContext; policy: PolicyProjection; decision: ReplyDecision; parts: ReplyPartProposal[] }) => checkFakeReply(context, policy, decision, parts),
  };
}
