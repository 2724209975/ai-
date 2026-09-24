/** QQ receive-only spike helper.
 *
 * Usage:
 *   node scripts/qq-spike-summary.mts posture   # check the runbook's receive-only posture, no DB
 *   node scripts/qq-spike-summary.mts summary   # redacted evidence counts for one account (default)
 *
 * Env: QQ_ACCOUNT_ID (required), DATABASE_URL (required for `summary`), RAW_EVENT_DIR (optional).
 * Output is aggregate only: no chat body, peer number, URL or raw hash is ever printed.
 */
import { assertReceiveOnlyPosture, collectSpikeEvidence } from '../packages/platform/qq/spike-evidence.mts';

const command = (process.argv[2] ?? 'summary').trim();

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (command === 'posture') {
  // The posture check is about configuration, not about an account.
  print({ command, ...assertReceiveOnlyPosture(process.env), checkedAt: new Date().toISOString() });
} else if (command === 'summary') {
  const accountId = process.env.QQ_ACCOUNT_ID?.trim();
  if (!accountId) throw new Error('MISSING_ENV:QQ_ACCOUNT_ID');
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('MISSING_ENV:DATABASE_URL');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    print(await collectSpikeEvidence(pool, { accountId, rawRoot: process.env.RAW_EVENT_DIR?.trim() || undefined }));
  } finally { await pool.end(); }
} else {
  throw new Error(`UNKNOWN_COMMAND:${command}`);
}
