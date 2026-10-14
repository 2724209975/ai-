import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contentHash, requestKey } from '../src/browser-crypto.ts';

test('browser hashing matches backend UTF-8 JSON for edited and multipart replies', async () => {
  for (const parts of [[], [{ type: 'text', content: '你好 👋\n"可以呀"' }],
    [{ type: 'text', content: '第一段' }, { type: 'text', content: '第二段\r\n café' }]]) {
    assert.equal(await contentHash(parts), createHash('sha256').update(JSON.stringify(parts)).digest('hex'));
  }
});

test('request keys use UUID v4 bits and independent secure randomness', () => {
  const keys = Array.from({ length: 1000 }, requestKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
