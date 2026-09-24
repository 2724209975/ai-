/** Assemble the G2 spike report from the capability snapshot and the redacted evidence summary.
 *
 * Usage: DATABASE_URL=... QQ_ACCOUNT_ID=... node scripts/qq-spike-report.mts
 * Env knobs: SPIKE_PLATFORM (qq|wechat, default qq), SPIKE_SNAPSHOT (path, default newest snapshot
 * for the platform), SPIKE_DATE (default today), SPIKE_OUT (default docs/reports/platform-<p>-<date>.md),
 * SPIKE_VERDICT (one of the four, default UNDECIDED), SPIKE_NOTES, SPIKE_PROPOSALS (semicolon list),
 * SPIKE_ENV_EXTRA (semicolon list of key=value, for host facts only the operator knows).
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCapabilitySnapshot } from '../packages/contracts/index.mts';
import { collectSpikeEvidence } from '../packages/platform/qq/spike-evidence.mts';
import { renderSpikeReport, SPIKE_VERDICTS, type SpikeVerdictOrUndecided } from '../packages/platform/qq/spike-report.mts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = (process.env.SPIKE_PLATFORM?.trim() || 'qq') as 'qq' | 'wechat';
if (!['qq', 'wechat'].includes(platform)) throw new Error('INVALID_ENV:SPIKE_PLATFORM');
const accountId = process.env.QQ_ACCOUNT_ID?.trim();
if (!accountId) throw new Error('MISSING_ENV:QQ_ACCOUNT_ID');
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('MISSING_ENV:DATABASE_URL');
const date = (process.env.SPIKE_DATE?.trim() || new Date().toISOString().slice(0, 10));
if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error('INVALID_ENV:SPIKE_DATE');
const verdict = (process.env.SPIKE_VERDICT?.trim() || 'UNDECIDED') as SpikeVerdictOrUndecided;
if (verdict !== 'UNDECIDED' && !(SPIKE_VERDICTS as readonly string[]).includes(verdict)) throw new Error('INVALID_ENV:SPIKE_VERDICT');

async function newestSnapshot(): Promise<string> {
  const dir = resolve(root, 'docs/reports');
  const candidates = (await readdir(dir)).filter(name => name.startsWith(`platform-${platform}-capability-snapshot-`) && name.endsWith('.json')).sort();
  if (!candidates.length) throw new Error(`NO_SNAPSHOT_FOR:${platform}`);
  return join(dir, candidates[candidates.length - 1]!);
}

const snapshotPath = process.env.SPIKE_SNAPSHOT?.trim() ? resolve(process.env.SPIKE_SNAPSHOT.trim()) : await newestSnapshot();
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;
assertCapabilitySnapshot(snapshot);

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
let report: string;
let outputPath: string;
try {
  const summary = await collectSpikeEvidence(pool, { accountId, rawRoot: process.env.RAW_EVENT_DIR?.trim() || undefined });
  const serverVersion = (await pool.query<{ version: string }>("SELECT current_setting('server_version') AS version")).rows[0]?.version ?? 'unknown';
  const extra = (process.env.SPIKE_ENV_EXTRA?.trim() || '').split(';').map(part => part.trim()).filter(Boolean)
    .map(part => { const [key, ...rest] = part.split('='); return [key!.trim(), rest.join('=').trim()] as [string, string]; });
  const environment = Object.fromEntries([
    ['操作人填写的宿主事实', extra.length ? '见下' : '未提供（SPIKE_ENV_EXTRA）'],
    ...extra,
    ['运行时', `Node ${process.version} · ${process.platform}/${process.arch}`],
    ['PostgreSQL', serverVersion],
    ['适配器', 'qq-onebot bridge（apps/bridge）'],
  ]);
  report = renderSpikeReport({ platform, dateIso: new Date(`${date}T00:00:00.000Z`).toISOString(), accountId,
    adapterVersion: snapshot.adapterVersion, snapshot, summary, environment, verdict,
    notes: process.env.SPIKE_NOTES?.trim() || undefined,
    contractProposals: (process.env.SPIKE_PROPOSALS?.trim() || '').split(';').map(part => part.trim()).filter(Boolean) });
} finally {
  await pool.end();
}

outputPath = process.env.SPIKE_OUT?.trim() ? resolve(process.env.SPIKE_OUT.trim()) : resolve(root, `docs/reports/platform-${platform}-${date}.md`);
await writeFile(outputPath, report, { encoding: 'utf8', flag: 'wx' }).catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`REPORT_ALREADY_EXISTS:${outputPath}`);
  throw error;
});
process.stdout.write(`${JSON.stringify({ report: outputPath, snapshot: snapshotPath, verdict,
  note: verdict === 'UNDECIDED' ? '未填写结论：G2 仍未完成，判定只能由本人确认' : '结论已写入，仍需本人确认', }, null, 2)}\n`);
