/** WeChat (wxhelper) receive-only capture endpoint for the G2 spike.
 *
 * The injected wxhelper dll POSTs every hooked message to the URL configured in the
 * client's config.ini (`RecvHttpUrl`), which points here. This endpoint is loopback
 * only and never sends anything back to the platform.
 *
 * What it does per message:
 *   - stores the raw bytes verbatim under <dir>/raw/<sha256>.bin (private, gitignored);
 *   - appends one de-identified row to <dir>/index.ndjson;
 *   - prints one de-identified line to stdout.
 *
 * It never prints or writes chat bodies, peer identifiers or file paths outside <dir>.
 *
 * Usage:
 *   node scripts/wechat-capture.mts            # serve (default 127.0.0.1:19099)
 *   node scripts/wechat-capture.mts --summary   # print the de-identified summary
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? fallback : value;
}

const dir = resolve(env('WECHAT_CAPTURE_DIR', '.local-wechat-spike'));
const rawDir = join(dir, 'raw');
const indexPath = join(dir, 'index.ndjson');
const host = env('WECHAT_CAPTURE_HOST', '127.0.0.1');
const port = Number(env('WECHAT_CAPTURE_PORT', '19099'));

/** wxhelper message type codes seen in the wild; unknown codes stay numeric. */
const TYPE_LABELS: Record<number, string> = {
  1: 'text',
  3: 'image',
  34: 'voice',
  42: 'card',
  43: 'video',
  47: 'sticker',
  48: 'location',
  49: 'link_or_file',
  50: 'voip',
  10000: 'system',
};

type Row = {
  receivedAt: string;
  byteLength: number;
  typeCode: number | null;
  typeLabel: string;
  parseError: boolean;
  hasMsgId: boolean;
  hasMsgSequence: boolean;
  hasCreateTime: boolean;
  hasContent: boolean;
  hasDisplayFullContent: boolean;
  hasSignature: boolean;
  inlineImageBytes: number;
  duplicate: boolean;
};

function describe(bytes: Buffer, duplicate: boolean): Row {
  const row: Row = {
    receivedAt: new Date().toISOString(),
    byteLength: bytes.byteLength,
    typeCode: null,
    typeLabel: 'unparsed',
    parseError: false,
    hasMsgId: false,
    hasMsgSequence: false,
    hasCreateTime: false,
    hasContent: false,
    hasDisplayFullContent: false,
    hasSignature: false,
    inlineImageBytes: 0,
    duplicate,
  };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    row.parseError = true;
    return row;
  }
  const typeCode = typeof parsed.type === 'number' ? parsed.type : null;
  row.typeCode = typeCode;
  row.typeLabel = typeCode === null ? 'unknown' : TYPE_LABELS[typeCode] ?? `code_${typeCode}`;
  row.hasMsgId = typeof parsed.msgId === 'number' && parsed.msgId !== 0;
  row.hasMsgSequence = typeof parsed.msgSequence === 'number';
  row.hasCreateTime = typeof parsed.createTime === 'number';
  row.hasContent = typeof parsed.content === 'string' && parsed.content.length > 0;
  row.hasDisplayFullContent = typeof parsed.displayFullContent === 'string' && parsed.displayFullContent.length > 0;
  row.hasSignature = typeof parsed.signature === 'string' && parsed.signature.length > 0;
  if (typeof parsed.base64Img === 'string') {
    // Length only: the base64 text itself is never written to the index.
    row.inlineImageBytes = Math.floor((parsed.base64Img.length * 3) / 4);
  }
  return row;
}

async function summary(): Promise<void> {
  let text: string;
  try {
    text = await readFile(indexPath, 'utf8');
  } catch {
    process.stdout.write(`${JSON.stringify({ endpoint: `${host}:${port}`, messages: 0, note: 'no index yet' }, null, 2)}\n`);
    return;
  }
  const rows = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Row);
  const byLabel = new Map<string, number>();
  for (const row of rows) byLabel.set(row.typeLabel, (byLabel.get(row.typeLabel) ?? 0) + 1);
  process.stdout.write(
    `${JSON.stringify(
      {
        messages: rows.length,
        duplicates: rows.filter((row) => row.duplicate).length,
        parseErrors: rows.filter((row) => row.parseError).length,
        byType: Object.fromEntries([...byLabel.entries()].sort()),
        withPlatformMessageId: rows.filter((row) => row.hasMsgId).length,
        withInlineImage: rows.filter((row) => row.inlineImageBytes > 0).length,
        firstReceivedAt: rows[0]?.receivedAt ?? null,
        lastReceivedAt: rows.at(-1)?.receivedAt ?? null,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv.includes('--summary')) {
  await summary();
} else {
  await mkdir(rawDir, { recursive: true });
  let count = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const digest = createHash('sha256').update(body).digest('hex');
        const file = join(rawDir, `${digest}.bin`);
        let duplicate = false;
        try {
          await writeFile(file, body, { flag: 'wx' });
        } catch {
          duplicate = true;
        }
        const row = describe(body, duplicate);
        await appendFile(indexPath, `${JSON.stringify(row)}\n`, 'utf8');
        count += 1;
        process.stdout.write(
          `capture #${count} type=${row.typeLabel} bytes=${row.byteLength} msgId=${row.hasMsgId ? 'yes' : 'no'} inlineImage=${row.inlineImageBytes} duplicate=${duplicate}\n`,
        );
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"code":200,"msg":"captured"}');
      })().catch((error: unknown) => {
        process.stderr.write(`capture failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
        response.writeHead(500);
        response.end();
      });
    });
  });
  server.listen(port, host, () => {
    process.stdout.write(`wechat-capture listening on http://${host}:${port} (raw store: ${dir})\n`);
  });
}
