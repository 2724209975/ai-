/** Framework-independent receive handlers; they start no server and create no database.
 *
 * Two entry points, because real bridges differ: `ingestOneBotWebhook` verifies OneBot's
 * HMAC-SHA1 over the raw body, while NapCat's HTTP event push carries no signature field at all
 * (see docs/platforms/qq-spike-plan.md). A deployment that authenticates at the transport layer
 * instead — private network plus a bearer token, never a public listener — calls
 * `ingestAuthenticatedOneBotEvent`; supplying a signature we cannot verify would be theatre.
 */
import { decodePrivateEvent, verifyWebhook, WireError } from './onebot-codec.mts';
import type { WireObservation } from './onebot-codec.mts';

export type AtomicReceptionPort = {
  /** Infrastructure must atomically persist raw evidence + unique key + pending observation.
   * Resolve only after commit. Business consumers still need transactional inbox deduplication.
   */
  commitReceived(input: { dedupeKey: string; rawBytes: Uint8Array; observation: WireObservation }): Promise<'inserted' | 'duplicate'>;
};

export async function ingestOneBotWebhook(request: { body: Uint8Array; signature: unknown; selfIdHeader: unknown }, deps: {
  secret: string; expectedSelfId: string; rawEventRef: string; maxBodyBytes?: number;
  store: AtomicReceptionPort;
  resolveSelfPeer?: (authenticatedEvent: unknown) => string | undefined;
}): Promise<{ status: number; body: ''; outcome: string }> {
  try {
    const bytes = new Uint8Array(request.body);
    const authenticated = verifyWebhook(bytes, request.signature, deps.secret, deps.maxBodyBytes);
    return await ingestAuthenticatedOneBotEvent({ bytes, event: authenticated, selfIdHeader: request.selfIdHeader }, deps);
  } catch (error) {
    return failureResponse(error);
  }
}

/** For transports that already authenticated the caller. The bytes are never trusted as evidence. */
export async function ingestAuthenticatedOneBotEvent(request: { bytes: Uint8Array; event: unknown; selfIdHeader: unknown }, deps: {
  expectedSelfId: string; rawEventRef: string;
  store: AtomicReceptionPort;
  resolveSelfPeer?: (authenticatedEvent: unknown) => string | undefined;
}): Promise<{ status: number; body: ''; outcome: string }> {
  // The header is a transport convenience, not the identity proof: the body's `self_id` is
  // validated against expectedSelfId below. Bridges that omit the header are accepted; a present
  // but different header is rejected.
  if (request.selfIdHeader !== undefined && request.selfIdHeader !== deps.expectedSelfId) throw new WireError('FORBIDDEN');
  const observation = decodePrivateEvent(request.event, {
    expectedSelfId: deps.expectedSelfId, rawEventRef: deps.rawEventRef,
    selfMessagePeer: deps.resolveSelfPeer?.(request.event),
  });
  const result = await deps.store.commitReceived({ dedupeKey: observation.dedupeKey, rawBytes: request.bytes, observation });
  if (result !== 'inserted' && result !== 'duplicate') return { status: 503, body: '', outcome: 'PLATFORM_UNAVAILABLE' };
  // Never echo the event or return a OneBot quick-operation reply, even on duplicate delivery.
  return { status: 204, body: '', outcome: result };
}

/** Codes this system throws on purpose. Anything else stays opaque, because an upper-case message
 * could still be storage text (the ingress test pins that with a simulated 'SECRET_PRIVATE_SQL'). */
const INTERNAL_CODES = new Set([
  'VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_VERSION', 'STALE_CONTEXT', 'STALE_PLAN', 'POLICY_BLOCKED',
  'PAUSED', 'RECOVERY_REQUIRED', 'FORBIDDEN', 'UNAUTHENTICATED', 'UNSUPPORTED_CAPABILITY',
  'SEND_RESULT_UNKNOWN', 'PLATFORM_UNAVAILABLE', 'MEDIA_UNCERTAIN',
  'UNMAPPED_SELF_PAUSE_UNAVAILABLE', 'MOCK_AUTO_REQUIRES_MOCK_PLATFORM',
]);

/** Shared status mapping so both entry points answer identically. */
export function failureResponse(error: unknown): { status: number; body: ''; outcome: string } {
  if (error instanceof WireError) {
    // A conflicting replay can never succeed by retrying, so it is a client-visible conflict.
    const status = error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'FORBIDDEN' ? 403
      : error.code === 'CONFLICT_VERSION' ? 409 : error.code === 'UNSUPPORTED_CAPABILITY' ? 422 : 400;
    return { status, body: '', outcome: error.code };
  }
  // Storage/mapper exception may contain SQL, body text or credentials: the client never sees it.
  // Our own failures are thrown as bare upper-case codes, so those may be surfaced internally
  // (server-side log / operator diagnostics) while anything else stays opaque.
  const code = error instanceof Error && INTERNAL_CODES.has(error.message) ? error.message : 'PLATFORM_UNAVAILABLE';
  return { status: 503, body: '', outcome: code };
}
