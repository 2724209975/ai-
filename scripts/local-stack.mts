/** Local-only process owner. It never starts, injects or logs into WeChat/helper. */
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { readCoreConfig } from '../apps/core/config.mts';
import { superviseLocalStack, rotatingStackLog, type ManagedProcess } from './local-supervisor.mts';

function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`MISSING_ENV:${name}`); return value; }
const bin = required('LOCAL_PG_BIN'), data = required('LOCAL_PG_DATA');
if (!isAbsolute(bin) || !isAbsolute(data)) throw new Error('PG_ABSOLUTE_PATH_REQUIRED');
await access(join(bin, 'postgres.exe')); await access(join(bin, 'pg_ctl.exe'));
if (!/^\d+\s*$/.test(await readFile(join(data, 'PG_VERSION'), 'utf8'))) throw new Error('EXISTING_PG_CLUSTER_REQUIRED');
const database = new URL(required('DATABASE_URL'));
const pgPort = Number(database.port || '5432');
if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1' || !Number.isSafeInteger(pgPort) || pgPort < 1 || pgPort > 65535) throw new Error('LOCAL_DATABASE_REQUIRED');
const origin = new URL(required('PUBLIC_ORIGIN'));
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('LOCAL_ORIGIN_REQUIRED');
const corePort = Number(origin.port || '80'), bridgePort = Number(process.env.LOCAL_BRIDGE_PORT || '19099');
if (!Number.isSafeInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535 || new Set([pgPort, corePort, bridgePort]).size !== 3) throw new Error('LOCAL_PORTS_INVALID');
const env = { ...process.env, HOST: '127.0.0.1', START_PAUSED: '1', CORE_PLATFORM: 'wechat' };
readCoreConfig({ ...env, PORT: String(corePort) });
required('WECHAT_ACCOUNT_ID'); required('WECHAT_SELF_REF'); required('WECHAT_INGRESS_TOKEN'); required('WECHAT_PROCESS_ID');
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
const log = rotatingStackLog(resolve('.local-stack-logs'));
const { Client } = await import('pg');

async function freePort(port: number) {
  await new Promise<void>((done, fail) => {
    const server = createServer(); server.once('error', () => fail(new Error('LOCAL_PORT_IN_USE')));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? fail(error) : done()));
  });
}
async function command(file: string, args: string[]) {
  await new Promise<void>((done, fail) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore', env, timeout: 30_000 });
    child.once('error', fail); child.once('exit', code => code === 0 ? done() : fail(new Error('LOCAL_COMMAND_FAILED')));
  });
}
async function start(name: string): Promise<ManagedProcess> {
  const port = name === 'postgres' ? pgPort : name === 'core' ? corePort : bridgePort;
  await freePort(port);
  const child = name === 'postgres'
    ? spawn(join(bin, 'postgres.exe'), ['-D', data, '-p', String(pgPort), '-c', 'listen_addresses=127.0.0.1', '-c', 'logging_collector=off', '-c', 'log_statement=none', '-c', 'log_min_error_statement=panic'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    : spawn(process.execPath, [name === 'core' ? 'apps/core/main.mts' : 'apps/bridge/wechat-main.mts'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(port) } });
  let finished = false, failedLog = false;
  const exited = new Promise<void>(done => {
    const finish = () => { finished = true; done(); }; child.once('error', finish); child.once('exit', finish);
  });
  // Fixed process notices plus whitelisted model metrics; bounded parsing discards raw output.
  for (const [stream, event] of [[child.stdout, 'process_output'], [child.stderr, 'process_error']] as const) {
    let noted = false;
    let buffer = '', dropping = false;
    const write = (event: string, measurement?: Record<string, unknown>) => void log(event, name, measurement).catch(() => { failedLog = true; controller.abort(); });
    stream?.on('data', (chunk: Buffer) => {
      if (!noted) { noted = true; write(event); }
      if (event !== 'process_output' || name === 'postgres') return;
      for (const character of chunk.toString('utf8')) {
        if (character === '\n') {
          if (!dropping) { try { const row = JSON.parse(buffer); if (row?.event === 'model_call') write('model_call', row); } catch {} }
          buffer = ''; dropping = false;
        } else if (!dropping) {
          if (buffer.length >= 4096) { buffer = ''; dropping = true; } else buffer += character;
        }
      }
    });
  }
  return { exited, async ready() {
    const deadline = Date.now() + 30_000;
    while (!finished && !failedLog && !controller.signal.aborted && Date.now() < deadline) {
      try {
        if (name === 'postgres') {
          const client = new Client({ connectionString: database.href, connectionTimeoutMillis: 1000, query_timeout: 2000 });
          client.on('error', () => {});
          try { await client.connect(); await client.query('SELECT 1'); } finally { await client.end().catch(() => {}); }
          await command(process.execPath, ['scripts/migrate.mts']);
        } else {
          const response = await fetch(`http://127.0.0.1:${port}/${name === 'core' ? 'readyz' : 'healthz'}`, { signal: AbortSignal.timeout(1000), redirect: 'manual' });
          await response.body?.cancel(); if (!response.ok) throw new Error('NOT_READY');
        }
        return;
      } catch { await sleep(250); }
    }
    throw new Error('LOCAL_START_FAILED');
  }, async stop() {
    if (finished) return;
    if (name === 'postgres') {
      await command(join(bin, 'pg_ctl.exe'), ['-D', data, 'stop', '-m', 'fast', '-w', '-t', '15']);
    } else child.kill('SIGTERM');
    await Promise.race([exited, sleep(15_000, undefined, { ref: false }).then(() => { throw new Error('LOCAL_STOP_FAILED'); })]);
  } };
}
await superviseLocalStack({ names: ['postgres', 'core', 'bridge'], start, signal: controller.signal, log });
