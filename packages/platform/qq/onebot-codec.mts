/** Pure OneBot 11 wire codec. No sockets, account login, dispatch, or public contract definitions. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

type Obj = Record<string, unknown>;
export class WireError extends Error {
  readonly code: string;
  constructor(code = 'VALIDATION_FAILED') { super(code); this.code = code; }
}
function obj(x: unknown): Obj {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new WireError();
  return x as Obj;
}
function str(x: unknown): string {
  if (typeof x !== 'string' || !x.trim()) throw new WireError();
  return x;
}
function externalId(x: unknown, signed = false): string {
  if (typeof x === 'number' && !Number.isSafeInteger(x)) throw new WireError();
  if (typeof x !== 'string' && typeof x !== 'number') throw new WireError();
  const s = String(x);
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(s)) throw new WireError();
  const id = BigInt(s);
  if (!signed && id <= 0n) throw new WireError();
  return id.toString();
}
function instant(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 253402300799) throw new WireError();
  return new Date(seconds * 1000).toISOString();
}

export type WirePart =
  | { kind: 'text'; text: string }
  | { kind: 'reply'; platformMessageId: string }
  | { kind: 'media'; mediaKind: 'image' | 'voice'; completeness: 'unknown'; animation: 'unknown'; originalEventRef: string; segmentIndex: number }
  | { kind: 'native_face'; faceId: string; completeness: 'unknown' }
  | { kind: 'unsupported'; segmentType: string; originalEventRef: string; segmentIndex: number };
export type WireMessage = {
  kind: 'message'; platform: 'qq'; externalAccountRef: string; externalContactRef: string;
  platformMessageId: string; sentAt: string; rawEventRef: string;
  direction: 'incoming' | 'self'; actor: 'contact' | 'unknown';
  parts: WirePart[]; dedupeKey: string; requiresReview: boolean;
};
export type WireObservation = WireMessage | {
  kind: 'recall'; platform: 'qq'; externalAccountRef: string; externalContactRef: string;
  platformMessageId: string; sentAt: string; rawEventRef: string; dedupeKey: string;
};

/** Transport layer must authenticate before calling. Inputs are never trusted owner evidence. */
export function decodePrivateEvent(input: unknown, context: {
  expectedSelfId: string; rawEventRef: string;
  // For implementation-specific message_sent: peer resolved by an audited bridge mapper.
  selfMessagePeer?: string;
}): WireObservation {
  const x = obj(input); const account = externalId(x.self_id);
  if (account !== externalId(context.expectedSelfId)) throw new WireError('FORBIDDEN');
  const rawEventRef = str(context.rawEventRef); const sentAt = instant(x.time);
  if (x.post_type === 'notice' && x.notice_type === 'friend_recall') {
    const peer = externalId(x.user_id); const message = externalId(x.message_id, true);
    if (peer === account) throw new WireError('UNSUPPORTED_CAPABILITY');
    return { kind: 'recall', platform: 'qq', externalAccountRef: account, externalContactRef: peer,
      platformMessageId: message, sentAt, rawEventRef, dedupeKey: JSON.stringify(['qq', account, peer, message, 'recall']) };
  }
  if (!['message', 'message_sent'].includes(String(x.post_type)) || x.message_type !== 'private' || x.sub_type !== 'friend') throw new WireError('UNSUPPORTED_CAPABILITY');
  const message = externalId(x.message_id, true); const sender = externalId(x.user_id);
  const self = x.post_type === 'message_sent' || sender === account;
  const peer = self ? externalId(context.selfMessagePeer) : sender;
  if (peer === account) throw new WireError('UNSUPPORTED_CAPABILITY');
  if (!Array.isArray(x.message)) throw new WireError('UNSUPPORTED_CAPABILITY'); // Require messagePostFormat=array; do not guess CQ strings.
  if (x.message.length === 0 || x.message.length > 256) throw new WireError();
  const parts: WirePart[] = x.message.map((v, index) => {
    const s = obj(v); const d = obj(s.data); const segmentType = str(s.type);
    switch (segmentType) {
      case 'text':
        if (typeof d.text !== 'string') throw new WireError();
        return { kind: 'text', text: d.text };
      case 'reply': return { kind: 'reply', platformMessageId: externalId(d.id, true) };
      case 'face': {
        const faceId = externalId(d.id, true);
        if (BigInt(faceId) < 0n) throw new WireError();
        return { kind: 'native_face', faceId, completeness: 'unknown' };
      }
      case 'image': case 'record':
        // CDN URLs/keys stay in private raw-event storage. No URL fetch and no inferred completeness.
        str(d.file);
        return { kind: 'media', mediaKind: segmentType === 'record' ? 'voice' : 'image',
          completeness: 'unknown', animation: 'unknown', originalEventRef: rawEventRef, segmentIndex: index };
      default: return { kind: 'unsupported', segmentType, originalEventRef: rawEventRef, segmentIndex: index };
    }
  });
  return { kind: 'message', platform: 'qq', externalAccountRef: account, externalContactRef: peer,
    platformMessageId: message, sentAt, rawEventRef, direction: self ? 'self' : 'incoming', actor: self ? 'unknown' : 'contact',
    parts, dedupeKey: JSON.stringify(['qq', account, peer, message, 'message']),
    requiresReview: self || parts.some(p => p.kind !== 'text' && p.kind !== 'reply') };
}

