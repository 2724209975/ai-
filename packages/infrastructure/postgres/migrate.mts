import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PgClient } from './transaction.mts';

/** Run on one dedicated connection before API/worker start; never edit an applied migration. */
export async function applyMigrations(client: PgClient, directory = resolve('db/migrations')): Promise<string[]> {
  const files = (await readdir(directory)).filter(x => /^\d{4}_[a-z0-9_]+\.sql$/.test(x)).sort();
  const numbers = files.map(x => Number(x.slice(0, 4)));
  if (numbers.some((n, i) => n !== i + 1)) throw new Error('MIGRATION_SEQUENCE_GAP');
  await client.query('SELECT pg_advisory_lock($1)', [220923]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      number integer PRIMARY KEY, filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied: string[] = [];
    for (const [index, filename] of files.entries()) {
      const sql = await readFile(resolve(directory, filename), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ filename: string; sha256: string }>('SELECT filename,sha256 FROM schema_migrations WHERE number=$1', [index + 1]);
      if (existing.rows.length) {
        if (existing.rows[0]?.filename !== filename || existing.rows[0]?.sha256 !== sha256) throw new Error(`MIGRATION_DRIFT:${filename}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (number,filename,sha256) VALUES ($1,$2,$3)', [index + 1, filename, sha256]);
        await client.query('COMMIT');
        applied.push(filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [220923]);
  }
}
