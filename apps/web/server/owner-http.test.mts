import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOwnerHttpHandler, type OwnerPort } from './owner-http.mts';

test('Owner HTTP protects candidate telemetry and validates bounded rejection reasons', async () => {
  const saved: { action: string; command: unknown }[] = [];
  const port = {
    async present(ownerId: string, taskId: string, command: unknown) {
      assert.equal(ownerId, 'trusted-owner'); assert.equal(taskId, 'task-1'); saved.push({ action: 'present', command }); return { resultVersion: 1, correlationId: 'recorded' };
    },
    async reject(_ownerId: string, _taskId: string, command: unknown) { saved.push({ action: 'reject', command }); return { resultVersion: 2, correlationId: 'rejected' }; },
  } as OwnerPort;
  const server = createServer(createOwnerHttpHandler({ ownerPort: port,
    authenticate: async request => request.headers.cookie === 'owner=fixture' ? { ownerId: 'trusted-owner' } : null,
    verifyWrite: request => request.headers['x-csrf-token'] === 'fixture' }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const command = { expectedVersion: 1, idempotencyKey: 'abcdefgh', shownAlternativeIds: ['alternative-1'] };
  const request = (action: string, body: unknown, headers: Record<string, string> = { cookie: 'owner=fixture', 'x-csrf-token': 'fixture' }) =>
    fetch(`http://127.0.0.1:${address.port}/api/v1/tasks/task-1/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await request('present', command, {})).status, 401);
    assert.equal((await request('present', command, { cookie: 'owner=fixture' })).status, 403);
    assert.equal((await request('present', { ...command, shownAlternativeIds: undefined })).status, 400);
    for (const rejectionReason of ['私密自由文本', null, 1, 'TOO_LONG']) assert.equal((await request('reject', { ...command, rejectionReason })).status, 400);
    assert.equal((await request('reject', { ...command, shownAlternativeIds: ['a', 'a'] })).status, 400);
    assert.equal(saved.length, 0);
    assert.equal((await request('present', command)).status, 200); assert.deepEqual(saved[0], { action: 'present', command });
    for (const rejectionReason of ['not_my_style', 'too_long', 'wrong_tone', 'wrong_fact', 'should_not_reply', undefined]) {
      assert.equal((await request('reject', { ...command, rejectionReason })).status, 200);
      assert.deepEqual(saved.at(-1)!.command, { ...command, ...(rejectionReason ? { rejectionReason } : {}) });
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

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

test('Owner HTTP requires a boolean resume and forwards only an explicit request to clear UNKNOWN_SEND', async () => {
  const saved: unknown[] = [];
  const port: OwnerPort = {
    async overview() { return {}; }, async tasks() { return { items: [] }; }, async contacts() { return { items: [] }; },
    async confirm() { throw new Error('UNUSED'); }, async pauseAll() { throw new Error('UNUSED'); },
    async pauseContact() { throw new Error('UNUSED'); },
    async resolveSend(_ownerId, _sendId, command) { saved.push(command); return { resultVersion: 2, correlationId: 'resolved' }; },
  };
  const server = createServer(createOwnerHttpHandler({ ownerPort: port,
    authenticate: async () => ({ ownerId: 'trusted-owner' }), verifyWrite: async () => true }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const command = { expectedVersion: 1, idempotencyKey: 'abcdefgh', status: 'DELIVERED', evidenceRef: 'fixture:friend-confirmed' };
  const request = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/v1/sends/send-1/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    for (const resume of ['true', 1, null, {}]) assert.equal((await request({ ...command, resume })).status, 400);
    assert.equal(saved.length, 0);
    assert.equal((await request({ ...command, resume: true })).status, 200);
    assert.deepEqual(saved[0], { ...command, resume: true });
    assert.equal((await request({ ...command, resume: false })).status, 200);
    assert.deepEqual(saved[1], command);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
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

test('Owner HTTP accepts bounded expression preferences in a contact policy edit', async () => {
  let saved: unknown;
  const port: OwnerPort = {
    async overview() { return {}; }, async tasks() { return { items: [] }; }, async contacts() { return { items: [] }; },
    async confirm() { throw new Error('UNUSED'); }, async pauseAll() { throw new Error('UNUSED'); },
    async pauseContact() { throw new Error('UNUSED'); },
    async updatePolicy(_ownerId, _contactId, command) { saved = command.policy; return { resultVersion: 2, correlationId: 'saved' }; },
  };
  const server = createServer(createOwnerHttpHandler({ ownerPort: port,
    authenticate: async () => ({ ownerId: 'trusted-owner' }), verifyWrite: async () => true }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/contacts/contact-1/updatePolicy`;
  try {
    const command = { expectedVersion: 1, idempotencyKey: 'abcdefgh',
      policy: { goal: '自然聊天', stylePreferences: ['简短', '口语化'], restrictions: ['不提钱'] } };
    const valid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    assert.equal(valid.status, 200);
    assert.deepEqual(saved, command.policy);
    const invalid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...command, policy: { stylePreferences: ['x'.repeat(121)] } }) });
    assert.equal(invalid.status, 400);
    assert.deepEqual(saved, command.policy);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
