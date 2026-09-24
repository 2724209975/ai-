/** Operator-only read of opaque QQ spike evidence IDs. Keep the output in a private local file. */
import { collectSpikeManifest } from '../packages/platform/qq/spike-evidence.mts';

const databaseUrl = process.env.DATABASE_URL?.trim();
const accountId = process.env.QQ_ACCOUNT_ID?.trim();
if (!databaseUrl || !accountId) throw new Error('DATABASE_URL_AND_QQ_ACCOUNT_ID_REQUIRED');
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const rows = await collectSpikeManifest(pool, accountId, process.env.RAW_EVENT_DIR?.trim() || undefined);
  process.stdout.write(`${JSON.stringify({ accountId, observedAt: new Date().toISOString(), rows,
    limitation: '仅是可追溯的私有数据库行索引；不单独证明 QQ 来源、媒体完整性或历史覆盖。' }, null, 2)}\n`);
} finally { await pool.end(); }
