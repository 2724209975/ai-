import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOwnerHttpHandler, type OwnerPort } from './owner-http.mts';

test('Owner HTTP denies missing session and CSRF before reaching 02', async () => {
  let called = 0;
  const port: OwnerPort = {
    async overview() { called++; return { version: 1, globalPaused: false, allowedActions: [] }; },
    async tasks() { called++; return { items: [] }; },
    async contacts() { called++; return { items: [] }; },
    async confirm() { called++; return { resultVersion: 1, correlationId: 'command' }; },
    async pauseAll() { called++; return { resultVersion: 1, correlationId: 'command' }; },
    async pauseContact() { called++; return { resultVersion: 1, correlationId: 'command' }; },
  };
  const server = createServer(createOwnerHttpHandler({
    ownerPort: port,
    authenticate: async request => request.headers.cookie === 'owner=fixture' ? { ownerId: 'trusted-owner' } : null,
    verifyWrite: async request => request.headers.origin === 'http://127.0.0.1' && request.headers['x-csrf-token'] === 'fixture-csrf',
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const anonymous = await fetch(url + '/api/v1/tasks');
    assert.equal(anonymous.status, 401);
    const csrf = await fetch(url + '/api/v1/control/pause-all', { method: 'POST', headers: { cookie: 'owner=fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, idempotencyKey: 'abcdefgh' }) });
    assert.equal(csrf.status, 403);
    assert.equal(called, 0);
    const allowed = await fetch(url + '/api/v1/tasks', { headers: { cookie: 'owner=fixture' } });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { items: [] });
    assert.equal(called, 1);
    for (const path of ['/api/v1/skills', '/api/v1/imports', '/api/v1/faults']) {
      const missing = await fetch(url + path, { headers: { cookie: 'owner=fixture' } });
      assert.equal(missing.status, 501);
      assert.equal((await missing.json() as { code: string }).code, 'NOT_IMPLEMENTED');
    }
    assert.equal(called, 1);
    const malformed = await fetch(url + '/api/v1/tasks/task-1/confirm', { method: 'POST', headers: { cookie: 'owner=fixture', origin: 'http://127.0.0.1', 'x-csrf-token': 'fixture-csrf' }, body: '{}' });
    assert.equal(malformed.status, 400);
    assert.equal(called, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Owner HTTP preserves 409 and does not claim a send', async () => {
  const port: OwnerPort = {
    async overview() { return {}; }, async tasks() { return { items: [] }; }, async contacts() { return { items: [] }; },
    async confirm() { throw new Error('STALE_PLAN'); },
    async pauseAll() { throw new Error('PAUSED'); },
    async pauseContact() { throw new Error('PAUSED'); },
  };
  const server = createServer(createOwnerHttpHandler({ ownerPort: port, authenticate: async () => ({ ownerId: 'trusted-owner' }), verifyWrite: async () => true }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tasks/task-1/confirm`, {
      method: 'POST', body: JSON.stringify({ taskVersion: 1, planVersion: 1, alternativeId: 'alternative-1', editedParts: [{ type: 'text', content: '你好' }], contentHash: 'a'.repeat(64), idempotencyKey: 'abcdefgh' }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { code: string; correlationId: string };
    assert.equal(body.code, 'STALE_PLAN');
    assert.ok(body.correlationId);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
