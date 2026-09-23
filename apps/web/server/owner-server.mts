/** Management app composition: session endpoints, authenticated API and the built SPA.
 * The SPA shell receives a CSRF meta tag so the browser can echo it on writes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { OwnerAuthService } from '../../packages/infrastructure/auth/owner-auth.mts';
import { createOwnerHttpHandler, type OwnerPort } from './owner-http.mts';
import { createOwnerSessionHandler } from './owner-session-http.mts';

export type OwnerAppOptions = {
  auth: OwnerAuthService;
  ownerPort: OwnerPort;
  buildDir: string;
  clientKey?(request: IncomingMessage): string;
  hsts?: boolean;
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function baseHeaders(hsts: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
  if (hsts) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** The session token is httpOnly; only the CSRF token is exposed to the same-origin shell. */
export function injectCsrfMeta(html: string, csrfToken: string): string {
  const tag = `<meta name="csrf-token" content="${escapeAttribute(csrfToken)}" />`;
  const stripped = html.replace(/[ \t]*<meta name="csrf-token"[^>]*>\r?\n?/g, '');
  return stripped.includes('</head>') ? stripped.replace('</head>', `    ${tag}\n  </head>`) : `${stripped}\n${tag}\n`;
}

export function createOwnerApp(options: OwnerAppOptions) {
  if (!options?.auth || !options?.ownerPort || !options?.buildDir) throw new Error('OWNER_APP_CONFIG_INVALID');
  const buildDir = resolve(options.buildDir);
  const headers = baseHeaders(options.hsts ?? true);
  const sessionHandler = createOwnerSessionHandler({ auth: options.auth, clientKey: options.clientKey });
  const apiHandler = createOwnerHttpHandler({
    ownerPort: options.ownerPort,
    authenticate: (request: IncomingMessage) => options.auth.authenticateRequest(request),
    verifyWrite: (request: IncomingMessage, session: Parameters<OwnerAuthService['verifyWrite']>[1]) => options.auth.verifyWrite(request, session),
  });

  return async function ownerApp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    try {
      if (path.startsWith('/api/v1/session') && await sessionHandler(request, response)) return;
      if (path.startsWith('/api/v1/')) return await apiHandler(request, response);
      if (method !== 'GET' && method !== 'HEAD') { response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ code: 'VALIDATION_FAILED', message: 'METHOD_NOT_ALLOWED' })); return; }
      const relative = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      const target = resolve(buildDir, relative);
      if (target !== buildDir && !target.startsWith(buildDir + sep)) { response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ code: 'FORBIDDEN', message: 'FORBIDDEN' })); return; }
      let bytes: Buffer;
      try { bytes = await readFile(target); } catch { response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ code: 'NOT_FOUND', message: 'NOT_FOUND' })); return; }
      const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
      if (relative === 'index.html') {
        const session = await options.auth.authenticateRequest(request);
        const html = injectCsrfMeta(bytes.toString('utf8'), session?.csrfToken ?? '');
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(method === 'HEAD' ? undefined : html);
        return;
      }
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': extname(target) === '.html' ? 'no-store' : 'public, max-age=300' });
      response.end(method === 'HEAD' ? undefined : bytes);
    } catch {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: '服务暂不可用，请稍后刷新。' }));
    }
  };
}
