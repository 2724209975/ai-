/** Single-owner authentication: scrypt password check, durable session cookie, CSRF and Origin checks.
 * The service never stores the cookie token, only its SHA-256, and never returns why a login failed.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isPasswordHash, verifyPassword } from './password.mts';
import type { OwnerSession, OwnerSessionStore } from './session-store.mts';

export type OwnerAuthConfig = Readonly<{
  ownerId: string;
  passwordHash: string;
  store: OwnerSessionStore;
  /** Exact origins allowed for state-changing requests, e.g. https://chat.example.com */
  allowedOrigins: readonly string[];
  cookieName?: string;
  secureCookies?: boolean;
  sessionTtlMs?: number;
  idleTtlMs?: number;
  loginWindowMs?: number;
  maxFailedLogins?: number;
  now?: () => number;
}>;

export type LoginFailure = Readonly<{ ok: false; code: 'UNAUTHENTICATED' | 'RATE_LIMITED' | 'VALIDATION_FAILED'; retryAfterSeconds?: number }>;
export type LoginSuccess = Readonly<{ ok: true; session: OwnerSession; setCookie: string; csrfToken: string; expiresAt: string }>;
export const DEFAULT_COOKIE_NAME = 'owner_session';
const TOUCH_INTERVAL_MS = 60_000;
const MIN_SESSION_TTL_MS = 60_000;
const MAX_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function constantTimeEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (typeof header !== 'string' || !header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name || name in jar) continue;
    jar[name] = value;
  }
  return jar;
}

