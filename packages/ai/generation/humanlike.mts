/** Makes candidates read like the owner's own chat: learn from the owner's real replies in scope,
 * describe images the model cannot see, and clean model habits out of the answer.
 *
 * Everything here is deterministic and reads only the already-scoped context; nothing is stored.
 */
import type { MessageProjection } from '../types.mts';

export type StyleProfile = {
  /** Owner text messages the profile was computed from. */
  sampleSize: number;
  averageChars: number;
  /** Share of owner messages ending in 。 — when low, candidates drop it too. */
  periodEndingRate: number;
  emojiRate: number;
  /** Fixed particles and fillers the owner uses often, most frequent first. */
  habits: string[];
};

const HABIT_CANDIDATES = ['哈哈', '嘿嘿', '嘻嘻', '嗯嗯', '哦哦', '好滴', '好哒', '好嘞', '啦', '呀', '嘛', '吧', '呢', '哇', '诶', '嗷', '捏', '~', '…', '！', '？', '。。'];
const EMOJI = /\p{Extended_Pictographic}|\[[一-龥A-Za-z]{1,4}\]/u;
const MAX_EXAMPLES = 8;
const MIN_PROFILE_SAMPLES = 10;

function ownerText(message: MessageProjection): string | null {
  if (message.actor !== 'owner' || message.isAgentGenerated || message.type !== 'text') return null;
  const value = (message.text ?? '').trim();
  return value ? value : null;
}

/** Undefined until there is enough of the owner's own writing to say anything honest. */
export function ownerStyleProfile(messages: readonly MessageProjection[]): StyleProfile | undefined {
  const texts = messages.map(ownerText).filter((value): value is string => value !== null);
  if (texts.length < MIN_PROFILE_SAMPLES) return undefined;
  const share = (predicate: (value: string) => boolean): number => texts.filter(predicate).length / texts.length;
  const habits = HABIT_CANDIDATES
    .map(habit => ({ habit, rate: share(value => value.includes(habit)) }))
    .filter(entry => entry.rate >= 0.2 && Math.round(entry.rate * texts.length) >= 3)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 6)
    .map(entry => entry.habit);
  return {
    sampleSize: texts.length,
    averageChars: Math.round(texts.reduce((sum, value) => sum + [...value].length, 0) / texts.length),
    periodEndingRate: share(value => value.endsWith('。')),
    emojiRate: share(value => EMOJI.test(value)),
    habits,
  };
}

export function describeStyle(profile: StyleProfile): string {
  const lines = [
    `- 以下统计来自 ${profile.sampleSize} 条本人消息，仅供参考；明确设置的表达偏好优先，回复长度以表达完整为准`,
  ];
  if (profile.averageChars >= 4) lines.push(`- 本人平均每条约 ${profile.averageChars} 字，可参考这个长度`);
  if (profile.periodEndingRate <= 0.1) lines.push('- 本人一般不在句末加句号');
  else if (profile.periodEndingRate >= 0.8) lines.push('- 本人习惯在句末加句号');
  if (profile.emojiRate >= 0.3) lines.push('- 本人有使用表情的习惯，可视话题适量使用');
  if (profile.habits.length) lines.push(`- 本人常用：${profile.habits.join(' ')}（自然地用，别每条都用）`);
  return lines.join('\n');
}

/** "对方 → 本人" pairs from the owner's real replies, oldest first. Agent-sent text is never an example. */
export function styleExamples(messages: readonly MessageProjection[], limit = MAX_EXAMPLES): string[] {
  const pairs: string[] = [];
  for (let index = 1; index < messages.length; index++) {
    const reply = ownerText(messages[index]!);
    const previous = messages[index - 1]!;
    if (!reply || previous.actor !== 'contact') continue;
    const prompt = previous.type === 'text' ? (previous.text ?? '').trim() : `[${previous.type}]`;
    if (prompt) pairs.push(`对方：${prompt}\n本人：${reply}`);
  }
  return pairs.slice(-limit);
}

