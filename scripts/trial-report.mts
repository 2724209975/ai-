/** 本机开发用，只读统计；环境中的联系人 ID 与日志文件路径永不输出。 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trialWindow, tariffFromEnv, renderTrialMarkdown } from '../packages/ai/eval/trial-report.mts';
import { readTrialReport } from '../packages/ai/eval/trial-report-postgres.mts';

export function localTrialDatabase(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new Error('LOCAL_DATABASE_REQUIRED'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('LOCAL_DATABASE_REQUIRED');
  return value!;
}
export function trialArguments(args: string[]) {
  const format = args.includes('--markdown') ? 'markdown' : 'json';
  if (args.filter(a => a === '--markdown').length > 1 || args.some(a => a.startsWith('--') && a !== '--markdown')) throw new Error('TRIAL_ARGUMENT_INVALID');
  const paths = args.filter(a => a !== '--markdown').map(p => resolve(p));
  if (paths.length > 20 || new Set(paths).size !== paths.length) throw new Error('TRIAL_LOG_ARGUMENT_INVALID');
  return { format, paths };
}
async function main() {
  const window = trialWindow(process.env), tariff = tariffFromEnv(process.env);
  const databaseUrl = localTrialDatabase(process.env.DATABASE_URL), args = trialArguments(process.argv.slice(2));
  const logs: string[] = []; let bytes = 0;
  for (const path of args.paths) {
    const size = (await stat(path)).size; bytes += size;
    if (bytes > 20_000_000) throw new Error('TRIAL_LOG_TOO_LARGE');
    const log = await readFile(path, 'utf8');
    if (Buffer.byteLength(log) > size + 4096) throw new Error('TRIAL_LOG_CHANGED');
    logs.push(log);
  }
  const { Client } = await import('pg');
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect(); const report = await readTrialReport(client, window, logs, tariff);
    process.stdout.write(args.format === 'markdown' ? renderTrialMarkdown(report) : JSON.stringify(report, null, 2) + '\n');
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { process.stderr.write('TRIAL_REPORT_FAILED: check local database, contact scope, time window and optional logs/rates\n'); process.exitCode = 1; });
