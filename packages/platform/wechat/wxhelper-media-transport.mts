/** Read-only wxhelper media transport: one POST, no sending capability.
 *
 * `/api/downloadAttach` asks WeChat to write an image to its own data directory. Its response only
 * carries a return code, never a path or the bytes, so this transport reports "accepted" and
 * nothing more: whether a file actually appeared is decided by the caller that reads the disk.
 *
 * The boundary that matters is loopback, not one blessed port: a helper listens on 127.0.0.1 and
 * that is the whole trust story. Credentials, query strings and fragments are refused because they
 * would end up in an error path we cannot redact. Errors are fixed names only — never the message
 * id, the data path or response text.
 */
export type WxhelperMediaTransport = {
  downloadAttach(input: { msgId: string; signal: AbortSignal }): Promise<{ ok: boolean }>;
};

export const WXHELPER_DEFAULT_BASE_URL = 'http://127.0.0.1:19088/';

export class WxhelperLoopbackMediaTransport implements WxhelperMediaTransport {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #maxResponseBytes: number;

  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch; maxResponseBytes?: number } = {}) {
    let url: URL;
    try { url = new URL(options.baseUrl?.trim() || WXHELPER_DEFAULT_BASE_URL); } catch { throw new Error('VALIDATION_FAILED'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('WX_LOOPBACK_ONLY');
    const max = options.maxResponseBytes ?? 16_384;
    if (!Number.isSafeInteger(max) || max < 1 || max > 65_536) throw new Error('VALIDATION_FAILED');
    this.#endpoint = new URL('api/downloadAttach', url).toString();
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxResponseBytes = max;
  }

  async downloadAttach(input: { msgId: string; signal: AbortSignal }): Promise<{ ok: boolean }> {
    // The helper parses msgId as an int64 with nlohmann, so the body carries a bare decimal literal.
    // Above 2^53 a JSON parser that reads numbers as doubles rounds the id, which would make the
    // helper act on a *different* message id. We refuse rather than risk that, and record the limit.
    if (typeof input?.msgId !== 'string' || !/^\d{1,16}$/.test(input.msgId) || !input.signal) throw new Error('WX_MEDIA_MSGID_UNSAFE');
    if (Number(input.msgId) > Number.MAX_SAFE_INTEGER) throw new Error('WX_MEDIA_MSGID_UNSAFE');
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: `{"msgId":${input.msgId}}`, signal: input.signal, redirect: 'manual', cache: 'no-store',
    });
    if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')
      || !response.body) throw new Error(`WX_MEDIA_HTTP_${response.status}`);
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
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
    catch { throw new Error('PLATFORM_UNAVAILABLE'); }
    const code = (parsed as { code?: unknown })?.code;
    if (typeof code !== 'number') throw new Error('PLATFORM_UNAVAILABLE');
    // Non-zero is "WeChat accepted the download task"; it is not proof that bytes reached the disk.
    return { ok: code !== 0 };
  }
}
