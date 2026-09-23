/** Classification of a QQ self-message after raw-event persistence, before public event emission. */
import { WireError } from './onebot-codec.mts';
import type { WireMessage } from './onebot-codec.mts';

export type SendEchoLedger = {
  /** Must search durable platform-message-ID evidence, never content/time similarity. */
  findByPlatformMessageId(account: string, platformMessageId: string): Promise<{
    account: string; peer: string; platformMessageId: string; sendTaskId: string; sendKey: string;
  } | undefined>;
};
export type IndependentOwnerVerifier = {
  /** Only a bridge-specific origin signal validated on the target account may return verified. */
  verify(message: WireMessage): Promise<{ kind: 'verified'; evidenceRef: string } | { kind: 'unknown' }>;
};
export type SelfOrigin =
  | { actor: 'agent'; sendTaskId: string; sendKey: string; evidence: 'durable_platform_id_match' }
  | { actor: 'owner'; evidenceRef: string; evidence: 'validated_bridge_origin' }
  | { actor: 'unknown'; reason: 'NO_PROOF' | 'LEDGER_SCOPE_CONFLICT' | 'EVIDENCE_UNAVAILABLE' };

export async function classifyQqSelfMessage(message: WireMessage, deps: {
  ledger: SendEchoLedger; ownerVerifier?: IndependentOwnerVerifier;
}): Promise<SelfOrigin> {
  if (message.direction !== 'self' || message.actor !== 'unknown') throw new WireError('VALIDATION_FAILED');
  let match: Awaited<ReturnType<SendEchoLedger['findByPlatformMessageId']>>;
  try { match = await deps.ledger.findByPlatformMessageId(message.externalAccountRef, message.platformMessageId); }
  catch { return { actor: 'unknown', reason: 'EVIDENCE_UNAVAILABLE' }; }
  if (match) {
    if (match.account !== message.externalAccountRef || match.peer !== message.externalContactRef || match.platformMessageId !== message.platformMessageId
      || !match.sendTaskId || !match.sendKey) return { actor: 'unknown', reason: 'LEDGER_SCOPE_CONFLICT' };
    return { actor: 'agent', sendTaskId: match.sendTaskId, sendKey: match.sendKey, evidence: 'durable_platform_id_match' };
  }
  if (!deps.ownerVerifier) return { actor: 'unknown', reason: 'NO_PROOF' };
  try {
    const origin = await deps.ownerVerifier.verify(structuredClone(message));
    if (origin.kind === 'verified' && typeof origin.evidenceRef === 'string' && origin.evidenceRef.trim()) {
      return { actor: 'owner', evidenceRef: origin.evidenceRef, evidence: 'validated_bridge_origin' };
    }
    return { actor: 'unknown', reason: 'NO_PROOF' };
  } catch { return { actor: 'unknown', reason: 'EVIDENCE_UNAVAILABLE' }; }
}
