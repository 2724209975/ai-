/** Offline research only: observations never become send receipts or origin attribution. */
import { decodeWxhelperPush, type WxObservation } from './wxhelper-codec.mts';

export type ReceiptEvidenceInput = { selfRef: string; peerRef: string; expectedText: string;
  startAt: string; endAt: string; baseline: Uint8Array[]; observed: Uint8Array[] };
function time(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('EVIDENCE_CONFIG_INVALID');
  return Date.parse(value);
}
export function analyzeReceiptEvidence(input: ReceiptEvidenceInput) {
  const start = time(input.startAt), end = time(input.endAt);
  if (end < start || end - start > 600_000 || typeof input.expectedText !== 'string' || !input.expectedText.trim()
    || Buffer.byteLength(input.expectedText) > 4096 || ![input.selfRef, input.peerRef].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(v))
    || input.selfRef === input.peerRef || ![input.baseline, input.observed].every(v => Array.isArray(v) && v.length <= 500)) throw new Error('EVIDENCE_CONFIG_INVALID');
  let totalBytes = 0;
  for (const bytes of [...input.baseline, ...input.observed]) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 1_048_576) throw new Error('EVIDENCE_CONFIG_INVALID');
    totalBytes += bytes.length;
  }
  if (totalBytes > 16_777_216) throw new Error('EVIDENCE_CONFIG_INVALID');
  const counts = { baseline: input.baseline.length, observed: input.observed.length, invalid: 0, duplicateObservations: 0,
    baselineMatches: 0, outsideWindow: 0, unrelated: 0, newMatchingIds: 0, conflictingIds: 0 };
  const baselineIds = new Set<string>(), fingerprints = new Map<string, string>(), conflicts = new Set<string>();
  const seenObserved = new Set<string>(), matching = new Set<string>();
  function decode(bytes: Uint8Array): WxObservation | undefined {
    try {
      const event = decodeWxhelperPush(bytes, { expectedSelfRef: input.selfRef, rawEventRef: 'bridge:evidence:00000000000000000000000000000000' });
      const fingerprint = JSON.stringify([event.kind, event.peerRef, event.typeCode, event.sentAt, event.contentRef, event.msgSequence]);
      const previous = fingerprints.get(event.platformMessageId);
      if (previous !== undefined && previous !== fingerprint) conflicts.add(event.platformMessageId);
      else fingerprints.set(event.platformMessageId, fingerprint);
      return event;
    } catch { counts.invalid++; return; }
  }
  for (const bytes of input.baseline) { const event = decode(bytes); if (event) baselineIds.add(event.platformMessageId); }
  // Platform timestamps have only second precision. This window is a screening aid, not causality.
  const startSecond = Math.floor(start / 1000) * 1000, endSecond = Math.floor(end / 1000) * 1000;
  for (const bytes of input.observed) {
    const event = decode(bytes); if (!event) continue;
    if (seenObserved.has(event.platformMessageId)) { counts.duplicateObservations++; continue; }
    seenObserved.add(event.platformMessageId);
    if (event.kind !== 'self' || event.peerRef !== input.peerRef || event.type !== 'text' || event.contentRef !== input.expectedText) { counts.unrelated++; continue; }
    if (baselineIds.has(event.platformMessageId)) { counts.baselineMatches++; continue; }
    if (Date.parse(event.sentAt) < startSecond || Date.parse(event.sentAt) > endSecond) { counts.outsideWindow++; continue; }
    matching.add(event.platformMessageId);
  }
  counts.conflictingIds = conflicts.size; counts.newMatchingIds = matching.size;
  const verdict = counts.invalid ? 'INCOMPLETE_INPUT' : conflicts.size ? 'CONFLICTING_IDS'
    : matching.size > 1 ? 'AMBIGUOUS' : matching.size === 1 ? 'UNIQUE_OBSERVATION' : 'NO_MATCH';
  return { schemaVersion: 1, verdict, counts, timestampPrecision: 'seconds', origin: 'unknown', receiptLevel: 'unknown',
    canResolveUnknownSend: false, canEnableAuto: false } as const;
}
