/** QQ wire observation → public event envelope.
 *
 * 01 owns this mapping; the semantics come from docs/contracts.md. Two rules are load-bearing:
 * a self message without independent owner evidence can never become a contact inbound message
 * (contracts.md §3, A08), and a media part is never rewritten as text just because we cannot
 * interpret it yet.
 */
import type { EventEnvelope, MessageType } from '../../contracts/index.mts';
import type { WireObservation, WirePart } from './onebot-codec.mts';

export type NormalizeContext = {
  /** Internal PlatformAccount id used by 02/03, not the platform account number. */
  accountId: string;
  externalAccountRef: string;
  /** Internal conversation resolved by the enrollment lookup; absent means "not enrolled". */
  conversationId: string;
  eventId: string;
  correlationId: string;
  causationId: string;
  receivedAt: string;
  adapterVersion: string;
};

function bodyParts(parts: readonly WirePart[]): WirePart[] {
  return parts.filter(part => part.kind !== 'reply');
}

/** Never discard a valid wire observation merely because its body has no single safe type. */
function bodyType(parts: readonly WirePart[]): { type: MessageType; contentRef?: string } {
  const body = bodyParts(parts);
  if (body.length !== 1) return { type: 'unsupported' };
  const part = body[0]!;
  switch (part.kind) {
    case 'text': {
      const text = part.text.trim();
      if (!text) return { type: 'unsupported' };
      return { type: 'text', contentRef: part.text };
    }
    case 'media': return { type: part.mediaKind === 'voice' ? 'voice' : 'image' };
    // A native QQ face is not the same object as a platform sticker; do not claim one.
    case 'native_face': return { type: 'unsupported' };
    case 'unsupported': return { type: 'unsupported' };
    default: return { type: 'unsupported' };
  }
}

function envelope<T extends EventEnvelope['eventType']>(context: NormalizeContext, eventType: T, aggregateId: string, aggregateVersion: number, payload: Record<string, unknown>): EventEnvelope<T> {
  return { eventId: context.eventId, eventType, eventVersion: 1, occurredAt: context.receivedAt,
    correlationId: context.correlationId, causationId: context.causationId,
    aggregateId, aggregateVersion, payload };
}

/**
 * Returns the public event for a decoded observation, or `undefined` when the peer is not enrolled.
 * Unenrolled peers keep only the raw evidence the caller already committed; they must not produce
 * analysis, candidates or sends.
 */
export function normalizeObservation(observation: WireObservation, context: NormalizeContext): EventEnvelope | undefined {
  if (observation.kind === 'unmapped_self') return undefined; // Account-level quarantine; no conversation can be guessed.
  const conversationRef = { accountId: context.accountId, conversationId: context.conversationId, externalContactRef: observation.externalContactRef };
  const provenance = { source: 'onebot11_bridge', rawEventRef: observation.rawEventRef, adapterVersion: context.adapterVersion };

  if (observation.kind === 'recall') {
    if (!context.conversationId) return undefined;
    return envelope(context, 'PlatformMessageMutationObserved', context.conversationId, 1, {
      adapter: 'qq-onebot', platform: 'qq', accountId: context.accountId, conversationRef,
      platformMessageId: observation.platformMessageId, platformEventId: observation.dedupeKey,
      mutation: 'recall', sentAt: observation.sentAt, mode: 'live' as const,
      receivedAt: context.receivedAt, requiresReview: true, provenance,
    });
  }

  const { type, contentRef } = bodyType(observation.parts);
  const replied = observation.parts.find(part => part.kind === 'reply');
  // A reply segment carries the *platform* message id. It cannot become `quotedMessageId`, which is
  // this system's own message id: the quoted message may not even be stored locally. Keep the
  // platform reference in provenance so the spike can still record that the field was present.
  const quotedPlatformMessageId = replied?.kind === 'reply' ? replied.platformMessageId : undefined;
  const shared = { adapter: 'qq-onebot', platform: 'qq' as const, accountId: context.accountId, conversationRef,
    platformEventId: observation.dedupeKey, platformMessageId: observation.platformMessageId,
    sentAt: observation.sentAt, receivedAt: context.receivedAt, type, contentRef,
    dedupeKey: observation.dedupeKey, mode: 'live' as const,
    provenance: quotedPlatformMessageId ? { ...provenance, quotedPlatformMessageId } : provenance };

  if (observation.direction === 'self') {
    if (!context.conversationId) return undefined;
    // No ledger match and no independent owner verifier yet: this stays unattributed. 02 pauses the
    // contact and asks for review; it must never be delivered as a contact message or a style fact.
    return envelope(context, 'PlatformSelfMessageUnattributed', context.conversationId, 1, {
      ...shared, actor: 'unknown', originStatus: 'unknown', isAgentGenerated: false,
      rawEventRef: observation.rawEventRef, requiresReview: true,
    });
  }

  if (!context.conversationId) return undefined;
  return envelope(context, 'PlatformInboundObserved', context.conversationId, 1, {
    ...shared, actor: 'contact', isAgentGenerated: false, requiresReview: observation.requiresReview || type === 'unsupported',
  });
}
