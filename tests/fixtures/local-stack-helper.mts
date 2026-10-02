/** Synthetic helper child for the local-stack drill. It has no platform or model imports. */
import { createServer, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

function tokenMatches(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function main() {
  if (process.env.NODE_ENV !== 'test' || process.env.LOCAL_STACK_FIXTURE !== '1') throw new Error('FIXTURE_ONLY');
  const token = process.env.FIXTURE_CONTROL_TOKEN ?? '';
  const port = Number(process.env.PORT ?? '0');
  if (!/^[a-f0-9]{64}$/.test(token) || !Number.isSafeInteger(port) || port < 0 || port > 65535 || port === 19088)
    throw new Error('FIXTURE_CONFIG_INVALID');
  let mode: 'healthy' | 'login-abnormal' | 'unresponsive' = 'healthy';
  let checkLoginCalls = 0, sendCalls = 0, closing = false;
  const hanging = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) { reply(403, { code: 403 }); return; }
      if (request.method === 'GET' && url.pathname === '/healthz') { reply(200, { status: 'ok', fixture: 'local-stack-helper' }); return; }
      if (request.method === 'POST' && url.pathname === '/api/checkLogin') {
        request.resume();
        checkLoginCalls++;
        if (mode === 'unresponsive') {
          hanging.add(response); response.once('close', () => hanging.delete(response)); return;
        }
        reply(200, { code: mode === 'healthy' ? 1 : 0 }); return;
      }
      if (!tokenMatches(request.headers['x-fixture-token'], token)) { reply(401, { code: 401 }); return; }
      if (request.method === 'GET' && url.pathname === '/fixture/state') {
        reply(200, { fixture: 'local-stack-helper', mode, checkLoginCalls, sendCalls }); return;
      }
      if (request.method !== 'POST' || !['/fixture/control', '/api/sendTextMsg'].includes(url.pathname)) { reply(404, { code: 404 }); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) { reply(413, { code: 413 }); return; }
        chunks.push(chunk as Buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/fixture/control') {
        if (!body || !['healthy', 'login-abnormal', 'unresponsive'].includes(body.mode)
          || Object.keys(body).some(key => !['mode', 'resetCounters'].includes(key))
          || (body.resetCounters !== undefined && typeof body.resetCounters !== 'boolean')) { reply(400, { code: 400 }); return; }
        mode = body.mode;
        if (body.resetCounters) { checkLoginCalls = 0; sendCalls = 0; }
        // Release already waiting probes when the fixture recovers, without keeping their input.
        if (mode !== 'unresponsive') for (const waiting of hanging) {
          waiting.writeHead(200, { 'content-type': 'application/json' });
          waiting.end(JSON.stringify({ code: mode === 'healthy' ? 1 : 0 })); hanging.delete(waiting);
        }
        reply(200, { fixture: 'local-stack-helper', mode }); return;
      }
      if (!body || typeof body.wxid !== 'string' || !body.wxid.startsWith('fixture_')
        || typeof body.msg !== 'string' || !body.msg.trim()
        || Object.keys(body).some(key => !['wxid', 'msg'].includes(key))) { reply(400, { code: 400 }); return; }
      // Only this number persists. The peer and body are never retained, returned or logged.
      sendCalls++;
      reply(200, { code: 0, status: 'RESULT_UNKNOWN' });
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  const stop = async () => {
    if (closing) return; closing = true;
    for (const response of hanging) response.destroy(); hanging.clear();
    const stopped = new Promise<void>(done => server.close(() => done()));
    server.closeAllConnections(); await stopped;
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop());
  process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'fixture-stop') void stop(); });
  await new Promise<void>((ready, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => { server.off('error', fail); ready(); }); });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('FIXTURE_START_FAILED');
  process.send?.({ type: 'fixture-ready', fixture: 'local-stack-helper', port: bound.port, pid: process.pid });
  process.stdout.write(`${JSON.stringify({ event: 'fixture_ready' })}\n`);
}

void main().catch(() => { process.stderr.write('fixture_start_failed\n'); process.exit(1); });
