/** Local-only process owner. No test overrides, WeChat startup, login or injection capability. */
import { resolve } from 'node:path';
import { createLocalStackDriver, readLocalStackConfig } from './local-stack-driver.mts';
import { superviseLocalStack, rotatingStackLog } from './local-supervisor.mts';

const config = await readLocalStackConfig(process.env);
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
const sink = rotatingStackLog(resolve('.local-stack-logs'));
const log: typeof sink = async (...args) => { try { await sink(...args); } catch { controller.abort(); throw new Error('LOCAL_LOG_FAILED'); } };
const driver = createLocalStackDriver({ config, signal: controller.signal, log });
await superviseLocalStack({ names: ['postgres', 'core', 'bridge'], start: driver.start, signal: controller.signal, log });
