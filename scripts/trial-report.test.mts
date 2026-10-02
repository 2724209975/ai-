import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { localTrialDatabase, trialArguments } from './trial-report.mts';
test('trial CLI accepts only local PostgreSQL, bounded unique logs and explicit Markdown', () => {
  assert.equal(localTrialDatabase('postgres://u@127.0.0.1/db'), 'postgres://u@127.0.0.1/db');
  for (const url of ['http://localhost/db', 'postgres://remote.example/db', '', 'postgres://127.0.0.1.evil/db']) assert.throws(() => localTrialDatabase(url));
  assert.equal(trialArguments(['--markdown', 'one.jsonl']).format, 'markdown');
  for (const args of [['--unknown'], ['x', './x'], ['--markdown', '--markdown'], Array.from({ length: 21 }, (_, i) => `log-${i}`)]) assert.throws(() => trialArguments(args));
});
test('trial CLI failure prints fixed text without IDs, URL credentials or error details', () => {
  const result = spawnSync(process.execPath, ['scripts/trial-report.mts'], { encoding: 'utf8', env: { ...process.env,
    TRIAL_CONTACT_IDS: 'PRIVATE_CONTACT', DATABASE_URL: 'postgres://PRIVATE_SECRET@private.example/PRIVATE_DATABASE' } });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'TRIAL_REPORT_FAILED: check local database, contact scope, time window and optional logs/rates\n');
});