export function tokenHashOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class OwnerAuthService {
  readonly #ownerId: string;
  readonly #passwordHash: string;
  readonly #store: OwnerSessionStore;
  readonly #allowedOrigins: readonly string[];
  readonly #cookieName: string;
  readonly #secure: boolean;
  readonly #sessionTtlMs: number;
  readonly #idleTtlMs: number;
  readonly #loginWindowMs: number;
  readonly #maxFailedLogins: number;
  readonly #now: () => number;
  readonly #failures = new Map<string, { count: number; windowStart: number }>();

  constructor(config: OwnerAuthConfig) {
    if (!config?.ownerId?.trim() || !isPasswordHash(config.passwordHash)) throw new Error('OWNER_AUTH_CONFIG_INVALID');
    if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.some(origin => !/^https?:\/\/[^/]+$/.test(origin))) throw new Error('OWNER_AUTH_CONFIG_INVALID');
    const sessionTtlMs = config.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    const idleTtlMs = config.idleTtlMs ?? sessionTtlMs;
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < MIN_SESSION_TTL_MS || sessionTtlMs > MAX_SESSION_TTL_MS) throw new Error('OWNER_AUTH_CONFIG_INVALID');
    if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < MIN_SESSION_TTL_MS || idleTtlMs > sessionTtlMs) throw new Error('OWNER_AUTH_CONFIG_INVALID');
    const maxFailedLogins = config.maxFailedLogins ?? 5;
    if (!Number.isSafeInteger(maxFailedLogins) || maxFailedLogins < 1 || maxFailedLogins > 100) throw new Error('OWNER_AUTH_CONFIG_INVALID');
    this.#ownerId = config.ownerId;
    this.#passwordHash = config.passwordHash;
    this.#store = config.store;
    this.#allowedOrigins = [...config.allowedOrigins];
    this.#cookieName = config.cookieName ?? DEFAULT_COOKIE_NAME;
    this.#secure = config.secureCookies ?? true;
    this.#sessionTtlMs = sessionTtlMs;
    this.#idleTtlMs = idleTtlMs;
    this.#loginWindowMs = config.loginWindowMs ?? 15 * 60 * 1000;
    this.#maxFailedLogins = maxFailedLogins;
    this.#now = config.now ?? Date.now;
  }

  get cookieName(): string { return this.#cookieName; }
  #iso(at: number): string { return new Date(at).toISOString(); }
  #cookie(value: string, maxAgeSeconds: number): string {
    const parts = [`${this.#cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (this.#secure) parts.push('Secure');
    return parts.join('; ');
  }
  clearCookie(): string { return `${this.#cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.#secure ? '; Secure' : ''}`; }
  isAllowedOrigin(origin: unknown): boolean {
    return typeof origin === 'string' && this.#allowedOrigins.includes(origin);
  }
  allowedOrigins(): readonly string[] { return [...this.#allowedOrigins]; }

  /** Fixed-window limiter keyed by the caller's network identity; a restart clears it by design. */
  #limiter(clientKey: string): { blocked: boolean; retryAfterSeconds: number } {
    const entry = this.#failures.get(clientKey);
    const at = this.#now();
    if (!entry) return { blocked: false, retryAfterSeconds: 0 };
    if (at - entry.windowStart >= this.#loginWindowMs) { this.#failures.delete(clientKey); return { blocked: false, retryAfterSeconds: 0 }; }
    if (entry.count < this.#maxFailedLogins) return { blocked: false, retryAfterSeconds: 0 };
    return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.windowStart + this.#loginWindowMs - at) / 1000)) };
  }
  #recordFailure(clientKey: string): void {
    const at = this.#now();
    const entry = this.#failures.get(clientKey);
    if (!entry || at - entry.windowStart >= this.#loginWindowMs) this.#failures.set(clientKey, { count: 1, windowStart: at });
    else this.#failures.set(clientKey, { count: entry.count + 1, windowStart: entry.windowStart });
  }

  async login(input: { password: unknown; clientKey: string }): Promise<LoginSuccess | LoginFailure> {
    if (typeof input?.password !== 'string' || !input.clientKey) return { ok: false, code: 'VALIDATION_FAILED' };
    const limit = this.#limiter(input.clientKey);
    if (limit.blocked) return { ok: false, code: 'RATE_LIMITED', retryAfterSeconds: limit.retryAfterSeconds };
    if (!(await verifyPassword(input.password, this.#passwordHash))) {
      this.#recordFailure(input.clientKey);
      return { ok: false, code: 'UNAUTHENTICATED' };
    }
    this.#failures.delete(input.clientKey);
    const at = this.#now();
    const token = randomBytes(32).toString('base64url');
    const session: OwnerSession = {
      id: randomUUID(),
      ownerId: this.#ownerId,
      tokenHash: tokenHashOf(token),
      csrfToken: randomBytes(32).toString('base64url'),
      createdAt: this.#iso(at),
      lastSeenAt: this.#iso(at),
      idleExpiresAt: this.#iso(at + this.#idleTtlMs),
      absoluteExpiresAt: this.#iso(at + this.#sessionTtlMs),
      revokedAt: null,
    };
    await this.#store.create(session);
    const maxAge = Math.floor(this.#sessionTtlMs / 1000);
    return { ok: true, session, setCookie: this.#cookie(token, maxAge), csrfToken: session.csrfToken, expiresAt: session.absoluteExpiresAt };
  }

  /** Returns null for missing, forged, revoked, idle-expired or absolutely expired sessions. */
  async authenticateRequest(request: IncomingMessage): Promise<OwnerSession | null> {
    const token = parseCookieHeader(request?.headers?.cookie)?.[this.#cookieName];
    if (!token) return null;
    const session = await this.#store.get(tokenHashOf(token));
    if (!session || session.ownerId !== this.#ownerId || session.revokedAt) return null;
    const at = this.#now();
    if (Date.parse(session.absoluteExpiresAt) <= at || Date.parse(session.idleExpiresAt) <= at) {
      await this.#store.update({ ...session, revokedAt: this.#iso(at) });
      return null;
    }
    if (at - Date.parse(session.lastSeenAt) >= TOUCH_INTERVAL_MS) {
      const touched: OwnerSession = { ...session, lastSeenAt: this.#iso(at), idleExpiresAt: this.#iso(Math.min(at + this.#idleTtlMs, Date.parse(session.absoluteExpiresAt))) };
      await this.#store.update(touched);
      return touched;
    }
    return session;
  }

  /** State changes require an allowed Origin, a JSON body and a session-bound CSRF token. */
  verifyWrite(request: IncomingMessage, session: OwnerSession | null): boolean {
    if (!session?.csrfToken) return false;
    if (!this.isAllowedOrigin(request?.headers?.origin)) return false;
    const contentType = String(request?.headers?.['content-type'] ?? '');
    if (!contentType.toLowerCase().startsWith('application/json')) return false;
    const header = request?.headers?.['x-csrf-token'];
    const supplied = Array.isArray(header) ? header[0] : header;
    return typeof supplied === 'string' && constantTimeEquals(supplied, session.csrfToken);
  }

  async logout(session: OwnerSession | null): Promise<boolean> {
    if (!session) return false;
    await this.#store.update({ ...session, revokedAt: this.#iso(this.#now()) });
    return true;
  }

  describe(session: OwnerSession): { ownerId: string; csrfToken: string; expiresAt: string } {
    return { ownerId: session.ownerId, csrfToken: session.csrfToken, expiresAt: session.absoluteExpiresAt };
  }

  /** Owner-side revocation of every active session (lost device, suspected leak). */
  async revokeAll(): Promise<number> {
    return this.#store.revokeAllForOwner(this.#ownerId, this.#iso(this.#now()));
  }

  async pruneExpired(): Promise<number> {
    return this.#store.prune(this.#iso(this.#now()));
  }
}

/** Adapter for the Owner HTTP handler's injected security dependencies. */
export function createOwnerAuthDependencies(auth: OwnerAuthService) {
  return {
    authenticate: (request: IncomingMessage) => auth.authenticateRequest(request),
    verifyWrite: (request: IncomingMessage, session: OwnerSession) => auth.verifyWrite(request, session),
  };
}
