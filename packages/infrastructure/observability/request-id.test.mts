/** Unit tests for the shared request id and route-label helpers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { requestIdOf, routeLabel } from './request-id.mts';

const request = (headers: Record<string, string | string[] | undefined>) => ({ headers } as unknown as IncomingMessage);

test('a well-formed caller request id is reused and anything else is replaced', () => {
  assert.equal(requestIdOf(request({ 'x-request-id': 'req-1234567890' })), 'req-1234567890');
  assert.equal(requestIdOf(request({ 'x-request-id': ['req-abcdefgh'] })), 'req-abcdefgh');
  for (const hostile of ['short', 'has space', 'has\nnewline', 'x'.repeat(65), '', 'tökén-1234']) {
    const generated = requestIdOf(request({ 'x-request-id': hostile }));
    assert.match(generated, /^[0-9a-f-]{36}$/, `${hostile} must not be echoed`);
  }
  assert.match(requestIdOf(request({})), /^[0-9a-f-]{36}$/);
});

test('route labels keep the shape and drop identifiers and query strings', () => {
  assert.equal(routeLabel('/api/v1/overview?token=leaked'), '/api/v1/overview');
  assert.equal(routeLabel('/api/v1/tasks/0f0e0d0c-0b0a-4908-8706-050403020100/confirm'), '/api/v1/tasks/:id/confirm');
  assert.equal(routeLabel('/api/v1/tasks/1234567890123456789/reject'), '/api/v1/tasks/:id/reject');
  assert.equal(routeLabel('/api/v1/tasks/abcdefghijklmnopqrstuvwxyz012345/confirm'), '/api/v1/tasks/:id/confirm');
  assert.equal(routeLabel(undefined), '/');
  assert.equal(routeLabel('/healthz'), '/healthz');
  const long = routeLabel(`/api/v1/${'segment/'.repeat(20)}`);
  assert.ok(long.length <= 96, `route labels are capped, got ${long.length}`);
  assert.ok(long.endsWith('...'));
});
