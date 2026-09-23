import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const indicators = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/,
];

async function scan(directory: string): Promise<void> {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scan(path);
    else if (/\.(?:mts|ts|tsx|json|sql|ya?ml|md)$/.test(entry.name) && !entry.name.endsWith('.lock.json')) {
      const content = await readFile(resolve(root, path), 'utf8');
      for (const pattern of indicators) assert.doesNotMatch(content, pattern, `possible credential in ${path}`);
    }
  }
}

test('source and deployment templates contain no high-confidence credential patterns', async () => {
  for (const directory of ['packages', 'apps/web/src', 'deploy']) await scan(directory);
});
