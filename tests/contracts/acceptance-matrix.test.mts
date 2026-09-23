import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('AC01–AC42 evidence matrix has owners and independent mock/WeChat/QQ results', async () => {
  const lines = (await readFile(resolve(root, 'docs/reports/acceptance-matrix.csv'), 'utf8')).trim().split(/\r?\n/);
  const headers = lines.shift()!.split(',');
  assert.deepEqual(headers, ['ac', 'owner', 'collaborators', 'status', 'environment', 'commit', 'command', 'steps', 'result', 'evidence', 'skip_reason', 'limitations', 'next_dependency', 'mock_status', 'wechat_status', 'qq_status']);
  assert.equal(lines.length, 42);
  for (const [index, line] of lines.entries()) {
    const fields = line.split(',');
    assert.equal(fields.length, headers.length, `AC${index + 1} column count`);
    const row = Object.fromEntries(headers.map((header, column) => [header, fields[column]]));
    assert.equal(row.ac, `AC${String(index + 1).padStart(2, '0')}`);
    assert.match(row.owner!, /^0[1-7]$/);
    for (const field of ['collaborators', 'environment', 'commit', 'command', 'steps', 'result', 'evidence', 'skip_reason', 'limitations', 'next_dependency']) assert.ok(row[field], `${row.ac} ${field}`);
    for (const field of ['status', 'mock_status', 'wechat_status', 'qq_status']) assert.ok(['not-run', 'pass', 'fail', 'blocked'].includes(row[field]!), `${row.ac} ${field}`);
    if (row.ac === 'AC23') assert.match(row.environment!, /wechat-real\/qq-real/);
  }
});
