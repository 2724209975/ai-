/** DeepSeek text provider: the first real model behind 04's `TextModelProvider` contract.
 *
 * Responsibilities are narrow on purpose. It builds one prompt from the already-scoped context and
 * the decision, calls the OpenAI-compatible chat endpoint, and normalises the answer into the
 * alternative shape 04 validates. It never decides whether a reply is allowed, never touches 02,
 * and never logs the key, the prompt or the answer.
 *
 * `modelVersion` is operator-declared: DeepSeek does not hand back a dated snapshot id, so pinning
 * a version here means "we recorded what we asked for", not "the platform guarantees it".
 */
import type { PolicyProjection, ReplyDecision, ScopedContext } from '../types.mts';
import type { TextModelProvider } from './text-provider-contract.mts';

export type DeepSeekProviderOptions = {
  apiKey: string;
  modelId: string;
  /** Recorded with every measurement; defaults to the model id. */
  modelVersion?: string;
  promptVersion: string;
  /** Recorded so the owner's D06 choice is auditable, not inferred. */
  dataRegion: string;
  retentionPolicy: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  /** Provider default is thinking-on; reply candidates are short, so we default to non-thinking. */
  thinking?: 'disabled' | 'enabled';
};

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
/** Current API model name; `deepseek-v4-flash` is a still-accepted legacy alias of the same model. */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';
export const DEEPSEEK_PROMPT_VERSION = 'reply-candidates-1';

const MAX_HISTORY = 20;
const MAX_PART_CHARS = 200;
const MAX_ALTERNATIVES = 3;
const MAX_PARTS_PER_ALTERNATIVE = 3;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The contact's own words are the only chat content sent; everything else is owner configuration. */
export function buildPrompt(context: ScopedContext, decision: ReplyDecision, policy: PolicyProjection): { system: string; user: string } {
  const system = [
    '你是本人（账号主人）的聊天回复助手，负责给对方写候选回复。',
    '只输出一个 JSON 对象，不要输出解释、Markdown 或代码块围栏。',
    'JSON 结构：{"alternatives":[{"summary":"一句话说明这个方案的策略","parts":["第一条","第二条"]}]}',
    '规则：',
    `1) 给出 1-${MAX_ALTERNATIVES} 个方案，每个方案 ${1}-${MAX_PARTS_PER_ALTERNATIVE} 条消息，每条不超过 ${MAX_PART_CHARS} 字；`,
    '2) 只用对话里已经出现的事实，绝不编造行程、承诺或对方没说过的话；',
    '3) 不要提出具体见面时间地点，不要表白、不要确认或否认关系、不要谈钱；',
    '4) 语气贴近本人平时的表达，像日常聊天，不要客服腔、不要书面语；',
    '5) 与最后一条消息自然衔接，可以只回一句。',
  ].join('\n');
  const history = context.messages.slice(-MAX_HISTORY).map(message => {
    const who = message.actor === 'contact' ? '对方' : message.actor === 'owner' ? '本人' : message.actor === 'agent' ? '助手（已发）' : '未知来源';
    const body = message.type === 'text' ? (message.text ?? '').trim() : `[${message.type} 内容未取到可靠文本]`;
    return `${who}（${message.sentAt}）：${body}`;
  }).join('\n');
  const facts = context.facts.filter(fact => fact.confirmationStatus === 'confirmed' && fact.deletionStatus === 'active')
    .slice(0, 20).map(fact => `- ${fact.subject}：${fact.content}`).join('\n');
  const analyses = context.analyses.filter(analysis => analysis.status === 'valid').slice(0, 5)
    .map(analysis => `- ${analysis.observation}（不确定性：${analysis.uncertainty}）`).join('\n');
  const user = [
    `聊天目标：${policy.goal}`,
    policy.stylePreferences.length ? `表达偏好：${policy.stylePreferences.join('、')}` : '',
    policy.restrictions.length ? `额外限制：${policy.restrictions.join('、')}` : '',
    facts ? `本人已确认的事实（可用）：\n${facts}` : '本人已确认的事实：无（不要假设）',
    analyses ? `对对方的推测（仅供参考，不是事实）：\n${analyses}` : '',
    `本轮策略：${decision.strategy.summary}；语气：${decision.strategy.tone}`,
    decision.riskCategories.length ? `需要回避的敏感类别：${decision.riskCategories.join('、')}` : '',
    `最近对话（时间从早到晚）：\n${history}`,
    '请给出候选 JSON。',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** Accepts the documented shape first, then the looser shapes models actually produce. */
export function normaliseAlternatives(raw: unknown): unknown[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { alternatives?: unknown })?.alternatives) ? (raw as { alternatives: unknown[] }).alternatives : [];
  const alternatives: unknown[] = [];
  for (const [index, entry] of list.slice(0, MAX_ALTERNATIVES).entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { summary?: unknown; strategySummary?: unknown; parts?: unknown };
    const summary = text(candidate.summary) || text(candidate.strategySummary) || `方案 ${index + 1}`;
    const rawParts = Array.isArray(candidate.parts) ? candidate.parts : [];
    const parts = rawParts.slice(0, MAX_PARTS_PER_ALTERNATIVE).map((part, partIndex) => {
      const content = typeof part === 'string' ? part.trim()
        : part && typeof part === 'object' ? text((part as { content?: unknown; text?: unknown }).content ?? (part as { text?: unknown }).text) : '';
      return content ? { clientPartKey: `a${index + 1}-p${partIndex + 1}`, sequence: partIndex + 1, type: 'text' as const, content } : null;
    }).filter((part): part is { clientPartKey: string; sequence: number; type: 'text'; content: string } => part !== null);
    if (parts.length) alternatives.push({ clientAlternativeKey: `a${index + 1}`, strategySummary: summary, parts });
  }
  return alternatives;
}

