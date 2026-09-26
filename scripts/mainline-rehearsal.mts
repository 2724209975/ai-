/** Drives the whole confirmation main line against a running core + WeChat bridge.
 *
 * It speaks the same HTTP surface the phone uses: login, resume, synthetic inbound push, wait for
 * the candidate, confirm, then observe what the bridge actually dispatched. Nothing here talks to
 * WeChat or claims real delivery — the bridge's helper endpoint is a fixture, so the expected
 * outcome of a confirmed part is RESULT_UNKNOWN plus a paused contact until an operator resolves it.
 *
 * Required env: DATABASE_URL (loopback only), OWNER_PASSWORD, WECHAT_INGRESS_TOKEN,
 * WECHAT_SPIKE_PEER. Optional: CORE_ORIGIN (default http://127.0.0.1:8787),
 * WECHAT_BRIDGE_URL (default http://127.0.0.1:19099), MAINLINE_TEXT, MAINLINE_TIMEOUT_MS.
 */
import { contentHash } from '../packages/orchestration/conversations/engine.mts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_ENV:${name}`);
  return value;
}
const databaseUrl = required('DATABASE_URL');
const parsed = new URL(databaseUrl);
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost'].includes(parsed.hostname))
  throw new Error('ISOLATED_DB_REQUIRED');
const coreOrigin = (process.env.CORE_ORIGIN?.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const bridgeUrl = (process.env.WECHAT_BRIDGE_URL?.trim() || 'http://127.0.0.1:19099').replace(/\/+$/, '');
const ingressToken = required('WECHAT_INGRESS_TOKEN');
const peer = required('WECHAT_SPIKE_PEER');
const selfRef = process.env.WECHAT_SELF_REF?.trim() || 'wxid_mainline_self';
const password = required('OWNER_PASSWORD');
const text = process.env.MAINLINE_TEXT?.trim() || '主线演练：在吗';
const timeoutMs = Number(process.env.MAINLINE_TIMEOUT_MS?.trim() || '20000');

type Session = { cookie: string; csrf: string };
async function call(session: Session | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; json: any; setCookie: string }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) { headers['content-type'] = 'application/json'; headers.origin = coreOrigin; }
  if (method !== 'GET') headers.origin = coreOrigin;
  if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.csrf; }
  const response = await fetch(`${coreOrigin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const textBody = await response.text();
  let json: any = undefined;
  try { json = textBody ? JSON.parse(textBody) : undefined; } catch { json = { raw: textBody.slice(0, 200) }; }
  return { status: response.status, json, setCookie: response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? '' };
}
async function steps(description: string, ready: (attempt: number) => Promise<any>, attempts = Math.ceil(timeoutMs / 500)): Promise<any> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const found = await ready(attempt);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`TIMEOUT:${description}`);
}
const log = (event: string, detail: Record<string, unknown> = {}): void =>
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
// Exit deliberately: a failure mid-flight would otherwise leave the keep-alive sockets from fetch
// to be torn down by the runtime, which aborts noisily on Windows.
for (const signal of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(signal, (cause: unknown) => {
    process.stderr.write(`rehearsal failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  });
}

if (new URL(coreOrigin).hostname !== '127.0.0.1' && new URL(coreOrigin).hostname !== 'localhost') throw new Error('CORE_ORIGIN_MUST_BE_LOOPBACK');
log('rehearsal_started', { coreOrigin, bridgeUrl, synthetic: true });

// 1. Log in exactly like the management app does.
const login = await call(undefined, 'POST', '/api/v1/session/login', { password });
if (login.status !== 200) throw new Error(`LOGIN_FAILED:${login.status}`);
log('logged_in', { ownerId: login.json?.ownerId, csrfPresent: Boolean(login.json?.csrfToken), sessionCookiePresent: Boolean(login.setCookie) });
const session: Session = { cookie: login.setCookie.split(';')[0]!, csrf: String(login.json?.csrfToken ?? '') };
if (!session.cookie || !session.csrf) throw new Error('SESSION_INCOMPLETE');

// 2. The core starts paused; the owner resumes explicitly, which is the only way work becomes sendable.
const overview = await call(session, 'GET', '/api/v1/overview');
if (overview.json?.globalPaused === true) {
  const resumed = await call(session, 'POST', '/api/v1/control/resume-all',
    { expectedVersion: overview.json.version, idempotencyKey: `rehearsal-resume-${Date.now()}` });
  if (resumed.status !== 200) throw new Error(`RESUME_FAILED:${resumed.status}:${resumed.json?.code ?? ''}`);
  log('resumed', { status: resumed.json?.status });
} else log('already_active', { version: overview.json?.version });

