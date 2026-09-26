/** Record the owner's manual check of one unknown send, through the owner API.
 *
 * A `RESULT_UNKNOWN` part blocks its contact: the platform never proved delivery, so nothing may be
 * retried and the contact cannot be resumed until the owner states what they checked. This is the
 * operator entry point for that statement until the management page grows the same action.
 *
 * Required env: OWNER_PASSWORD, SEND_TASK_ID, SEND_STATUS (`DELIVERED` | `FAILED_DEFINITE`),
 * EVIDENCE_REF. Optional: CORE_ORIGIN (default http://127.0.0.1:8787), PLATFORM_MESSAGE_ID.
 */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_ENV:${name}`);
  return value;
}
const origin = (process.env.CORE_ORIGIN?.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ifOriginIsLoopback = new URL(origin);
if (!['127.0.0.1', 'localhost'].includes(ifOriginIsLoopback.hostname)) throw new Error('CORE_ORIGIN_MUST_BE_LOOPBACK');
const password = required('OWNER_PASSWORD');
const sendTaskId = required('SEND_TASK_ID');
const status = required('SEND_STATUS');
if (!['DELIVERED', 'FAILED_DEFINITE'].includes(status)) throw new Error('SEND_STATUS_MUST_BE_DELIVERED_OR_FAILED_DEFINITE');
const evidenceRef = required('EVIDENCE_REF');
const platformMessageId = process.env.PLATFORM_MESSAGE_ID?.trim();

const log = (event: string, detail: Record<string, unknown> = {}): void =>
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
for (const signal of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(signal, (cause: unknown) => {
    process.stderr.write(`resolve failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  });
}

const login = await fetch(`${origin}/api/v1/session/login`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password }) });
if (login.status !== 200) throw new Error(`LOGIN_FAILED:${login.status}`);
const { csrfToken } = await login.json() as { csrfToken: string };
const cookie = login.headers.getSetCookie?.()[0]?.split(';')[0] ?? '';
if (!cookie || !csrfToken) throw new Error('SESSION_INCOMPLETE');
const headers = { 'Content-Type': 'application/json', Origin: origin, cookie, 'x-csrf-token': csrfToken };

// The version is read from the projection so the command cannot be replayed against a stale part.
const conversations = await (await fetch(`${origin}/api/v1/conversations`, { headers: { cookie } })).json() as {
  items: { contactName: string; sends: { sendTaskId: string; version: number; status: string; sequence: number }[] }[] };
const found = conversations.items.flatMap(item => item.sends.map(send => ({ ...send, contactName: item.contactName })))
  .find(send => send.sendTaskId === sendTaskId);
if (!found) throw new Error('SEND_NOT_FOUND_IN_PROJECTION');
if (found.status !== 'RESULT_UNKNOWN') throw new Error(`SEND_IS_NOT_UNKNOWN:${found.status}`);
log('unknown_send_found', { sendTaskId, sequence: found.sequence, version: found.version, contactName: found.contactName });

const resolved = await fetch(`${origin}/api/v1/sends/${sendTaskId}/resolve`, { method: 'POST', headers,
  body: JSON.stringify({ status, evidenceRef, expectedVersion: found.version,
    idempotencyKey: `owner-resolve-${Date.now()}`, ...(platformMessageId ? { platformMessageId } : {}) }) });
const body = await resolved.text();
if (resolved.status !== 200) throw new Error(`RESOLVE_FAILED:${resolved.status}:${body.slice(0, 200)}`);
log('unknown_send_resolved', { status: JSON.parse(body).status, evidenceRefPresent: true, platformMessageIdPresent: Boolean(platformMessageId) });
log('next_step', { note: 'resuming the contact is a separate owner action; the platform never proved delivery' });
