/** Owner session endpoints: login, describe, logout. Mounted before the authenticated API.
 * Login is the only unauthenticated write; it is protected by an exact Origin check and rate limiting.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { OwnerAuthService, OwnerSession } from '../../packages/infrastructure/auth/owner-auth.mts';

export type OwnerSessionHandlerDeps = {
  auth: OwnerAuthService;
  /** Behind a reverse proxy this must derive the caller from a trusted header set by that proxy. */
  clientKey?(request: IncomingMessage): string;
  maxBodyBytes?: number;
};

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString();
    if (text.length > maxBytes) throw new Error('VALIDATION_FAILED');
  }
  try { return JSON.parse(text); } catch { throw new Error('VALIDATION_FAILED'); }
}

/** Returns true when the request belonged to this handler. */
export function createOwnerSessionHandler(deps: OwnerSessionHandlerDeps) {
  const auth = deps.auth;
  const maxBodyBytes = deps.maxBodyBytes ?? 4096;
  if (!auth) throw new Error('OWNER_SESSION_HANDLER_REQUIRES_AUTH');
  const clientKey = deps.clientKey ?? ((request: IncomingMessage) => request.socket?.remoteAddress ?? 'unknown');
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const correlationId = randomUUID();
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!path.startsWith('/api/v1/session')) return false;
    const method = request.method ?? 'GET';
    try {
      if (path === '/api/v1/session/login') {
        if (method !== 'POST') { send(response, 405, { code: 'VALIDATION_FAILED', message: 'METHOD_NOT_ALLOWED', retryable: false, correlationId }); return true; }
        if (!auth.isAllowedOrigin(request.headers.origin)) { send(response, 403, { code: 'FORBIDDEN', message: 'ORIGIN_NOT_ALLOWED', retryable: false, correlationId }); return true; }
        let body: unknown;
        try { body = await readJsonBody(request, maxBodyBytes); } catch { send(response, 400, { code: 'VALIDATION_FAILED', message: 'INVALID_BODY', retryable: false, correlationId }); return true; }
        const password = body && typeof body === 'object' ? (body as Record<string, unknown>).password : undefined;
        if (typeof password !== 'string') { send(response, 400, { code: 'VALIDATION_FAILED', message: 'PASSWORD_REQUIRED', retryable: false, correlationId }); return true; }
        const result = await auth.login({ password, clientKey: clientKey(request) });
        if (!result.ok) {
          if (result.code === 'RATE_LIMITED') {
            send(response, 429, { code: 'RATE_LIMITED', message: '尝试次数过多，请稍后再试。', retryable: true, correlationId },
              { 'Retry-After': String(result.retryAfterSeconds ?? 60) });
            return true;
          }
          if (result.code === 'VALIDATION_FAILED') { send(response, 400, { code: 'VALIDATION_FAILED', message: 'VALIDATION_FAILED', retryable: false, correlationId }); return true; }
          send(response, 401, { code: 'UNAUTHENTICATED', message: '登录失败。', retryable: false, correlationId });
          return true;
        }
        send(response, 200, { ownerId: result.session.ownerId, csrfToken: result.csrfToken, expiresAt: result.expiresAt, correlationId },
          { 'Set-Cookie': result.setCookie });
        return true;
      }
      const session: OwnerSession | null = await auth.authenticateRequest(request);
      if (!session) { send(response, 401, { code: 'UNAUTHENTICATED', message: '需要登录。', retryable: false, correlationId }); return true; }
      if (path === '/api/v1/session' && method === 'GET') {
        send(response, 200, { ...auth.describe(session), correlationId });
        return true;
      }
      if (path === '/api/v1/session/logout' && method === 'POST') {
        if (!auth.isAllowedOrigin(request.headers.origin)) { send(response, 403, { code: 'FORBIDDEN', message: 'ORIGIN_NOT_ALLOWED', retryable: false, correlationId }); return true; }
        await auth.logout(session);
        send(response, 200, { status: 'SIGNED_OUT', correlationId }, { 'Set-Cookie': auth.clearCookie() });
        return true;
      }
      send(response, 404, { code: 'NOT_FOUND', message: 'NOT_FOUND', retryable: false, correlationId });
      return true;
    } catch {
      // Never surface storage or crypto internals to the client.
      send(response, 503, { code: 'PLATFORM_UNAVAILABLE', message: '服务暂不可用，请稍后重试。', retryable: true, correlationId });
      return true;
    }
  };
}
