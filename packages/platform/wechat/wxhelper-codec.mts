/** Receive-only wxhelper push decoder. Never calls a wxhelper action or sends a message. */
import { createHash } from 'node:crypto';
import type { EventEnvelope, MessageType } from '../../contracts/index.mts';

export class WxWireError extends Error {
  readonly code: 'VALIDATION_FAILED' | 'FORBIDDEN' | 'UNSUPPORTED_CAPABILITY' | 'CONFLICT_VERSION';
  constructor(code: WxWireError['code'] = 'VALIDATION_FAILED') { super(code); this.code = code; }
}

type ObjectValue = Record<string, unknown>;
/** Set only after 03 has bound a private asset to this message; absent means no usable original. */
export type WxObservedMedia = Readonly<{ mediaId: string; mimeType: string; completeness: 'complete' }>;
export type WxObservation = {
  kind: 'incoming' | 'self' | 'unmapped_self' | 'out_of_scope';
  accountRef: string; peerRef?: string; platformMessageId: string; sentAt: string;
  dedupeKey: string; rawEventRef: string; type: MessageType; contentRef?: string;
  requiresReview: boolean; typeCode: number; msgSequence?: number; media?: WxObservedMedia;
};

/** Quote only the top-level msgId integer before JSON.parse can round its 64-bit value. */
function preserveMessageId(source: string): string {
  let depth = 0, i = 0, replaceStart = -1, replaceEnd = -1, lexeme = '';
  const critical = new Set(['msgId', 'fromUser', 'toUser', 'type', 'createTime', 'content']);
  const seen = new Set<string>();
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"') {
      const start = i++;
      let escaped = false;
      for (; i < source.length; i++) {
        const part = source[i]!;
        if (escaped) { escaped = false; continue; }
        if (part === '\\') { escaped = true; continue; }
        if (part === '"') break;
      }
      if (i >= source.length) throw new WxWireError();
      const key = JSON.parse(source.slice(start, ++i)) as string;
      if (depth !== 1) continue;
      let colon = i;
      while (/\s/.test(source[colon] ?? '')) colon++;
      if (source[colon] !== ':') continue;
      if (critical.has(key)) {
        if (seen.has(key)) throw new WxWireError();
        seen.add(key);
      }
      if (key !== 'msgId') continue;
      let value = colon + 1;
      while (/\s/.test(source[value] ?? '')) value++;
      if (source[value] === '"') continue;
      const match = /^-?\d+/.exec(source.slice(value));
      if (!match || !/[},\s]/.test(source[value + match[0].length] ?? '')) throw new WxWireError();
      replaceStart = value; replaceEnd = value + match[0].length; lexeme = match[0];
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    if (depth < 0) throw new WxWireError();
    i++;
  }
  if (!seen.has('msgId')) throw new WxWireError();
  return replaceStart < 0 ? source : source.slice(0, replaceStart) + JSON.stringify(lexeme) + source.slice(replaceEnd);
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new WxWireError();
  const number = BigInt(value);
  if (number < 1n || number > 18_446_744_073_709_551_615n) throw new WxWireError();
  return number.toString();
}
function ref(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f\s]/.test(value)) throw new WxWireError();
  return value;
}
/** Chat message types. A self event of another type is not a message and keeps account quarantine. */
const chatTypeCodes = new Set([1, 3, 34, 42, 43, 47, 48, 49]);
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new WxWireError();
  return value as number;
}

