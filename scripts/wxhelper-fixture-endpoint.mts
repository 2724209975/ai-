/** Loopback stand-in for the wxhelper HTTP helper, for rehearsing the main line without WeChat.
 *
 * It is deliberately unable to impersonate the real helper: it answers only `/api/sendTextMsg` and
 * `/healthz`, it never touches Tencent, and it never reports delivery — the bridge records every
 * accepted submission as RESULT_UNKNOWN regardless of this response. The request log keeps only a
 * byte length and a digest, never the message text, so a rehearsal leaves no chat content behind.
 *
 * Usage: set WXHELPER_FIXTURE_ENABLE=1 and WXHELPER_FIXTURE_LOG=<private file>, then run this file.
 */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

if (process.env.WXHELPER_FIXTURE_ENABLE !== '1') throw new Error('FIXTURE_DISABLED');
const logPath = process.env.WXHELPER_FIXTURE_LOG?.trim();
if (!logPath) throw new Error('MISSING_ENV:WXHELPER_FIXTURE_LOG');
const port = Number(process.env.WXHELPER_FIXTURE_PORT?.trim() || '19088');
if (port !== 19088) throw new Error('WXHELPER_ENDPOINT_MUST_BE_19088');

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', mode: 'fixture', claimsDelivery: false }));
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/api/sendTextMsg') { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
      const bytes = chunk as Buffer;
      length += bytes.length;
      if (length > 65_536) { response.writeHead(413); response.end(); request.destroy(); return; }
      chunks.push(bytes);
    }
    let body: { wxid?: unknown; msg?: unknown } = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }
    const text = typeof body.msg === 'string' ? body.msg : '';
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(),
      // The recipient identifier is deliberately not written: a local log file is still a log file.
      peerProvided: typeof body.wxid === 'string' && body.wxid.length > 0,
      textBytes: Buffer.byteLength(text, 'utf8'), textSha256: createHash('sha256').update(text, 'utf8').digest('hex') })}\n`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 0, msg: 'fixture_accepted' }));
  })().catch(() => { if (!response.headersSent) response.writeHead(503); response.end(); });
});
await new Promise<void>((ready, failed) => {
  server.once('error', failed);
  server.listen(port, '127.0.0.1', () => { server.off('error', failed); ready(); });
});
process.stdout.write(`wxhelper fixture listening on http://127.0.0.1:${port} · log ${logPath}\n`);
process.stdout.write('this endpoint does not send anything and does not claim delivery\n');
const stop = (): void => { server.close(() => process.exit(0)); };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
