/** Framework-independent receive handler; does not start a server or create a database. */
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
    if (request.selfIdHeader !== deps.expectedSelfId) throw new WireError('FORBIDDEN');
    const observation = decodePrivateEvent(authenticated, {
      expectedSelfId: deps.expectedSelfId, rawEventRef: deps.rawEventRef,
      selfMessagePeer: deps.resolveSelfPeer?.(authenticated),
    });
    const result = await deps.store.commitReceived({ dedupeKey: observation.dedupeKey, rawBytes: bytes, observation });
    if (result !== 'inserted' && result !== 'duplicate') return { status: 503, body: '', outcome: 'PLATFORM_UNAVAILABLE' };
    // Never echo the event or return a OneBot quick-operation reply, even on duplicate delivery.
    return { status: 204, body: '', outcome: result };
  } catch (error) {
    if (error instanceof WireError) {
      const status = error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'FORBIDDEN' ? 403 : error.code === 'UNSUPPORTED_CAPABILITY' ? 422 : 400;
      return { status, body: '', outcome: error.code };
    }
    // Storage/mapper exception may contain SQL, body text or credentials: never surface it.
    return { status: 503, body: '', outcome: 'PLATFORM_UNAVAILABLE' };
  }
}
