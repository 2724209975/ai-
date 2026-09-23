/** Real HTTP boundary for the management app: password login, session cookie, CSRF/Origin
 * enforcement, revocation, rate limiting and the CSRF meta tag injected into the app shell.
 * Storage is a temporary session directory; no PostgreSQL or platform adapter is involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../../packages/infrastructure/auth/password.mts';
import { FileOwnerSessionStore } from '../../packages/infrastructure/auth/session-store.mts';
import { DEFAULT_COOKIE_NAME, OwnerAuthService } from '../../packages/infrastructure/auth/owner-auth.mts';
import { createOwnerApp } from '../../apps/web/server/owner-server.mts';
import type { OwnerPort } from '../../apps/web/server/owner-http.mts';

const PASSWORD = 'correct horse battery staple';

test('management app enforces login, CSRF/Origin and revocation over real HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-app-'));
  const sessions = join(root, 'sessions');
  const buildDir = join(root, 'build');
  await mkdir(buildDir, { recursive: true });
  await writeFile(join(buildDir, 'index.html'), '<!doctype html>\n<html><head><meta charset="UTF-8"><title>t</title></head><body><div id="root"></div></body></html>\n');
  await writeFile(join(root, 'secret.txt'), 'must not be served\n');

  const calls: string[] = [];
  const ownerPort: OwnerPort = {
    async overview() { return { id: 'overview', version: 1, status: 'ACTIVE', allowedActions: ['pauseAll'] }; },
    async tasks() { return { items: [] }; },
    async contacts() { return { items: [] }; },
    async confirm() { throw new Error('NOT_FOUND'); },
    async pauseAll() { calls.push('pauseAll'); return { resultVersion: 7, correlationId: 'fixture-correlation' }; },
    async pauseContact() { throw new Error('NOT_FOUND'); },
  };
  const passwordHash = await hashPassword(PASSWORD);
  const build = async () => new OwnerAuthService({
    ownerId: 'owner-1', passwordHash, store: new FileOwnerSessionStore(sessions),
    allowedOrigins: [], secureCookies: false,
  });
  let auth = await build();
  let app = createOwnerApp({ auth, ownerPort, buildDir, hsts: false });
  let server = createServer((request, response) => { void app(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let origin = `http://127.0.0.1:${address.port}`;
  // Rebuild with the final origin so the Origin check has something to compare against.
  auth = new OwnerAuthService({
    ownerId: 'owner-1', passwordHash, store: new FileOwnerSessionStore(sessions),
    allowedOrigins: [origin], secureCookies: false,
  });
  app = createOwnerApp({ auth, ownerPort, buildDir, hsts: false });
  server.removeAllListeners('request');
  server.on('request', (request, response) => { void app(request, response); });

  const login = (password: string, requestOrigin = origin) => fetch(`${origin}/api/v1/session/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin }, body: JSON.stringify({ password }),
  });
  try {
    // Unauthenticated reads and writes are refused before any command executes.
    assert.equal((await fetch(`${origin}/api/v1/tasks`)).status, 401);
    assert.equal((await fetch(`${origin}/api/v1/control/pause-all`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ expectedVersion: 1, idempotencyKey: 'synthetic-command-1' }),
    })).status, 401);
    assert.equal(calls.length, 0);

    const wrong = await login('definitely not the password');
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, 'UNAUTHENTICATED');

    const foreign = await login(PASSWORD, 'https://evil.test');
    assert.equal(foreign.status, 403, 'login from a foreign origin is refused');

    const ok = await login(PASSWORD);
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    assert.match(setCookie, new RegExp(`^${DEFAULT_COOKIE_NAME}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const token = new RegExp(`${DEFAULT_COOKIE_NAME}=([^;]+)`).exec(setCookie)![1]!;
    const { csrfToken } = await ok.json() as { csrfToken: string };
    assert.ok(csrfToken);
    const cookie = `${DEFAULT_COOKIE_NAME}=${token}`;

    // The app shell carries the CSRF token only for an authenticated browser.
    const shell = await fetch(`${origin}/`, { headers: { Cookie: cookie } });
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), new RegExp(`<meta name="csrf-token" content="${csrfToken}"`));
    const anonymousShell = await fetch(`${origin}/`);
    assert.match(await anonymousShell.text(), /<meta name="csrf-token" content="" \/>/);

    for (const [name, value] of [['X-Content-Type-Options', 'nosniff'], ['X-Frame-Options', 'DENY']] as const) {
      assert.equal(shell.headers.get(name), value);
    }

    const command = (init: { csrf?: string; requestOrigin?: string; cookie?: string; contentType?: string } = {}) => fetch(`${origin}/api/v1/control/pause-all`, {
      method: 'POST',
      headers: {
        'Content-Type': init.contentType ?? 'application/json',
        Origin: init.requestOrigin ?? origin,
        Cookie: init.cookie ?? cookie,
        ...(init.csrf ? { 'X-CSRF-Token': init.csrf } : {}),
      },
      body: JSON.stringify({ expectedVersion: 1, idempotencyKey: 'synthetic-command-1' }),
    });
    assert.equal((await command()).status, 403, 'missing CSRF token');
    assert.equal((await command({ csrf: `${csrfToken}x` })).status, 403, 'wrong CSRF token');
    assert.equal((await command({ csrf: csrfToken, requestOrigin: 'https://evil.test' })).status, 403, 'foreign origin');
    assert.equal((await command({ csrf: csrfToken, contentType: 'text/plain' })).status, 403, 'non-JSON body');
    assert.equal((await command({ csrf: csrfToken, cookie: `${DEFAULT_COOKIE_NAME}=forged` })).status, 401, 'forged session');
    assert.equal(calls.length, 0);

    const accepted = await command({ csrf: csrfToken });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).resultVersion, 7);
    assert.deepEqual(calls, ['pauseAll']);

    // Static serving stays inside the build directory even with an encoded traversal path.
    const traversal = await fetch(`${origin}/..%2fsecret.txt`, { headers: { Cookie: cookie } });
    assert.equal(traversal.status, 403, 'encoded traversal is refused');
    assert.ok(!(await traversal.text()).includes('must not be served'));

    // Sessions live on disk, so a restart keeps the browser signed in.
    const restarted = new OwnerAuthService({
      ownerId: 'owner-1', passwordHash, store: new FileOwnerSessionStore(sessions),
      allowedOrigins: [origin], secureCookies: false,
    });
    assert.ok(await restarted.authenticateRequest({ headers: { cookie } } as never));
    assert.equal((await fetch(`${origin}/api/v1/tasks`, { headers: { Cookie: cookie } })).status, 200);

    // Logout revokes the session immediately.
    const logout = await fetch(`${origin}/api/v1/session/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${origin}/api/v1/tasks`, { headers: { Cookie: cookie } })).status, 401);

    // Rate limiting is applied per client and reports the retry window.
    let limited: Response | undefined;
    for (let attempt = 0; attempt < 6 && !limited; attempt++) {
      const response = await login('still not the password');
      if (response.status === 429) limited = response;
      else assert.equal(response.status, 401);
    }
    assert.ok(limited, 'expected the sixth failure to be rate limited');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await login(PASSWORD)).status, 429, 'the limiter also blocks a correct password until the window ends');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
