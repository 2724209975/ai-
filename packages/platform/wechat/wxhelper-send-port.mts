/** 02-only send candidate. The receive bridge never instantiates this port. */
import { createHash } from 'node:crypto';
import type { SendEnvelope } from '../mock/adapter.mts';

export type WxhelperSendTransport = {
  submitOnce(request: { wxid: string; msg: string }, signal: AbortSignal): Promise<unknown>;
};

export function createWxhelperSendCandidate(options: {
  accountId: string; authority: object; transport: WxhelperSendTransport;
  /** A real one-shot run must pin the exact approved task, peer and content hash. */
  permit?: { sendTaskId: string; externalContactRef: string; contentSha256: string };
  now?: () => number; timeoutMs?: number; maxTextBytes?: number;
}) {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxTextBytes = options.maxTextBytes ?? 4_096;
  if (!options.accountId || !options.transport || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1) throw new Error('VALIDATION_FAILED');
  if (options.permit && (!options.permit.sendTaskId || !options.permit.externalContactRef
    || !/^[a-f0-9]{64}$/i.test(options.permit.contentSha256))) throw new Error('VALIDATION_FAILED');
  let permitConsumed = false;
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
      if (options.permit) {
        const digest = createHash('sha256').update(envelope.content, 'utf8').digest('hex');
        if (permitConsumed || envelope.sendTaskId !== options.permit.sendTaskId
          || envelope.conversationRef.externalContactRef !== options.permit.externalContactRef
          || digest !== options.permit.contentSha256.toLowerCase()) throw new Error('POLICY_BLOCKED');
        // Consume before the first await. Even a failed preflight cannot authorize a retry.
        permitConsumed = true;
      }
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
      // Even the locally patched wxhelper can only say the function returned, not that WeChat
      // accepted the message. Every HTTP response therefore remains unknown pending reconciliation.
      return { status: 'RESULT_UNKNOWN' as const, receiptLevel: 'unknown' as const,
        correlationId: envelope.correlationId };
    },
  };
}
