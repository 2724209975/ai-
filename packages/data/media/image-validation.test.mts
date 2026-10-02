import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateImageBytes, IMAGE_MAX_BYTES } from './image-validation.mts';
import { readBoundedImageFile } from './bounded-image-file.mts';
import { png, jpeg, gif, webp, apng, animatedGif, animatedWebp } from '../../../tests/fixtures/media-images.mts';

test('complete PNG/JPEG/GIF/WebP decode every pixel without changing source bytes', async () => {
  for (const [bytes, mime] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [gif, 'image/gif'], [webp, 'image/webp']] as const) {
    const before = createHash('sha256').update(bytes).digest('hex');
    assert.deepEqual(await validateImageBytes(bytes, mime), { ok: true, width: 3, height: 2 });
    assert.equal(createHash('sha256').update(bytes).digest('hex'), before);
  }
});

test('truncation, corrupt compressed pixels, trailing images and mismatched MIME all fail closed', async () => {
  for (let n = 0; n < png.length; n++) assert.equal((await validateImageBytes(png.subarray(0, n), 'image/png')).ok, false);
  const corrupt = Buffer.from(png); corrupt[41] ^= 0xff;
  const malformed = [
    [corrupt, 'image/png'], [png, 'image/jpeg'], [Buffer.concat([png, png]), 'image/png'],
    [Buffer.concat([jpeg, jpeg]), 'image/jpeg'], [Buffer.concat([gif, gif]), 'image/gif'],
    [jpeg.subarray(0, jpeg.length - 2), 'image/jpeg'],
    [Buffer.concat([jpeg.subarray(0, jpeg.length - 10), Buffer.from([255, 217])]), 'image/jpeg'],
    [Buffer.concat([gif.subarray(0, gif.length - 5), Buffer.from([59])]), 'image/gif'],
    [webp.subarray(0, webp.length - 2), 'image/webp'],
  ] as const;
  for (const [bytes, mime] of malformed) assert.equal((await validateImageBytes(bytes, mime)).ok, false, mime);
});

test('animation is not mistaken for full-image coverage, and BMP stays unsupported', async () => {
  for (const [bytes, mime] of [[apng, 'image/png'], [animatedGif, 'image/gif'], [animatedWebp, 'image/webp']] as const)
    assert.equal((await validateImageBytes(bytes, mime)).ok, false, mime);
  assert.deepEqual(await validateImageBytes(Buffer.from('BMabcdef'), 'image/bmp'), { ok: false, reason: 'unsupported' });
});

test('byte/pixel limits, decoder timeout and abort reject work; the decoder can run again afterwards', async () => {
  assert.equal((await validateImageBytes(Buffer.alloc(IMAGE_MAX_BYTES + 1), 'image/png')).ok, false);
  assert.equal((await validateImageBytes(png, 'image/png', { maxPixels: 5 })).ok, false);
  assert.deepEqual(await validateImageBytes(png, 'image/png', { timeoutMs: 1 }), { ok: false, reason: 'timeout' });
  const controller = new AbortController();
  const pending = validateImageBytes(png, 'image/png', { signal: controller.signal }); controller.abort();
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
  assert.deepEqual(await validateImageBytes(png, 'image/png', { signal: controller.signal }), { ok: false, reason: 'cancelled' });
  assert.equal((await validateImageBytes(png, 'image/png')).ok, true);
});

test('native decoding concurrency is bounded without accumulating a request queue', async () => {
  const first = validateImageBytes(png, 'image/png'), second = validateImageBytes(png, 'image/png');
  assert.deepEqual(await validateImageBytes(png, 'image/png'), { ok: false, reason: 'busy' });
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
});

test('descriptor reading enforces the actual file size and rejects non-files and cancelled reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-agent-image-bound-')), path = join(root, 'synthetic.dat');
  try {
    await writeFile(path, png);
    assert.deepEqual(await readBoundedImageFile(path, png.length, new AbortController().signal), png);
    await assert.rejects(readBoundedImageFile(path, png.length - 1, new AbortController().signal), /MEDIA_FILE_TOO_LARGE/);
    await assert.rejects(readBoundedImageFile(root, png.length, new AbortController().signal));
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(readBoundedImageFile(path, png.length, aborted.signal), /MEDIA_FILE_CANCELLED/);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(join(tmpdir(), 'chat-agent-image-bound-'))));
    await rm(root, { recursive: true, force: true });
  }
});
