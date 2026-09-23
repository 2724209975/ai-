/** Account-scoped, transport-injected send executor. No login, network client or database included. */
import { createHash } from 'node:crypto';
import { decodeSendResponse, WireError } from './onebot-codec.mts';
import type { WireSendResult } from './onebot-codec.mts';

// These are private platform implementation ports, not a replacement for contracts/PlatformPort.
export type SendAttempt = {
  accountId: string; conversationId: string; sendTaskId: string; sendKey: string;
  correlationId: string; deadlineMs: number;
  assetBinding?: { assetRef: string; approvalVersion: string; sha256: string };
  wire: { action: 'send_private_msg'; params: { user_id: string; message: unknown[] }; echo: string };
};
export type AttemptResult = WireSendResult & { sendTaskId: string; correlationId: string; recorded: boolean };
export type AttemptJournal = {
  /** Atomically binds account/conversation/key/task/content, rejects key reuse conflicts,
   * and blocks new keys while this conversation has an unresolved attempt.
   * A newly claimed attempt must be durably SUBMITTING before returning 'claimed'.
   */
  claim(attempt: SendAttempt, fingerprint: string): Promise<{ kind: 'claimed' } | { kind: 'existing'; result: AttemptResult }>;
  /** Atomic/idempotent finish. Must preserve or escalate contradictory/late receipt evidence. */
  finish(attempt: SendAttempt, result: AttemptResult): Promise<void>;
};
export type SubmissionTransport = {
  /** Implementation submits exactly once. Abort is NOT proof that the platform cancelled. */
  submitOnce(wire: SendAttempt['wire'], signal: AbortSignal): Promise<{ correlation: 'echo' | 'http_response'; response: unknown }>;
};
type Gate = {
  /** 02 owns preflight, context/policy epochs and the dispatch lease across this call. */
  withDispatchLease<T>(attempt: SendAttempt, dispatch: () => Promise<T>): Promise<T>;
};
function canonical(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  return `{${Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
function valid(attempt: SendAttempt): void {
  if (!attempt || typeof attempt !== 'object') throw new WireError();
  if (![attempt.accountId, attempt.conversationId, attempt.sendTaskId, attempt.sendKey, attempt.correlationId].every(x => typeof x === 'string' && x.trim()) || !Number.isSafeInteger(attempt.deadlineMs)) throw new WireError();
  if (attempt.wire?.action !== 'send_private_msg' || !/^[1-9]\d*$/.test(attempt.wire.params?.user_id) || !Array.isArray(attempt.wire.params?.message) || !attempt.wire.params.message.length || typeof attempt.wire.echo !== 'string' || !attempt.wire.echo) throw new WireError();
  const segments = attempt.wire.params.message as { type: string; data: Record<string, unknown> }[];
  if (segments.length > 2) throw new WireError('UNSUPPORTED_CAPABILITY');
  if (segments.length === 2 && (segments[0]?.type !== 'reply' || !/^-?\d+$/.test(String(segments[0]?.data?.id)))) throw new WireError();
  const body = segments.at(-1)!;
  if (body?.type === 'text') {
    if (typeof body.data?.text !== 'string' || !body.data.text.trim() || attempt.assetBinding) throw new WireError();
  } else if (body?.type === 'image') {
    const binding = attempt.assetBinding;
    if (!binding?.assetRef || !binding.approvalVersion || !/^[a-f0-9]{64}$/.test(binding.sha256)) throw new WireError('POLICY_BLOCKED');
    const file = body.data?.file;
    if (typeof file !== 'string' || !file.startsWith('base64://')) throw new WireError('UNSUPPORTED_CAPABILITY');
    const encoded = file.slice(9); const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.toString('base64') !== encoded || createHash('sha256').update(bytes).digest('hex') !== binding.sha256) throw new WireError('CONFLICT_VERSION');
    // Approval freshness/target platform are independently checked by 02's dispatch gate.
  } else throw new WireError('UNSUPPORTED_CAPABILITY');
}

/** Only composition root/02 holds authority; no public route should expose this object. */
export class QqSendExecutor {
  #accountId: string;
  #authority: object;
  #transport: SubmissionTransport;
  #journal: AttemptJournal;
  #gate: Gate;
  #now: () => number;
  #timeoutMs: number;
  constructor(options: { accountId: string; authority: object; transport: SubmissionTransport; journal: AttemptJournal; gate: Gate; now?: () => number; timeoutMs?: number }) {
    if (!options.accountId || !Number.isSafeInteger(options.timeoutMs ?? 10000) || (options.timeoutMs ?? 10000) < 1) throw new WireError();
    this.#accountId = options.accountId; this.#authority = options.authority;
    this.#transport = options.transport; this.#journal = options.journal; this.#gate = options.gate;
    this.#now = options.now ?? Date.now; this.#timeoutMs = options.timeoutMs ?? 10000;
  }
  async execute(input: SendAttempt, authority: object): Promise<AttemptResult> {
    if (authority !== this.#authority) throw new WireError('FORBIDDEN');
    const attempt = structuredClone(input); valid(attempt);
    if (attempt.accountId !== this.#accountId) throw new WireError('FORBIDDEN');
    if (attempt.deadlineMs <= this.#now()) throw new WireError('STALE_PLAN');
    // The gate gets an independent copy, so it cannot accidentally mutate the hashed payload.
    return this.#gate.withDispatchLease(structuredClone(attempt), async () => {
      if (attempt.deadlineMs <= this.#now()) throw new WireError('STALE_PLAN');
      const fingerprint = createHash('sha256').update(canonical(attempt)).digest('hex');
      const claim = await this.#journal.claim(structuredClone(attempt), fingerprint);
      if (claim.kind === 'existing') return structuredClone(claim.result);
      if (claim.kind !== 'claimed') throw new WireError('PLATFORM_UNAVAILABLE');
      // Expiry during claim is proven pre-submit. Still retain the claim, never replay it.
      if (attempt.deadlineMs <= this.#now()) return this.#finish(attempt, {
        status: 'FAILED_DEFINITE', receiptLevel: 'unknown', retryable: false, reason: 'DEADLINE_EXPIRED_BEFORE_TRANSPORT',
      });
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<WireSendResult>(resolve => {
        timer = setTimeout(() => {
          resolve(this.#unknown('TRANSPORT_TIMEOUT'));
          controller.abort();
        }, Math.min(this.#timeoutMs, Math.max(1, attempt.deadlineMs - this.#now())));
      });
      // Transport failures can occur after the side effect. Do not infer definite failure.
      const request = Promise.resolve().then(() => this.#transport.submitOnce(structuredClone(attempt.wire), controller.signal))
        .then(r => decodeSendResponse(r.response, attempt.wire.echo, r.correlation), () => this.#unknown('TRANSPORT_ERROR'));
      try {
        return await this.#finish(attempt, await Promise.race([request, timeout]));
      } finally { if (timer) clearTimeout(timer); }
      // A response arriving after the timeout is not reused to send. Reconciliation must
      // query retained transport/platform evidence; the unknown journal entry remains blocked.
    });
  }
  #unknown(reason: string): WireSendResult { return { status: 'RESULT_UNKNOWN', receiptLevel: 'unknown', retryable: false, reason }; }
  async #finish(attempt: SendAttempt, wireResult: WireSendResult): Promise<AttemptResult> {
    const result: AttemptResult = { ...wireResult, sendTaskId: attempt.sendTaskId, correlationId: attempt.correlationId, recorded: true };
    try { await this.#journal.finish(structuredClone(attempt), structuredClone(result)); }
    catch {
      // Return observed platform evidence truthfully. The durable intent still blocks retry.
      result.recorded = false;
    }
    return result;
  }
}