/** Strips a code fence or surrounding prose before parsing; models add them even when told not to. */
export function parseModelJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* fall through to the brace slice */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('MODEL_UNAVAILABLE');
}

export function createDeepSeekTextProvider(options: DeepSeekProviderOptions): TextModelProvider {
  if (!options?.apiKey?.trim()) throw new Error('MISSING_DEEPSEEK_API_KEY');
  if (!options.modelId?.trim() || !options.promptVersion?.trim() || !options.dataRegion?.trim() || !options.retentionPolicy?.trim()) throw new Error('VALIDATION_FAILED');
  let endpoint: URL;
  try { endpoint = new URL('chat/completions', options.baseUrl?.trim() || DEEPSEEK_DEFAULT_BASE_URL); }
  catch { throw new Error('INVALID_DEEPSEEK_BASE_URL'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('INVALID_DEEPSEEK_BASE_URL');
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxTokens = options.maxTokens ?? 800;
  const temperature = options.temperature ?? 1;
  const thinking = options.thinking ?? 'disabled';
  if (thinking !== 'disabled' && thinking !== 'enabled') throw new Error('VALIDATION_FAILED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error('VALIDATION_FAILED');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 64 || maxTokens > 32_768) throw new Error('VALIDATION_FAILED');
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('VALIDATION_FAILED');

  return {
    providerId: 'deepseek',
    modelId: options.modelId.trim(),
    modelVersion: (options.modelVersion ?? options.modelId).trim(),
    promptVersion: options.promptVersion.trim(),
    dataRegion: options.dataRegion.trim(),
    retentionPolicy: options.retentionPolicy.trim(),
    async invoke({ context, decision, policy, signal }) {
      const prompt = buildPrompt(context, decision, policy);
      const request = {
        model: options.modelId.trim(),
        messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        temperature, max_tokens: maxTokens, response_format: { type: 'json_object' }, stream: false,
        thinking: { type: thinking },
      };
      const timer = new AbortController();
      const onAbort = (): void => timer.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const local = setTimeout(() => timer.abort(), timeoutMs);
      try {
        const response = await call(endpoint.toString(), {
          method: 'POST', signal: timer.signal, redirect: 'error', cache: 'no-store',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey.trim()}` },
          body: JSON.stringify(request),
        });
        if (!response.ok) throw new Error('MODEL_UNAVAILABLE');
        const payload = await response.json() as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('MODEL_UNAVAILABLE');
        const alternatives = normaliseAlternatives(parseModelJson(content));
        if (!alternatives.length) throw new Error('MODEL_UNAVAILABLE');
        const count = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
        return { alternatives, usage: { inputTokens: count(payload.usage?.prompt_tokens), outputTokens: count(payload.usage?.completion_tokens) } };
      } finally {
        clearTimeout(local);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
