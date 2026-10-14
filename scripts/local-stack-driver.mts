/** Actual child-process driver shared by the local CLI and isolated process rehearsals. */
import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { isPrivateIPv4, readCoreConfig, type EnvLike } from '../apps/core/config.mts';
import type { ManagedProcess } from './local-supervisor.mts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const pgExecutable = (bin: string, name: string) => join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
export type LocalStackPlatform = 'wechat' | 'qq';
export type LocalStackConfig = { platform: LocalStackPlatform; bridgeEntry: string; bin: string; data: string;
  bridges?: { name: string; platform: LocalStackPlatform; entry: string; port: number }[];
  databaseUrl: string; pgPort: number; corePort: number; bridgePort: number; env: EnvLike };
function required(env: EnvLike, name: string) { const value = env[name]?.trim(); if (!value) throw new Error(`MISSING_ENV:${name}`); return value; }
/** The bridge entry and required variables differ per platform; both stacks stay separately runnable. */
function platformSelection(platform: LocalStackPlatform) {
  if (platform === 'qq') return {
    entry: join(root, 'apps/bridge/main.mts'),
    required: ['QQ_ACCOUNT_ID', 'QQ_SELF_ID', 'QQ_BRIDGE_TOKEN'], outboundVar: 'QQ_ENABLE_OUTBOUND', outboundRequires: ['QQ_ONEBOT_BASE_URL'] };
  return { entry: join(root, 'apps/bridge/wechat-main.mts'),
    required: ['WECHAT_ACCOUNT_ID', 'WECHAT_SELF_REF', 'WECHAT_INGRESS_TOKEN', 'WECHAT_PROCESS_ID'],
    outboundVar: 'WECHAT_ENABLE_OUTBOUND', outboundRequires: ['WECHAT_WXHELPER_BASE_URL'] };
}
async function clusterPid(data: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(join(data, 'postmaster.pid'), 'utf8')).split(/\r?\n/)[0]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('CLUSTER_PID_INVALID'); return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('CLUSTER_PID_INVALID'); }
}
export async function readLocalStackConfig(input: EnvLike): Promise<LocalStackConfig> {
  const bin = required(input, 'LOCAL_PG_BIN'), data = required(input, 'LOCAL_PG_DATA');
  if (!isAbsolute(bin) || !isAbsolute(data)) throw new Error('PG_ABSOLUTE_PATH_REQUIRED');
  await access(pgExecutable(bin, 'postgres')); await access(pgExecutable(bin, 'pg_ctl'));
  if (!/^\d+\s*$/.test(await readFile(join(data, 'PG_VERSION'), 'utf8'))) throw new Error('EXISTING_PG_CLUSTER_REQUIRED');
  if (await clusterPid(data) !== undefined) throw new Error('LOCAL_CLUSTER_IN_USE');
  const databaseUrl = required(input, 'DATABASE_URL'), database = new URL(databaseUrl), pgPort = Number(database.port || '5432');
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1' || !Number.isSafeInteger(pgPort) || pgPort < 1 || pgPort > 65535) throw new Error('LOCAL_DATABASE_REQUIRED');
  const origin = new URL(required(input, 'PUBLIC_ORIGIN'));
  if (origin.protocol !== 'http:' || (origin.hostname !== '127.0.0.1' && !isPrivateIPv4(origin.hostname)) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('LOCAL_ORIGIN_REQUIRED');
  const corePort = Number(origin.port || '80');
  const platformInput = input.LOCAL_BRIDGE_PLATFORM?.trim() || 'wechat';
  if (platformInput !== 'wechat' && platformInput !== 'qq') throw new Error('LOCAL_BRIDGE_PLATFORM_INVALID');
  const platform: LocalStackPlatform = platformInput;
  const selection = platformSelection(platform);
  const enabled = input.LOCAL_STACK_PLATFORMS?.split(',').map(value=>value.trim()) ?? [platform];
  if (!enabled.length || enabled.some(value=>value!=='qq' && value!=='wechat') || new Set(enabled).size!==enabled.length) throw new Error('LOCAL_STACK_PLATFORMS_INVALID');
  const bridges = enabled.map((value,index) => ({ name: `bridge-${value}`, platform: value as LocalStackPlatform,
    entry: platformSelection(value as LocalStackPlatform).entry,
    port: Number(input[value==='qq' ? 'LOCAL_QQ_BRIDGE_PORT' : 'LOCAL_WECHAT_BRIDGE_PORT'] || (enabled.length===1 ? input.LOCAL_BRIDGE_PORT : undefined) || String(19099+index)) }));
  const ports=[pgPort,corePort,...bridges.map(b=>b.port)];
  if (ports.some(port=>!Number.isSafeInteger(port) || port<1 || port>65535) || new Set(ports).size!==ports.length) throw new Error('LOCAL_PORTS_INVALID');
  const bridgePort=bridges[0].port;
  // Only core is reachable over LAN. A wildcard also keeps loopback health checks working.
  const env = { ...input, HOST: isPrivateIPv4(origin.hostname) ? '0.0.0.0' : '127.0.0.1', START_PAUSED: input.START_PAUSED?.trim() || '0', CORE_PLATFORM: platform };
  readCoreConfig({ ...env, PORT: String(corePort) });
  for (const bridge of bridges) {
    const config=platformSelection(bridge.platform);
    for (const name of config.required) required(input,name);
    if (input[config.outboundVar]?.trim()==='1') for (const name of config.outboundRequires) required(input,name);
  }
  if (bridges.length>1 && input.QQ_ACCOUNT_ID===input.WECHAT_ACCOUNT_ID) throw new Error('LOCAL_ACCOUNT_IDS_CONFLICT');
  return { platform, bridgeEntry: selection.entry, bridges, bin, data, databaseUrl, pgPort, corePort, bridgePort, env };
}

async function freePort(port: number, host = '127.0.0.1') {
  await new Promise<void>((done, fail) => {
    const server = createServer(); server.once('error', () => fail(new Error('LOCAL_PORT_IN_USE')));
    server.listen(port, host, () => server.close(error => error ? fail(error) : done()));
  });
}
export function createLocalStackDriver(options: { config: LocalStackConfig; signal: AbortSignal;
  log(event: string, service?: string, measurement?: Record<string, unknown>): Promise<void>;
  /** In-memory test injection only. The production CLI never reads overrides from env or argv. */
  entries?: { core?: string; bridge?: string; 'bridge-qq'?: string; 'bridge-wechat'?: string; migrate?: string }; onSpawn?(service: string, child: ChildProcess): void;
  onCommandSpawn?(child: ChildProcess): void;
  startupMs?: number; stopMs?: number }) {
  const { config, log } = options, startupMs = options.startupMs ?? 30_000, stopMs = options.stopMs ?? 15_000;
  if (![startupMs, stopMs].every(ms => Number.isSafeInteger(ms) && ms > 0)) throw new Error('LOCAL_DRIVER_CONFIG_INVALID');
  let previousPostgres: { pid: number; exited: boolean } | undefined;
  async function command(file: string, args: string[], signal?: AbortSignal, timeout = startupMs) {
    await new Promise<void>((done, fail) => {
      const child = spawn(file, args, { windowsHide: true, stdio: 'ignore', env: config.env, cwd: root, timeout, signal });
      let error = false;
      child.once('error', () => { error = true; });
      child.once('close', code => error || code !== 0 ? fail(new Error('LOCAL_COMMAND_FAILED')) : done());
      try { options.onCommandSpawn?.(child); } catch { error = true; child.kill('SIGTERM'); }
    });
  }
  async function start(name: string): Promise<ManagedProcess> {
    const bridge=config.bridges?.find(b=>b.name===name);
    if (!['postgres', 'core', 'bridge'].includes(name) && !bridge) throw new Error('LOCAL_SERVICE_INVALID');
    if (options.signal.aborted) throw new Error('LOCAL_STOPPED');
    const port = name === 'postgres' ? config.pgPort : name === 'core' ? config.corePort : bridge?.port ?? config.bridgePort;
    await freePort(port, name === 'core' ? config.env.HOST : '127.0.0.1');
    if (name === 'postgres') {
      const pid = await clusterPid(config.data);
      if (pid !== undefined) {
        if (!previousPostgres?.exited || previousPostgres.pid !== pid) throw new Error('LOCAL_CLUSTER_IN_USE');
        try { process.kill(pid, 0); throw new Error('LOCAL_CLUSTER_IN_USE'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('LOCAL_CLUSTER_IN_USE'); }
        // postgres checks its own stale PID file. We never remove or replace it ourselves.
      }
    }
    if (options.signal.aborted) throw new Error('LOCAL_STOPPED');
    const lifecycle = new AbortController();
    const child = name === 'postgres'
      ? spawn(pgExecutable(config.bin, 'postgres'), ['-D', config.data, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'logging_collector=off', '-c', 'log_statement=none', '-c', 'log_min_error_statement=panic'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: config.env, cwd: root })
      : spawn(process.execPath, [name === 'core' ? options.entries?.core ?? join(root, 'apps/core/main.mts') : options.entries?.[name as 'bridge-qq' | 'bridge-wechat'] ?? options.entries?.bridge ?? bridge?.entry ?? config.bridgeEntry], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...config.env, HOST: name === 'core' ? config.env.HOST : '127.0.0.1', PORT: String(port) }, cwd: root });
    const ownership = name === 'postgres' && child.pid ? { pid: child.pid, exited: false } : undefined;
    let finished = false, failedLog = false, readyPromise: Promise<void> | undefined, stopPromise: Promise<void> | undefined;
    const exited = new Promise<void>(done => {
      const finish = () => {
        finished = true; if (ownership) ownership.exited = true; lifecycle.abort();
        child.stdout?.destroy(); child.stderr?.destroy(); done();
      };
      child.once('error', () => { lifecycle.abort(); if (child.pid === undefined) finish(); }); child.once('exit', finish);
    });
    try { options.onSpawn?.(name, child); }
    catch { lifecycle.abort(); child.kill('SIGTERM'); await exited; throw new Error('LOCAL_START_FAILED'); }
    for (const [stream, event] of [[child.stdout, 'process_output'], [child.stderr, 'process_error']] as const) {
      let noted = false, buffer = '', dropping = false;
      const write = (event: string, measurement?: Record<string, unknown>) => void log(event, name, measurement).catch(() => { failedLog = true; lifecycle.abort(); child.kill('SIGTERM'); });
      stream?.on('data', (chunk: Buffer) => {
        if (!noted) { noted = true; write(event); }
        if (event !== 'process_output' || name === 'postgres') return;
        for (const character of chunk.toString('utf8')) {
          if (character === '\n') {
            if (!dropping) { try { const row = JSON.parse(buffer); if (row?.event === 'model_call' || row?.event === 'media_model_call') write(row.event, row); } catch {} }
            buffer = ''; dropping = false;
          } else if (!dropping) {
            if (buffer.length >= 4096) { buffer = ''; dropping = true; } else buffer += character;
          }
        }
      });
    }
    return { exited, ready() {
      return readyPromise ??= (async () => {
        const signal = AbortSignal.any([options.signal, lifecycle.signal, AbortSignal.timeout(startupMs)]);
        const { Client } = await import('pg');
        while (!finished && !failedLog && !signal.aborted) {
          try {
            if (name === 'postgres') {
              if (await clusterPid(config.data) !== child.pid) throw new Error('NOT_OWNED');
              // A failed replacement that never acquired this cluster must not overwrite its last known owner.
              if (ownership) previousPostgres = ownership;
              const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 1000, query_timeout: 2000 });
              client.on('error', () => {});
              try { await client.connect(); await client.query('SELECT 1'); } finally { await client.end().catch(() => {}); }
              if (signal.aborted || finished) throw new Error('LOCAL_STOPPED');
              await command(process.execPath, [options.entries?.migrate ?? join(root, 'scripts/migrate.mts')], signal);
            } else {
              const response = await fetch(`http://127.0.0.1:${port}/${name === 'core' ? 'readyz' : 'healthz'}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'manual' });
              await response.body?.cancel(); if (!response.ok) throw new Error('NOT_READY');
            }
            if (signal.aborted || finished || failedLog) throw new Error('LOCAL_STOPPED'); return;
          } catch { if (!signal.aborted) await sleep(100, undefined, { signal }); }
        }
        throw new Error('LOCAL_START_FAILED');
      })();
    }, stop() {
      return stopPromise ??= (async () => {
        lifecycle.abort(); await readyPromise?.catch(() => {});
        if (finished) return;
        if (name === 'postgres' && await clusterPid(config.data) === child.pid) {
          await command(pgExecutable(config.bin, 'pg_ctl'), ['-D', config.data, 'stop', '-m', 'fast', '-w', '-t', String(Math.max(1, Math.ceil(stopMs / 1000)))], undefined, stopMs);
        } else child.kill('SIGTERM');
        await Promise.race([exited, sleep(stopMs, undefined, { ref: false }).then(() => { throw new Error('LOCAL_STOP_FAILED'); })]);
      })();
    } };
  }
  return { start };
}
