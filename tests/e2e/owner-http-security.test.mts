/** HTTP security boundary with synthetic signed sessions. No production login is implied. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createOwnerHttpHandler, type OwnerPort } from '../../apps/web/server/owner-http.mts';

test('Owner HTTP rejects missing/forged session and missing or foreign CSRF before command', async () => {
  const secret = randomBytes(32);
  const csrf = randomBytes(24).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ownerId: 'owner-1', csrf, expiresAt: Date.now() + 60_000 })).toString('base64url');
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest('base64url');
  const token = `${payload}.${sign(payload)}`;
  let commandCount = 0;
  const port: OwnerPort = {
    async overview() { return { id: 'overview', version: 1, status: 'ready', allowedActions: [] }; },
    async tasks() { return { items: [] }; },
    async contacts() { return { items: [] }; },
    async conversations() { return { items: [] }; },
    async facts() { return { items: [] }; },
    async analyses() { return { items: [] }; },
    async media() { return { items: [] }; },
    async audit() { return { items: [] }; },
    async confirm() { throw new Error('NOT_FOUND'); },
    async reject() { throw new Error('NOT_FOUND'); },
    async pauseAll() { commandCount++; return { resultVersion: 2, correlationId: 'fixture-correlation' }; },
    async resumeAll() { throw new Error('NOT_FOUND'); },
    async pauseContact() { throw new Error('NOT_FOUND'); },
    async resumeContact() { throw new Error('NOT_FOUND'); },
    async updatePolicy() { throw new Error('NOT_FOUND'); },
    async changeFact() { throw new Error('NOT_FOUND'); },
    async correctAnalysis() { throw new Error('NOT_FOUND'); },
    async setMediaApproval() { throw new Error('NOT_FOUND'); },
  };
  let origin = '';
  const handler = createOwnerHttpHandler({
    ownerPort: port,
    async authenticate(request) {
      const match = /(?:^|;\s*)owner_session=([^;]+)/.exec(request.headers.cookie ?? '');
      if (!match) return null;
      const [encoded, signature, extra] = match[1]!.split('.');
      if (!encoded || !signature || extra) return null;
      const expected = Buffer.from(sign(encoded));
      const received = Buffer.from(signature);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
      try {
        const session = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        return session.ownerId === 'owner-1' && session.expiresAt > Date.now() ? { ownerId: session.ownerId } : null;
      } catch { return null; }
    },
    async verifyWrite(request, session) {
      return session.ownerId === 'owner-1' && request.headers.origin === origin && request.headers['x-csrf-token'] === csrf;
    },
  });
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/api/v1/control/pause-all`;
    const body = JSON.stringify({ expectedVersion: 1, idempotencyKey: 'synthetic-command-1' });
    const post = (cookie?: string, requestOrigin = origin, csrfHeader?: string) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin,
        ...(cookie ? { Cookie: `owner_session=${cookie}` } : {}),
        ...(csrfHeader ? { 'X-CSRF-Token': csrfHeader } : {}) }, body,
    });
    assert.equal((await fetch(`${origin}/api/v1/tasks`)).status, 401);
    assert.equal((await post()).status, 401);
    assert.equal((await post(`${payload}.${sign(payload)}forged`, origin, csrf)).status, 401);
    assert.equal((await post(token)).status, 403);
    assert.equal((await post(token, `${origin}.evil.test`, csrf)).status, 403);
    assert.equal(commandCount, 0);
    const accepted = await post(token, origin, csrf);
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).resultVersion, 2);
    assert.equal(commandCount, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