/** Original byte verification; signature authenticates content, not freshness or uniqueness. */
export function verifyWebhook(body: Uint8Array, signature: unknown, secret: string, maxBytes = 1_048_576): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || body.byteLength > maxBytes) throw new WireError();
  if (!secret || typeof signature !== 'string' || !/^sha1=[a-fA-F0-9]{40}$/.test(signature)) throw new WireError('UNAUTHENTICATED');
  const expected = createHmac('sha1', secret).update(body).digest();
  const supplied = Buffer.from(signature.slice(5), 'hex');
  if (!timingSafeEqual(expected, supplied)) throw new WireError('UNAUTHENTICATED');
  try { return obj(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))); }
  catch { throw new WireError(); }
}

export type PreparedPart = { kind: 'text'; text: string } | { kind: 'approved_sticker'; assetRef: string; expectedSha256: string; approvalVersion: string };
export type ApprovedSticker = {
  assetRef: string; approvalVersion: string; approved: boolean; allowedPlatforms: string[];
  sha256: string; bytes: Uint8Array; mime: string; animation: 'static' | 'animated';
};
/** Encoding is NOT authorization. Only a future guarded 02 dispatch may submit this wire request. */
export function encodePrivateSend(input: { peerId: string; rpcId: string; part: PreparedPart; replyTo?: string }, options: {
  loadApprovedSticker: (ref: string) => ApprovedSticker | undefined;
  supportedStickerFormats: readonly string[]; maxTextBytes: number; maxMediaBytes: number;
}) {
  const peer = externalId(input.peerId); const rpcId = str(input.rpcId);
  if (![options.maxTextBytes, options.maxMediaBytes].every(v => Number.isSafeInteger(v) && v > 0)) throw new WireError();
  const segments: { type: string; data: Record<string, string> }[] = [];
  if (input.replyTo !== undefined) segments.push({ type: 'reply', data: { id: externalId(input.replyTo, true) } });
  if (input.part.kind === 'text') {
    const text = str(input.part.text);
    if (Buffer.byteLength(text) > options.maxTextBytes) throw new WireError();
    segments.push({ type: 'text', data: { text } }); // CQ-looking content remains literal text.
  } else if (input.part.kind === 'approved_sticker') {
    const part = input.part; const asset = options.loadApprovedSticker(str(part.assetRef));
    if (!asset || asset.approved !== true || !asset.allowedPlatforms.includes('qq') || asset.assetRef !== part.assetRef || !part.approvalVersion || asset.approvalVersion !== part.approvalVersion) throw new WireError('POLICY_BLOCKED');
    const bytes = new Uint8Array(asset.bytes); // Freeze the bytes used for hashing/encoding.
    if (!/^[a-f0-9]{64}$/.test(part.expectedSha256) || asset.sha256 !== part.expectedSha256 || createHash('sha256').update(bytes).digest('hex') !== part.expectedSha256) throw new WireError('CONFLICT_VERSION');
    if (!bytes.length || bytes.length > options.maxMediaBytes) throw new WireError();
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mime) || !options.supportedStickerFormats.includes(`${asset.mime}:${asset.animation}`)) throw new WireError('UNSUPPORTED_CAPABILITY');
    segments.push({ type: 'image', data: { file: `base64://${Buffer.from(bytes).toString('base64')}` } });
  } else throw new WireError('UNSUPPORTED_CAPABILITY');
  return { action: 'send_private_msg', params: { user_id: peer, message: segments }, echo: rpcId };
}

export type WireSendResult = {
  status: 'SUBMITTED' | 'RESULT_UNKNOWN' | 'FAILED_DEFINITE';
  receiptLevel: 'accepted' | 'unknown'; retryable: false;
  platformMessageId?: string; reason: string;
};
/** HTTP replies are paired by the transport's request/response promise; WS replies require echo. */
export function decodeSendResponse(response: unknown, rpcId: string, correlation: 'echo' | 'http_response' = 'echo'): WireSendResult {
  const unknown = (reason: string): WireSendResult => ({ status: 'RESULT_UNKNOWN', receiptLevel: 'unknown', retryable: false, reason });
  try {
    const r = obj(response);
    if (correlation !== 'echo' && correlation !== 'http_response') return unknown('RPC_CORRELATION_MISMATCH');
    if (correlation === 'echo' ? r.echo !== str(rpcId) : r.echo !== undefined && r.echo !== str(rpcId)) return unknown('RPC_CORRELATION_MISMATCH');
    if (r.status === 'ok' && r.retcode === 0) {
      const messageId = externalId(obj(r.data).message_id, true);
      return { status: 'SUBMITTED', receiptLevel: 'accepted', platformMessageId: messageId, retryable: false, reason: 'BRIDGE_ACCEPTED_NOT_DELIVERY_PROOF' };
    }
    if (r.status === 'async' && r.retcode === 1) return unknown('ASYNC_COMPLETION_UNKNOWN');
    // Bridge-specific failure codes may have occurred after submission; no generic definite failure.
    return unknown('UNVERIFIED_BRIDGE_FAILURE');
  } catch { return unknown('INVALID_RESPONSE'); }
}
