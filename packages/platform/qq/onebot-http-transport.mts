/** OneBot HTTP transport for a trusted private bridge. Only the guarded executor may own it. */
import { WireError } from './onebot-codec.mts';
import type { SubmissionTransport } from './send-executor.mts';

export class OneBotHttpTransport implements SubmissionTransport {
  #endpoint: string;
  #token: string;
  #fetch: typeof fetch;
  #maxResponseBytes: number;

  constructor(options: { baseUrl: string; accessToken: string; fetchImpl?: typeof fetch; maxResponseBytes?: number }) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new WireError(); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new WireError();
    if (!options.accessToken || /[\r\n]/.test(options.accessToken)) throw new WireError();
    const max = options.maxResponseBytes ?? 65_536;
    if (!Number.isSafeInteger(max) || max < 1) throw new WireError();
    this.#endpoint = new URL('send_private_msg', url).toString();
    this.#token = options.accessToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxResponseBytes = max;
  }

  async submitOnce(wire: Parameters<SubmissionTransport['submitOnce']>[0], signal: AbortSignal) {
    if (wire.action !== 'send_private_msg') throw new WireError('UNSUPPORTED_CAPABILITY');
    // The OneBot HTTP API takes params as the POST body. It does not promise an echo.
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify(wire.params), signal, redirect: 'manual', cache: 'no-store',
    });
    // Even an HTTP error or malformed reply might arrive after a platform side effect.
    // The executor conservatively marks thrown transport results RESULT_UNKNOWN.
    if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) throw new WireError('PLATFORM_UNAVAILABLE');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > this.#maxResponseBytes) { await reader.cancel(); throw new WireError(); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks, length);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new WireError(); }
    return { correlation: 'http_response' as const, response: body };
  }
}
