import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await sources(path));
    else if (['.mts', '.mjs', '.ts', '.tsx'].includes(extname(entry.name)) && !entry.name.includes('.test.')) paths.push(path);
  }
  return paths;
}

test('04/05/06 production modules cannot import platform send implementation', async () => {
  for (const directory of ['packages/ai', 'packages/skills', 'apps/web/src']) {
    for (const path of await sources(directory)) {
      const content = await readFile(resolve(root, path), 'utf8');
      for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) continue;
        const target = relative(root, resolve(root, dirname(path), specifier)).replaceAll('\\', '/');
        assert.ok(!target.startsWith('packages/platform/') && !target.startsWith('packages/orchestration/dispatch/'), `${path} imports privileged ${target}`);
      }
      assert.doesNotMatch(content, /\bsubmitSend\s*\(/, `${path} must not invoke platform sending`);
    }
  }
});

test('the WeChat media path cannot reach the send port', async () => {
  // 01 reads original files and 02 sends; sharing a process must not let one become the other.
  for (const path of ['packages/platform/wechat/wxhelper-media-transport.mts', 'packages/platform/wechat/media-acquisition.mts',
    'packages/platform/wechat/media-dat.mts', 'packages/data/media/image-validation.mts',
    'packages/data/media/image-validation-worker.mjs', 'packages/data/media/bounded-image-file.mts',
    'packages/data/media/pg-private-reader.mts', 'packages/orchestration/postgres/media-preparation.mts']) {
    const content = await readFile(resolve(root, path), 'utf8');
    assert.ok(!content.includes('wxhelper-send-port'), `${path} must not import the send port`);
    assert.doesNotMatch(content, /\bsubmitSend\s*\(/, `${path} must not invoke platform sending`);
  }
});

test('global migrations have unique consecutive numbers and never use per-module numbering', async () => {
  const directory = resolve(root, 'db/migrations');
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  assert.ok(names.length > 0, 'at least one global migration is required');
  names.forEach((name, index) => assert.match(name, new RegExp(`^${String(index + 1).padStart(4, '0')}_[a-z0-9_]+\\.sql$`)));
});

/** The production core shares a database with the bridges but must never be able to send. Being
 * unable to reach an adapter is what makes that structural rather than a promise in a document. */
test('the core runtime cannot reach a platform adapter, dispatch, or any send call', async () => {
  const paths = await sources('apps/core');
  assert.ok(paths.length > 0, 'apps/core must exist');
  for (const path of paths) {
    const content = await readFile(resolve(root, path), 'utf8');
    for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith('.')) continue;
      const target = relative(root, resolve(root, dirname(path), specifier)).replaceAll('\\', '/');
      assert.ok(!target.startsWith('packages/platform/'), `${path} imports platform adapter ${target}`);
      assert.ok(!target.startsWith('apps/bridge/'), `${path} imports a bridge composition root`);
    }
    assert.doesNotMatch(content, /\bsubmitSend\s*\(/, `${path} must not invoke platform sending`);
    assert.doesNotMatch(content, /dispatchEnabled\s*:\s*true/, `${path} must not enable dispatch`);
  }
});