/** What the model may know about a non-text message: only a complete, stored or verified description. */
export function describeMessageBody(message: MessageProjection): string {
  if (message.type === 'text') return (message.text ?? '').trim();
  const interpretation = message.mediaInterpretation;
  const label = message.type === 'image' ? '图片' : message.type === 'voice' ? '语音' : '表情';
  if (interpretation && interpretation.completeness === 'complete' && interpretation.text?.trim()) {
    const uncertain = interpretation.uncertainty?.trim();
    return `[${label}：${interpretation.text.trim()}${uncertain && uncertain !== '低' ? `（不确定处：${uncertain}）` : ''}]`;
  }
  return `[${message.type} 内容未取到可靠文本]`;
}

export const TAIL_REMINDER = [
  '最后提醒：',
  '- 你写的是本人要发出去的聊天消息，不是对本人说话，不要解释、不要分析对方；',
  '- 像真人发消息一样口语、随意，可以拆成 1-3 条短消息，每条只说一件事；',
  '- 不用 Markdown、不用列表符号、不要引号包裹、不要自称 AI 或助手；',
  '- 模仿上面「本人回复示例」的长度、语气和用词，不要比本人更热情或更正式。',
  '- 明确设置的表达偏好与限制优先于样例和统计；样例不足时自然接话，不要凭少量样例固定口头禅或句长。',
].join('\n');

const AI_SELF_REFERENCE = /^(?:作为(?:一个)?\s*(?:AI\b(?:助手|语言模型)?|人工智能(?:助手|语言模型)?|语言模型|助手)(?=\s*(?:[,，。:：]|我|$))|我是(?:一个)?\s*(?:AI\b|人工智能|语言模型))/i;

function cleanPart(value: string, profile: StyleProfile | undefined): string[] {
  const lines = value
    .split(/\r?\n+/)
    .map(line => line.replace(/^\s*(#{1,6}\s+|[-*•]\s+|\d+[.、)]\s+)/, '').trim())
    // Strip only a whole-line bold wrapper. Identifiers and inline code remain verbatim.
    .map(line => line.replace(/^\*\*([^*]+)\*\*$/u, '$1'))
    .map(line => line.replace(/^["“「『](.*)["”」』]$/u, '$1').trim())
    .filter(Boolean);
  const dropPeriod = !!profile && profile.periodEndingRate <= 0.1;
  return lines.map(line => dropPeriod ? line.replace(/(?<!。)。$/u, '') : line).filter(Boolean);
}

type TextPart = { clientPartKey: string; sequence: number; type: 'text'; content: string };
type Alternative = { clientAlternativeKey: string; strategySummary: string; parts: TextPart[] };

/** Splits multi-line parts into separate messages, strips formatting and drops AI self-references. */
export function humaniseAlternatives(alternatives: unknown[], profile: StyleProfile | undefined, maxParts = 3, maxPartChars = 200): unknown[] {
  if (!Number.isSafeInteger(maxParts) || maxParts < 1 || !Number.isSafeInteger(maxPartChars) || maxPartChars < 1) throw new Error('VALIDATION_FAILED');
  const result: Alternative[] = [];
  for (const raw of alternatives as Alternative[]) {
    const contents = raw.parts.flatMap(part => cleanPart(part.content, profile));
    if (!contents.length || contents.some(content => AI_SELF_REFERENCE.test(content))) continue;
    // Keep all clauses, including qualifications at the end, within the message-count contract.
    if (contents.length > maxParts) contents.splice(maxParts - 1, contents.length, contents.slice(maxParts - 1).join('\n'));
    // Reject the whole alternative rather than silently shorten its meaning.
    if (contents.some(content => [...content].length > maxPartChars)) continue;
    result.push({ ...raw, parts: contents.map((content, index) => ({
      clientPartKey: `${raw.clientAlternativeKey}-p${index + 1}`, sequence: index + 1, type: 'text', content })) });
  }
  return result;
}
