/** Read-only evidence summary. Never returns message text, identifiers, paths or digests. */
import { decodeWxhelperPush } from './wxhelper-codec.mts';

export function createWxOriginAudit(options: { selfRef: string; peerRef: string; marker: string }) {
  if (!options.selfRef || !options.peerRef || !options.marker.trim()) throw new Error('INVALID_AUDIT_CONFIG');
  const result = {
    inspected: 0, invalid: 0, incomingTextFromKnownPeer: 0,
    selfTextToKnownPeer: 0, selfTextToOtherPeer: 0,
    selfType51OperationShape: 0, other: 0,
    marker: { contentExact: 0, contentContains: 0, displayContains: 0, signatureContains: 0,
      exactSelfTextToKnownPeer: 0 },
  };
  return {
    add(bytes: Uint8Array): void {
      result.inspected++;
      try {
        // Reuse wire validation, including duplicate critical fields and lossless 64-bit IDs.
        decodeWxhelperPush(bytes, { expectedSelfRef: options.selfRef,
          rawEventRef: 'bridge:audit:00000000000000000000000000000000' });
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const self = body.fromUser === options.selfRef;
        const known = body.toUser === options.peerRef;
        const content = typeof body.content === 'string' ? body.content : '';
        const exact = content === options.marker;
        if (exact) result.marker.contentExact++;
        if (content.includes(options.marker)) result.marker.contentContains++;
        if (typeof body.displayFullContent === 'string' && body.displayFullContent.includes(options.marker))
          result.marker.displayContains++;
        if (typeof body.signature === 'string' && body.signature.includes(options.marker))
          result.marker.signatureContains++;
        if (self && known && body.type === 1 && exact) result.marker.exactSelfTextToKnownPeer++;
        if (!self && body.fromUser === options.peerRef && body.type === 1) result.incomingTextFromKnownPeer++;
        else if (self && body.type === 1) {
          if (known) result.selfTextToKnownPeer++; else result.selfTextToOtherPeer++;
        } else if (self && body.type === 51 && /^\s*<msg>\s*<op\s/.test(content))
          result.selfType51OperationShape++;
        else result.other++;
      } catch { result.invalid++; }
    },
    summary() { return structuredClone(result); },
  };
}
