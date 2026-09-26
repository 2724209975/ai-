import type { PolicyProjection, ReplyAlternativeProposal, ReplyDecision, ReplyProposal, Result, ScopedContext } from '../types.mts';
import { FAKE_MODEL_VERSION, FAKE_PROMPT_VERSION, pendingContactBatch } from '../strategy/fake-decision.mts';

export interface CandidateGateway {
  readonly version: string;
  readonly promptVersion: string;
  /** The policy projection is prompt input for a real model, so it travels with the request. */
  generate(input: { context: ScopedContext; decision: ReplyDecision; policy: PolicyProjection; signal: AbortSignal }): Promise<unknown>;
}

/** Deterministic fixture. It makes no claim to imitate the owner's style. */
export class FakeCandidateGateway implements CandidateGateway {
  readonly version = FAKE_MODEL_VERSION;
  readonly promptVersion = FAKE_PROMPT_VERSION;
  async generate(): Promise<unknown> {
    return [
      { clientAlternativeKey: 'a1', strategySummary: '简短回应', parts: [{ clientPartKey: 'a1-p1', sequence: 1, type: 'text', content: '收到，我想听你多说一点。' }] },
      { clientAlternativeKey: 'a2', strategySummary: '轻松回应', parts: [{ clientPartKey: 'a2-p1', sequence: 1, type: 'text', content: '嗯，我看到了。' }, { clientPartKey: 'a2-p2', sequence: 2, type: 'text', content: '你愿意再说说吗？' }] },
      { clientAlternativeKey: 'a3', strategySummary: '温和回应', parts: [{ clientPartKey: 'a3-p1', sequence: 1, type: 'text', content: '谢谢你告诉我，我想先听听你的想法。' }] },
    ];
  }
}

function validateAlternatives(value: unknown): value is ReplyAlternativeProposal[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return false;
  const alternativeKeys = new Set<string>();
  for (const alternative of value) {
    if (!alternative || typeof alternative.clientAlternativeKey !== 'string' || !alternative.clientAlternativeKey || alternativeKeys.has(alternative.clientAlternativeKey) || typeof alternative.strategySummary !== 'string') return false;
    alternativeKeys.add(alternative.clientAlternativeKey);
    if (!Array.isArray(alternative.parts) || alternative.parts.length < 1 || alternative.parts.length > 8) return false;
    const partKeys = new Set<string>();
    for (const [index, part] of alternative.parts.entries()) {
      if (!part || part.type !== 'text' || typeof part.clientPartKey !== 'string' || !part.clientPartKey || partKeys.has(part.clientPartKey) || part.sequence !== index + 1 || typeof part.content !== 'string' || !part.content.trim() || part.content.length > 1000) return false;
      partKeys.add(part.clientPartKey);
    }
  }
  return true;
}

export async function proposeWithGateway(context: ScopedContext, decision: ReplyDecision, policy: PolicyProjection, gateway: CandidateGateway, timeoutMs = 3000): Promise<Result<ReplyProposal>> {
  if (decision.contextSnapshotId !== context.snapshot.id || decision.conversationId !== context.snapshot.conversationId) return { ok: false, error: { code: 'VALIDATION_FAILED', message: '决策与快照不匹配', retryable: false } };
  if (!decision.shouldReply) return { ok: false, error: { code: decision.requiredFacts.length ? 'MISSING_FACT' : 'VALIDATION_FAILED', message: '本轮决策不生成回复候选', retryable: false, details: decision.requiredFacts } };
  if (!gateway.version?.trim() || !gateway.promptVersion?.trim()) return { ok: false, error: { code: 'VALIDATION_FAILED', message: '候选模型版本或提示版本缺失', retryable: false } };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ok: false, error: { code: 'VALIDATION_FAILED', message: '模型超时设置无效', retryable: false } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const raw = await Promise.race([
      gateway.generate({ context, decision, policy, signal: controller.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('MODEL_TIMEOUT')); }, timeoutMs); }),
    ]);
    if (!validateAlternatives(raw)) return { ok: false, error: { code: 'MODEL_UNAVAILABLE', message: '模型候选结构无效或不完整', retryable: false } };
    return { ok: true, value: {
      conversationId: context.snapshot.conversationId,
      contextSnapshotId: context.snapshot.id,
      triggerMessageIds: pendingContactBatch(context).filter(m => m.actor === 'contact').map(m => m.id),
      alternatives: raw,
      generatorVersion: gateway.version,
      promptVersion: gateway.promptVersion,
      evidenceRefs: decision.evidenceRefs,
      uncertainty: decision.uncertainty,
    } };
  } catch (error) {
    const message = error instanceof Error && error.message === 'MODEL_TIMEOUT' ? '模型响应超时' : '模型暂不可用';
    return { ok: false, error: { code: 'MODEL_UNAVAILABLE', message, retryable: true } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function proposeWithFallback(context: ScopedContext, decision: ReplyDecision, policy: PolicyProjection, primary: CandidateGateway, fallback: CandidateGateway | null, timeoutMs = 3000): Promise<Result<ReplyProposal>> {
  const first = await proposeWithGateway(context, decision, policy, primary, timeoutMs);
  if (first.ok || !fallback || first.error.code !== 'MODEL_UNAVAILABLE') return first;
  return proposeWithGateway(context, decision, policy, fallback, timeoutMs);
}
