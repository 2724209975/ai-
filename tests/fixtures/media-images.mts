/** Synthetic complete images, not user media. PNG chunks/CRC are generated independently of sharp. */
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';

function chunk(type: string, body: Buffer): Buffer {
  const data = Buffer.concat([Buffer.from(type), body]);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), sum = Buffer.alloc(4);
  length.writeUInt32BE(body.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, data, sum]);
}
export function makePng(width = 3, height = 2): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 180);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const png = makePng();
export const jpeg = await sharp(png).jpeg().toBuffer();
export const gif = await sharp(png).gif().toBuffer();
export const webp = await sharp(png).webp().toBuffer();
export const apng = Buffer.concat([png.subarray(0, 33), chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])), png.subarray(33)]);
const frames = Buffer.from([255, 0, 0, 0, 255, 0]);
export const animatedGif = await sharp(frames, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100, 100] }).toBuffer();
export const animatedWebp = await sharp(frames, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).webp({ delay: [100, 100] }).toBuffer();