export function decodeWxhelperPush(bytes: Uint8Array, options: { expectedSelfRef: string; rawEventRef: string }): WxObservation {
  let body: ObjectValue;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    body = JSON.parse(preserveMessageId(source)) as ObjectValue;
  } catch { throw new WxWireError(); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WxWireError();
  const self = ref(options.expectedSelfRef), from = ref(body.fromUser), to = ref(body.toUser);
  const platformMessageId = id(body.msgId);
  const seconds = integer(body.createTime), typeCode = integer(body.type);
  const msgSequence = body.msgSequence === undefined ? undefined : integer(body.msgSequence);
  // The hook supplies seconds, but zero or far-future timestamps are not useful evidence.
  if (seconds < 946684800 || seconds > 4_102_444_800) throw new WxWireError();
  const sentAt = new Date(seconds * 1000).toISOString();
  const direction = from === self ? 'unmapped_self' : to === self ? 'incoming' : undefined;
  if (!direction) throw new WxWireError('FORBIDDEN');
  const peerRef = direction === 'incoming' ? from : to;
  // Fixed-client samples show type 51 op 2/4/5/11 status notifications, not chat text.
  // Match only the observed envelope; unknown shapes retain the existing quarantine.
  const statusNotify = direction === 'unmapped_self' && typeCode === 51
    && typeof body.content === 'string'
    && (/^\s*<msg>\s*<op\s+id=['"](?:2|5)['"]>\s*<username>[^<]*<\/username>\s*<name>[^<]*<\/name>\s*<arg>[^<]*<\/arg>\s*<\/op>\s*<\/msg>\s*$/.test(body.content)
      || /^\s*<msg>\s*<op\s+id=['"](?:4|11)['"]>[\s\S]*<\/op>\s*<\/msg>\s*$/.test(body.content));
  const outOfScope = statusNotify || peerRef.endsWith('@chatroom') || peerRef === 'filehelper';
  // Own-account chat to a direct peer names that peer in toUser (verified with a phone-sent sample).
  // Direction identifies the peer, not the sender's client. Without paired send evidence the
  // origin stays unknown and 02 pauses only that contact.
  const kind = outOfScope ? 'out_of_scope' : direction === 'unmapped_self' && chatTypeCodes.has(typeCode) ? 'self' : direction;
  const contentRef = typeCode === 1 && typeof body.content === 'string' && body.content.trim() ? body.content : undefined;
  const type: MessageType = typeCode === 1 && contentRef ? 'text' : typeCode === 3 ? 'image' : typeCode === 34 ? 'voice' : 'unsupported';
  const dedupeKey = JSON.stringify(['wechat', self, peerRef, platformMessageId, 'message']);
  if (!options.rawEventRef || !/^bridge:[A-Za-z0-9._-]+:[a-f0-9]{32}$/.test(options.rawEventRef)) throw new WxWireError();
  return { kind, accountRef: self, peerRef: kind === 'unmapped_self' ? undefined : peerRef,
    platformMessageId, sentAt, dedupeKey, rawEventRef: options.rawEventRef,
    type, contentRef, requiresReview: type !== 'text', typeCode, msgSequence };
}

type NormalizeContext = {
  accountId: string; conversationId: string; eventId: string; correlationId: string;
  receivedAt: string; adapterVersion: string;
};

export function normalizeWxObservation(observation: WxObservation, context: NormalizeContext): EventEnvelope<'PlatformInboundObserved'> {
  if (observation.kind !== 'incoming' || !observation.peerRef) throw new WxWireError();
  const { accountId, conversationId, eventId, correlationId, receivedAt, adapterVersion } = context;
  const payload = { adapter: 'wechat-wxhelper', platform: 'wechat' as const, accountId,
    conversationRef: { accountId, conversationId, externalContactRef: observation.peerRef },
    platformEventId: observation.dedupeKey, platformMessageId: observation.platformMessageId,
    sentAt: observation.sentAt, receivedAt, type: observation.type, contentRef: observation.contentRef,
    dedupeKey: observation.dedupeKey, mode: 'live' as const, actor: 'contact' as const,
    isAgentGenerated: false as const, requiresReview: observation.requiresReview,
    ...(observation.media ? { mediaId: observation.media.mediaId } : {}),
    provenance: { source: 'wxhelper_loopback', rawEventRef: observation.rawEventRef, adapterVersion,
      msgSequence: observation.msgSequence,
      mediaCompleteness: observation.media?.completeness
        ?? (observation.type === 'image' || observation.type === 'voice' ? 'unknown' : undefined) } };
  return { eventId, eventType: 'PlatformInboundObserved', eventVersion: 1, occurredAt: receivedAt,
    correlationId, causationId: observation.dedupeKey, aggregateId: conversationId,
    aggregateVersion: 1, payload };
}

/** An own-account message to an enrolled peer. Never a contact inbound or a style fact (contracts.md A08). */
export function normalizeWxSelfObservation(observation: WxObservation, context: NormalizeContext): EventEnvelope<'PlatformSelfMessageUnattributed'> {
  if (observation.kind !== 'self' || !observation.peerRef) throw new WxWireError();
  const { accountId, conversationId, eventId, correlationId, receivedAt, adapterVersion } = context;
  const payload = { platform: 'wechat' as const, accountId,
    conversationRef: { accountId, conversationId, externalContactRef: observation.peerRef },
    platformEventId: observation.dedupeKey, platformMessageId: observation.platformMessageId,
    sentAt: observation.sentAt, receivedAt, type: observation.type, contentRef: observation.contentRef,
    rawEventRef: observation.rawEventRef, actor: 'unknown' as const, originStatus: 'unknown' as const,
    isAgentGenerated: false as const, mode: 'live' as const,
    provenance: { source: 'wxhelper_loopback', rawEventRef: observation.rawEventRef, adapterVersion,
      evidence: 'self_to_enrolled_peer' } };
  return { eventId, eventType: 'PlatformSelfMessageUnattributed', eventVersion: 1, occurredAt: receivedAt,
    correlationId, causationId: observation.dedupeKey, aggregateId: conversationId,
    aggregateVersion: 1, payload };
}

export function rawRef(accountId: string, bytes: Uint8Array): string {
  return `bridge:${accountId}:${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
}
