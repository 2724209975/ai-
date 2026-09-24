/** Outbound QQ platform port for the bridge composition root.
 *
 * 02 owns authorization, the dispatch lease and the send ledger (`withDispatchLease`); this port
 * only turns an already-authorized envelope into one OneBot request and reports what the bridge
 * said. It never retries, never invents a platform message id, and never treats a bridge error as
 * proof that nothing was sent — the OneBot layer cannot distinguish those cases.
 */
import { decodeSendResponse, encodePrivateSend, WireError } from './onebot-codec.mts';
import type { SubmissionTransport } from './send-executor.mts';

export type QqSendEnvelope = {
  sendTaskId: string; sendKey: string;
  conversationRef: { accountId: string; conversationId: string; externalContactRef: string };
  partType: 'text' | 'approved_sticker';
  content?: string; mediaRef?: string; replyTo?: string;
  deadline: string; mode: 'live' | 'import' | 'trial' | 'replay'; correlationId: string;
};
export type QqSendOutcome = {
  status: 'SUBMITTED' | 'FAILED_DEFINITE' | 'RESULT_UNKNOWN';
  receiptLevel: 'accepted' | 'unknown';
  platformMessageId?: string; correlationId: string;
  /** Why the bridge could not confirm: the transport/decoder reason, for the operator's record. */
  reason?: string;
};

export type QqPlatformPort = {
  readonly platform: 'qq';
  readonly accountId: string;
  submitSend(envelope: QqSendEnvelope, authority: object, preflight?: (envelope: QqSendEnvelope) => Promise<boolean>): Promise<QqSendOutcome>;
};

export function createQqPlatformPort(options: {
  accountId: string;
  transport: SubmissionTransport;
  authority: object;
  /** Local budget, not a claimed platform limit. */
  maxTextBytes?: number;
  maxMediaBytes?: number;
  timeoutMs?: number;
  now?: () => number;
}): QqPlatformPort {
  const now = options.now ?? Date.now;
  const maxTextBytes = options.maxTextBytes ?? 4_096;
  const maxMediaBytes = options.maxMediaBytes ?? 1_048_576;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!options.accountId || !options.transport) throw new WireError();
  if (![maxTextBytes, maxMediaBytes, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new WireError();

  return {
    platform: 'qq',
    accountId: options.accountId,
    async submitSend(envelope, authority, preflight): Promise<QqSendOutcome> {
      if (authority !== options.authority) throw new WireError('FORBIDDEN');
      if (envelope.mode !== 'live') throw new WireError('POLICY_BLOCKED');
      if (envelope.conversationRef.accountId !== options.accountId) throw new WireError('FORBIDDEN');
      const deadlineMs = Date.parse(envelope.deadline);
      if (!Number.isFinite(deadlineMs)) throw new WireError();
      if (deadlineMs <= now()) throw new WireError('STALE_PLAN');
      // Approved-sticker sending needs 03's approved-asset port; until that is wired, refuse
      // instead of silently sending something else.
      if (envelope.partType !== 'text' || typeof envelope.content !== 'string' || !envelope.content.trim() || envelope.mediaRef !== undefined) {
        throw new WireError(envelope.partType === 'text' ? 'VALIDATION_FAILED' : 'UNSUPPORTED_CAPABILITY');
      }
      if (preflight && !(await preflight(envelope))) throw new WireError('POLICY_BLOCKED');

      const wire = encodePrivateSend(
        { peerId: envelope.conversationRef.externalContactRef, rpcId: envelope.sendKey, part: { kind: 'text', text: envelope.content }, replyTo: envelope.replyTo },
        { loadApprovedSticker: () => undefined, supportedStickerFormats: [], maxTextBytes, maxMediaBytes });

      const controller = new AbortController();
      const budget = Math.min(timeoutMs, Math.max(1, deadlineMs - now()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, budget); });
      try {
        // A thrown transport error is not proof the bridge refused: report unknown, never definite failure.
        const observed = await Promise.race([
          Promise.resolve().then(() => options.transport.submitOnce(structuredClone(wire), controller.signal))
            .then(response => decodeSendResponse(response.response, wire.echo, response.correlation))
            .catch(() => null),
          timeout,
        ]);
        // Never a silent unknown: carry the decoder/transport reason so the spike log can say why.
        if (!observed) return { status: 'RESULT_UNKNOWN', receiptLevel: 'unknown', correlationId: envelope.correlationId, reason: 'TRANSPORT_TIMEOUT_OR_ERROR' };
        return { status: observed.status, receiptLevel: observed.receiptLevel, platformMessageId: observed.platformMessageId,
          correlationId: envelope.correlationId, reason: observed.reason };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
