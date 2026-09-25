/** Local wxhelper HTTP transport. Only the 02 one-shot runner may own this object. */
import type { WxhelperSendTransport } from './wxhelper-send-port.mts';

export class WxhelperHttpTransport implements WxhelperSendTransport {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #maxResponseBytes: number;

  constructor(options: { baseUrl: string; fetchImpl?: typeof fetch; maxResponseBytes?: number }) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new Error('VALIDATION_FAILED'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '19088'
      || url.pathname !== '/' || url.username || url.password || url.search || url.hash)
      throw new Error('WX_LOOPBACK_ONLY');
    const max = options.maxResponseBytes ?? 16_384;
    if (!Number.isSafeInteger(max) || max < 1 || max > 65_536) throw new Error('VALIDATION_FAILED');
    this.#endpoint = new URL('api/sendTextMsg', url).toString();
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxResponseBytes = max;
  }

  async submitOnce(request: { wxid: string; msg: string }, signal: AbortSignal): Promise<unknown> {
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), signal, redirect: 'manual', cache: 'no-store',
    });
    if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')
      || !response.body) throw new Error('PLATFORM_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > this.#maxResponseBytes) { await reader.cancel(); throw new Error('PLATFORM_UNAVAILABLE'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
    catch { throw new Error('PLATFORM_UNAVAILABLE'); }
  }
}
