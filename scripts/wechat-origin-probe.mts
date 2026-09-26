/** Temporary loopback diagnostic. Keeps only a controlled known-peer sample; never sends. */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createWxOriginAudit } from '../packages/platform/wechat/origin-audit.mts';

const selfRef = process.env.WECHAT_SELF_REF ?? '';
const peerRef = process.env.WECHAT_SPIKE_PEER ?? '';
const marker = process.env.WECHAT_AUDIT_MARKER ?? '';
const dir = resolve(process.env.WECHAT_PROBE_DIR ?? '.local-wechat-spike/origin-probe');
const audit = createWxOriginAudit({ selfRef, peerRef, marker });
await mkdir(dir, { recursive: true });
let callbacks = 0, samples = 0;
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ mode: 'receive-only-probe', callbacks, samples, audit: audit.summary() }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/') { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > 1_048_576) { response.writeHead(413); response.end(); request.destroy(); return; }
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    const single = createWxOriginAudit({ selfRef, peerRef, marker }); single.add(bytes);
    if (single.summary().invalid) { response.writeHead(400); response.end(); return; }
    audit.add(bytes); callbacks++;
    if (single.summary().marker.exactSelfTextToKnownPeer === 1) {
      samples++;
      await writeFile(join(dir, `controlled-${samples}.bin`), bytes, { mode: 0o600, flag: 'wx' });
    }
    await writeFile(join(dir, 'summary.json'), JSON.stringify({ callbacks, samples, audit: audit.summary() }), { mode: 0o600 });
    response.writeHead(200); response.end('{}');
  })().catch(() => { if (!response.headersSent) response.writeHead(503); response.end(); });
});
server.listen(19099, '127.0.0.1', () => process.stdout.write('receive-only probe ready\n'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