// 3. A synthetic wxhelper push, byte-shaped like the real one, so the receive path is the real one.
const messageId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 19).padEnd(19, '0');
const push = { fromUser: peer, toUser: selfRef, msgId: messageId, msgSequence: 1,
  createTime: Math.floor(Date.now() / 1000), type: 1, content: text };
const ingress = await fetch(`${bridgeUrl}/wxhelper/event?token=${ingressToken}`, { method: 'POST', body: JSON.stringify(push) });
log('inbound_pushed', { status: ingress.status, synthetic: true });
if (ingress.status !== 200) throw new Error(`INGRESS_REJECTED:${ingress.status}`);

// 4. Wait for the candidate the core generated for this contact.
const task = await steps('candidate', async () => {
  const tasks = await call(session, 'GET', '/api/v1/tasks');
  return tasks.json?.items?.find((item: any) => item.triggerMessages?.some((m: any) => m.text === text)) ?? null;
});
log('candidate_ready', { taskId: task.taskId, status: task.status, allowedActions: task.allowedActions,
  alternatives: task.alternatives?.length, parts: task.alternatives?.[0]?.parts?.length });
if (!task.allowedActions?.includes('confirmPlan')) throw new Error(`CONFIRM_NOT_ALLOWED:${task.allowedActions?.join(',')}`);

// 5. Confirm the first candidate unchanged, exactly as tapping the phone button would.
const alternative = task.alternatives[0];
const editedParts = alternative.parts.map((part: any) => ({ type: 'text', content: part.content }));
const confirmed = await call(session, 'POST', `/api/v1/tasks/${task.taskId}/confirm`, {
  taskVersion: task.taskVersion, planVersion: task.planVersion, alternativeId: alternative.alternativeId,
  editedParts, contentHash: contentHash(editedParts), idempotencyKey: `rehearsal-confirm-${Date.now()}`,
});
if (confirmed.status !== 200) throw new Error(`CONFIRM_FAILED:${confirmed.status}:${confirmed.json?.code ?? ''}`);
log('confirmed', { status: confirmed.json?.status, parts: editedParts.length });

// 6. The bridge, not the core, dispatches. With the fixture helper the outcome must be unknown.
const dispatched = await steps('dispatch', async () => {
  const conversations = await call(session, 'GET', '/api/v1/conversations');
  const conversation = conversations.json?.items?.[0];
  const send = conversation?.sends?.find((s: any) => s.status !== 'CREATED');
  return send ? { conversation, send } : null;
});
log('send_observed', { status: dispatched.send.status, receiptLevel: dispatched.send.receiptLevel,
  platformMessageId: dispatched.send.platformMessageId ?? null, pauseReasons: dispatched.conversation.pauseReasons });
if (dispatched.send.status !== 'RESULT_UNKNOWN') throw new Error(`UNEXPECTED_SEND_STATUS:${dispatched.send.status}`);

// 7. Unknown means blocked until a human checks the phone; that is the documented default.
if (!dispatched.conversation.pauseReasons?.includes('UNKNOWN_SEND')) throw new Error('CONTACT_NOT_PAUSED_FOR_UNKNOWN');
const resolved = await call(session, 'POST', `/api/v1/sends/${dispatched.send.sendTaskId}/resolve`, {
  status: 'DELIVERED', evidenceRef: 'rehearsal:fixture-endpoint-confirmed-by-operator',
  expectedVersion: dispatched.send.version, idempotencyKey: `rehearsal-resolve-${Date.now()}`,
});
if (resolved.status !== 200) throw new Error(`RESOLVE_FAILED:${resolved.status}:${resolved.json?.code ?? ''}`);
log('unknown_resolved', { status: resolved.json?.status, evidence: 'operator-check' });

// 8. Resolving never resumes on its own; the owner resumes the contact as a separate action, and
//    each resume clears exactly the reason it names — the same one-at-a-time model the phone uses.
const contacts = await call(session, 'GET', '/api/v1/contacts');
const contact = contacts.json?.items?.[0];
const reason = contact?.pauseReasons?.[0];
if (!reason) throw new Error('CONTACT_NOT_PAUSED');
const resumedContact = await call(session, 'POST', `/api/v1/contacts/${contact.id}/resumeContact`,
  { expectedVersion: contact.version, idempotencyKey: `rehearsal-resume-contact-${Date.now()}`, reason });
if (resumedContact.status !== 200) throw new Error(`CONTACT_RESUME_FAILED:${resumedContact.status}:${resumedContact.json?.code ?? ''}`);
const finalState = await call(session, 'GET', '/api/v1/conversations');
log('mainline_complete', { contactStatus: finalState.json?.items?.[0]?.status,
  pauseReasons: finalState.json?.items?.[0]?.pauseReasons, sends: finalState.json?.items?.[0]?.sends?.length });
if (finalState.json?.items?.[0]?.pauseReasons?.length) throw new Error('CONTACT_STILL_PAUSED');
