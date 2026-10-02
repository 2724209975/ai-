/** Dedicated native decoder; IPC output is bounded metadata only, never pixels or error text. */
import sharp from 'sharp';
sharp.cache(false);
sharp.concurrency(1);
process.once('message', async ({ bytes, mimeType, maxPixels }) => {
  let result = { ok: false };
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length > 10 * 1024 * 1024) throw new Error();
    const decoder = sharp(Buffer.from(bytes), { animated: true, failOn: 'warning',
      limitInputPixels: maxPixels, limitInputChannels: 4, unlimited: false });
    const meta = await decoder.metadata();
    const expected = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' }[mimeType];
    if (!expected || meta.format !== expected || (meta.pages ?? 1) !== 1 || !meta.width || !meta.height ||
      meta.width * meta.height > maxPixels) throw new Error();
    // Metadata is insufficient: force every pixel through the decoder, without resizing.
    const { info, data } = await decoder.timeout({ seconds: 3 }).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== meta.width || info.height !== meta.height || data.length !== info.width * info.height * info.channels)
      throw new Error();
    result = { ok: true, width: info.width, height: info.height };
  } catch { /* Fixed refusal; native decoder diagnostics never leave this process. */ }
  if (process.connected) process.send(result, () => process.exit(0));
  else process.exit(0);
});
