/** Single-owner authentication: password policy, session lifecycle, CSRF/Origin and rate limiting. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { hashPassword, isPasswordHash, verifyPassword } from './password.mts';
import { FileOwnerSessionStore } from './session-store.mts';
import { DEFAULT_COOKIE_NAME, OwnerAuthService, parseCookieHeader, tokenHashOf, type OwnerAuthConfig } from './owner-auth.mts';

const ORIGIN = 'https://chat.example.test';
const PASSWORD = 'correct horse battery staple';

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'owner-auth-'));
  try { await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function request(input: { cookie?: string; origin?: string; csrf?: string; contentType?: string; method?: string }): IncomingMessage {
  return {
    method: input.method ?? 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.csrf ? { 'x-csrf-token': input.csrf } : {}),
      ...(input.contentType ? { 'content-type': input.contentType } : {}),
    },
  } as unknown as IncomingMessage;
}

function cookieValue(setCookie: string, name = DEFAULT_COOKIE_NAME): string {
  const match = new RegExp(`${name}=([^;]*)`).exec(setCookie);
  assert.ok(match, `cookie ${name} missing in ${setCookie}`);
  return match[1]!;
}

async function service(dir: string, clock: { at: number }, overrides: Partial<OwnerAuthConfig> = {}): Promise<OwnerAuthService> {
  return new OwnerAuthService({
    ownerId: 'owner-1',
    passwordHash: await hashPassword(PASSWORD),
    store: new FileOwnerSessionStore(dir),
    allowedOrigins: [ORIGIN],
    secureCookies: true,
    sessionTtlMs: 3_600_000,
    idleTtlMs: 600_000,
    loginWindowMs: 900_000,
    maxFailedLogins: 5,
    now: () => clock.at,
    ...overrides,
  });
}

test('password hashes are salted scrypt values that reject wrong or tampered input', async () => {
  const first = await hashPassword(PASSWORD);
  const second = await hashPassword(PASSWORD);
  assert.ok(isPasswordHash(first));
  assert.notEqual(first, second, 'each hash uses a fresh salt');
  assert.ok(!first.includes(PASSWORD), 'plaintext must not appear in the hash');
  assert.equal(await verifyPassword(PASSWORD, first), true);
  assert.equal(await verifyPassword(`${PASSWORD} `, first), false);
  assert.equal(await verifyPassword(PASSWORD, first.replace('N=32768', 'N=131072')), false, 'hostile cost parameters are rejected');
  assert.equal(await verifyPassword(PASSWORD, 'scrypt$$$'), false);
  assert.equal(await verifyPassword(PASSWORD, 'not-a-hash'), false);
  await assert.rejects(() => hashPassword('short'), { message: 'VALIDATION_FAILED' });
});

test('login issues an httpOnly session cookie and never stores the token itself', async () => {
  await withDir(async dir => {
    const clock = { at: Date.parse('2026-09-23T10:00:00Z') };
    const auth = await service(dir, clock);
    const result = await auth.login({ password: PASSWORD, clientKey: '127.0.0.1' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.setCookie, /HttpOnly/);
    assert.match(result.setCookie, /SameSite=Strict/);
    assert.match(result.setCookie, /Path=\//);
    assert.match(result.setCookie, /Secure/);
    const token = cookieValue(result.setCookie);
    assert.ok(token.length >= 32);
    assert.notEqual(token, tokenHashOf(token));
    assert.ok(!result.setCookie.includes('csrf'), 'CSRF token must not ride in the cookie');

    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const stored = await readFile(join(dir, files[0]!), 'utf8');
    assert.ok(!stored.includes(token), 'the raw session token must not be persisted');
    assert.equal(stored.includes(tokenHashOf(token)), true);

    const session = await auth.authenticateRequest(request({ cookie: `${DEFAULT_COOKIE_NAME}=${token}` }));
    assert.equal(session?.ownerId, 'owner-1');
    assert.equal(auth.describe(session!).csrfToken, result.csrfToken);
    assert.equal(await auth.authenticateRequest(request({ cookie: `${DEFAULT_COOKIE_NAME}=forged-token` })), null);
    assert.equal(await auth.authenticateRequest(request({})), null);
  });
});

test('logout, idle timeout and absolute timeout all stop authorizing the session', async () => {
  await withDir(async dir => {
    const clock = { at: Date.parse('2026-09-23T10:00:00Z') };
    const auth = await service(dir, clock);
    const login = async () => {
      const result = await auth.login({ password: PASSWORD, clientKey: '127.0.0.1' });
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error('login failed');
      return request({ cookie: `${DEFAULT_COOKIE_NAME}=${cookieValue(result.setCookie)}` });
    };

    const first = await login();
    const session = await auth.authenticateRequest(first);
    assert.equal(await auth.logout(session), true);
    assert.equal(await auth.authenticateRequest(first), null, 'a revoked session is refused');
    assert.equal(await auth.logout(null), false);

    const idle = await login();
    clock.at += 601_000;
    assert.equal(await auth.authenticateRequest(idle), null, 'idle expiry refuses the session');

    const idle2 = await login();
    clock.at += 1_000;
    assert.ok(await auth.authenticateRequest(idle2), 'activity before the idle window keeps the session');
    clock.at += 3_600_000;
    assert.equal(await auth.authenticateRequest(idle2), null, 'absolute expiry refuses the session');

    clock.at += 1;
    assert.ok(await auth.pruneExpired() >= 1);
    assert.equal((await readdir(dir)).length, 0);
  });
});

test('repeated wrong passwords are rate limited while the correct one still counts once', async () => {
  await withDir(async dir => {
    const clock = { at: Date.parse('2026-09-23T10:00:00Z') };
    const auth = await service(dir, clock);
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await auth.login({ password: 'wrong password value', clientKey: '10.0.0.9' });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'UNAUTHENTICATED');
    }
    const limited = await auth.login({ password: PASSWORD, clientKey: '10.0.0.9' });
    assert.equal(limited.ok, false);
    assert.equal(limited.code, 'RATE_LIMITED');
    assert.ok((limited.retryAfterSeconds ?? 0) > 0);
    assert.equal((await auth.login({ password: PASSWORD, clientKey: '10.0.0.8' })).ok, true, 'limit is per client key');
    assert.equal((await auth.login({ password: 123, clientKey: '10.0.0.8' })).code, 'VALIDATION_FAILED');
    clock.at += 900_001;
    const recovered = await auth.login({ password: PASSWORD, clientKey: '10.0.0.9' });
    assert.equal(recovered.ok, true, 'the window expires');
  });
});

test('write verification requires an allowed origin, a JSON body and the session CSRF token', async () => {
  await withDir(async dir => {
    const clock = { at: Date.parse('2026-09-23T10:00:00Z') };
    const auth = await service(dir, clock);
    const login = await auth.login({ password: PASSWORD, clientKey: '127.0.0.1' });
    assert.equal(login.ok, true);
    if (!login.ok) return;
    const session = await auth.authenticateRequest(request({ cookie: `${DEFAULT_COOKIE_NAME}=${cookieValue(login.setCookie)}` }));
    assert.ok(session);
    const base = { origin: ORIGIN, csrf: login.csrfToken, contentType: 'application/json' };
    assert.equal(auth.verifyWrite(request(base), session), true);
    assert.equal(auth.verifyWrite(request({ ...base, origin: 'https://evil.test' }), session), false);
    assert.equal(auth.verifyWrite(request({ ...base, origin: ORIGIN }), session), true);
    assert.equal(auth.verifyWrite(request({ origin: ORIGIN, contentType: 'application/json' }), session), false);
    assert.equal(auth.verifyWrite(request({ ...base, csrf: `${login.csrfToken}x` }), session), false);
    assert.equal(auth.verifyWrite(request({ ...base, contentType: 'text/plain' }), session), false);
    assert.equal(auth.verifyWrite(request(base), null), false);
    assert.equal(auth.isAllowedOrigin('https://chat.example.test'), true);
    assert.equal(auth.isAllowedOrigin(undefined), false);
    assert.equal(auth.clearCookie().includes('Max-Age=0'), true);
  });
});

test('the file store survives a restart and revocation can cover every session', async () => {
  await withDir(async dir => {
    const clock = { at: Date.parse('2026-09-23T10:00:00Z') };
    const auth = await service(dir, clock);
    const first = await auth.login({ password: PASSWORD, clientKey: '127.0.0.1' });
    const second = await auth.login({ password: PASSWORD, clientKey: '127.0.0.2' });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;

    const restarted = await service(dir, clock);
    const cookie = `${DEFAULT_COOKIE_NAME}=${cookieValue(second.setCookie)}`;
    assert.equal((await restarted.authenticateRequest(request({ cookie })))?.ownerId, 'owner-1', 'sessions survive a restart');
    assert.equal(await restarted.revokeAll(), 2);
    assert.equal(await restarted.authenticateRequest(request({ cookie })), null);
    const stale = await restarted.authenticateRequest(request({ cookie: `${DEFAULT_COOKIE_NAME}=${cookieValue(first.setCookie)}` }));
    assert.equal(stale, null, 'revokeAll covers sessions created by another instance');
  });
});

test('cookie parsing ignores malformed and duplicate entries', () => {
  assert.deepEqual(parseCookieHeader('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookieHeader('a=1; a=2'), { a: '1' });
  assert.deepEqual(parseCookieHeader('broken; =1; c='), { c: '' });
  assert.deepEqual(parseCookieHeader(undefined), {});
});
