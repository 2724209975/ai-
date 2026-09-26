/** One-call DeepSeek probe with a synthetic context: verifies the key, the request shape and the
 * answer format, and prints latency plus token counts so the first real cost figure is measured
 * rather than guessed. It never sends real chat content and never prints the key.
 *
 * Usage: set DEEPSEEK_API_KEY and DEEPSEEK_SMOKE=1, then run this file.
 */
import { createDeepSeekFromEnv, describeDeepSeekEnv, readDeepSeekEnv } from '../packages/ai/index.mts';
import { DeepSeekHttpError } from '../packages/ai/generation/deepseek-provider.mts';
import type { PolicyProjection, ReplyDecision, ScopedContext } from '../packages/ai/types.mts';

if (process.env.DEEPSEEK_SMOKE !== '1') throw new Error('SMOKE_DISABLED: set DEEPSEEK_SMOKE=1 to spend one call');

const policy: PolicyProjection = { contactId: 'smoke-contact', version: 1, goal: '保持轻松暧昧', sendMode: 'confirm',
  agentEnabled: true, activeContactEnabled: false, activeConfessionEnabled: false,
  restrictions: ['不提钱', '不约见面时间'], stylePreferences: ['简短', '像日常聊天'] };
const context: ScopedContext = {
  contactId: 'smoke-contact',
  snapshot: { id: 'smoke-snapshot', conversationId: 'smoke-conversation', generation: 1, cutoffMessageId: null,
    cutoffTime: new Date().toISOString(), messageRefs: [], summaryRefs: [], factRefs: [], analysisRefs: [], policyVersion: 1, hash: 'smoke' },
  messages: [
    { id: 'smoke-m1', contactId: 'smoke-contact', actor: 'contact', type: 'text', text: '今天好累啊，刚下班',
      sentAt: new Date().toISOString(), isAgentGenerated: false, mode: 'live', evidenceRef: 'smoke' },
  ],
  facts: [], analyses: [],
};
const decision: ReplyDecision = {
  conversationId: 'smoke-conversation', contextSnapshotId: 'smoke-snapshot', shouldReply: true, timing: 'now',
  strategy: { summary: '关心一句，不追问工作细节', tone: '轻松', analysisAdjustment: null, reason: '合成探针' },
  riskCategories: [], requiredFacts: [], confirmationReasons: [], analysisRefs: [], skillInvocationRefs: [],
  generatorVersion: 'smoke', promptVersion: 'smoke', evidenceRefs: [], uncertainty: '低',
};

const described = describeDeepSeekEnv(readDeepSeekEnv(process.env));
process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'smoke_starting', syntheticContext: true, ...described })}\n`);

const provider = createDeepSeekFromEnv(process.env);
const started = Date.now();
let result: Awaited<ReturnType<typeof provider.invoke>> | undefined;
try {
  result = await provider.invoke({ context, decision, policy, signal: AbortSignal.timeout(60_000) });
} catch (error) {
  if (error instanceof DeepSeekHttpError) {
    const hint = error.status === 401 ? 'key 无效或已被撤销'
      : error.status === 402 ? '账户余额/额度不足'
      : error.status === 429 ? '触发限流，稍后重试'
      : error.status === 400 ? '请求被拒，通常是模型名或参数不被接受'
      : '平台侧错误';
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'smoke_failed',
      httpStatus: error.status, providerCode: error.providerCode, hint })}\n`);
    // Exit code without an abrupt exit: a hard exit here trips a Node/Windows teardown assertion
    // while the fetch socket is still idle in the pool, which would bury the diagnostic above.
    process.exitCode = 2;
  }
  if (!(error instanceof DeepSeekHttpError)) throw error;
}
const elapsedMs = Date.now() - started;
if (!result) {
  process.stdout.write('smoke ended without a candidate; nothing was generated\n');
} else {
const alternatives = result.alternatives as { clientAlternativeKey: string; strategySummary: string; parts: { content: string }[] }[];

// Flash list price (2026-09-26): cache-miss input $0.15/M off-peak, $0.30/M peak; output $0.60/M, $1.20/M.
const input = result.usage?.inputTokens ?? null, output = result.usage?.outputTokens ?? null;
const cost = input === null || output === null ? null : {
  offPeakUsd: Number((input / 1e6 * 0.15 + output / 1e6 * 0.6).toFixed(6)),
  peakUsd: Number((input / 1e6 * 0.3 + output / 1e6 * 1.2).toFixed(6)),
};
process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'smoke_result', elapsedMs,
  inputTokens: input, outputTokens: output, estimatedCostUsd: cost,
  alternatives: alternatives.map(alternative => ({ summary: alternative.strategySummary, parts: alternative.parts.map(part => part.content) })) }, null, 2)}\n`);
process.stdout.write('this was one synthetic probe; no real chat content was sent\n');
}
