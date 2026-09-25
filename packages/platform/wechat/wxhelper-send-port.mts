/** Offline send candidate. The live bridge does not import or instantiate this port. */
import type { SendEnvelope } from '../mock/adapter.mts';

export type WxhelperSendTransport = {
  submitOnce(request: { wxid: string; msg: string }, signal: AbortSignal): Promise<unknown>;
};

export function createWxhelperSendCandidate(options: {
  accountId: string; authority: object; transport: WxhelperSendTransport;
  now?: () => number; timeoutMs?: number; maxTextBytes?: number;
}) {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxTextBytes = options.maxTextBytes ?? 4_096;
  if (!options.accountId || !options.transport || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1) throw new Error('VALIDATION_FAILED');
  return {
    platform: 'wechat' as const, accountId: options.accountId,
    async submitSend(envelope: SendEnvelope, authority: object,
      preflight: (envelope: SendEnvelope) => Promise<boolean>) {
      if (authority !== options.authority || envelope.conversationRef.accountId !== options.accountId)
        throw new Error('FORBIDDEN');
      if (envelope.mode !== 'live') throw new Error('POLICY_BLOCKED');
      if (envelope.partType !== 'text' || envelope.mediaRef !== undefined || envelope.replyTo !== undefined)
        throw new Error('UNSUPPORTED_CAPABILITY');
      if (typeof envelope.content !== 'string' || !envelope.content.trim()
        || Buffer.byteLength(envelope.content, 'utf8') > maxTextBytes
        || !envelope.conversationRef.externalContactRef) throw new Error('VALIDATION_FAILED');
      const remaining = Date.parse(envelope.deadline) - now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('STALE_PLAN');
      if (typeof preflight !== 'function' || !(await preflight(envelope))) throw new Error('POLICY_BLOCKED');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => options.transport.submitOnce({
            wxid: envelope.conversationRef.externalContactRef, msg: envelope.content!,
          }, controller.signal)).catch(() => undefined),
          new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); },
            Math.min(timeoutMs, remaining)); }),
        ]);
      } catch {
        // An error after submission can still mean that WeChat sent the message.
      } finally {
        if (timer) clearTimeout(timer);
      }
      // Current wxhelper SendTextMsg discards its internal result and returns 0 unconditionally.
      // Its HTTP response is therefore not acceptance evidence, even when code is 0.
      return { status: 'RESULT_UNKNOWN' as const, receiptLevel: 'unknown' as const,
        correlationId: envelope.correlationId };
    },
  };
}
