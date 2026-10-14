/** Local process owner with explicit LAN management access. No test overrides or platform login/injection.
 *
 * LOCAL_STACK_PLATFORMS=qq,wechat runs independent bridges on one database/core.
 * LOCAL_BRIDGE_PLATFORM retains the original single-platform configuration.
 */
import { resolve } from 'node:path';
import { createLocalStackDriver, readLocalStackConfig } from './local-stack-driver.mts';
import { superviseLocalStack, rotatingStackLog } from './local-supervisor.mts';

const config = await readLocalStackConfig(process.env);
console.log(`管理页面地址（启动完成后访问）：${config.env.PUBLIC_ORIGIN}`);
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
const sink = rotatingStackLog(resolve('.local-stack-logs'));
const log: typeof sink = async (...args) => { try { await sink(...args); } catch { controller.abort(); throw new Error('LOCAL_LOG_FAILED'); } };
const driver = createLocalStackDriver({ config, signal: controller.signal, log });
const bridgeNames = config.bridges!.map(bridge=>bridge.name);
await superviseLocalStack({ names: ['postgres', 'core', ...bridgeNames], isolatedServices: bridgeNames, start: driver.start, signal: controller.signal, log });
