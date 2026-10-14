import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readSharedBudget } from '../packages/ai/generation/persistent-budget.mts';
import type { EnvLike } from '../apps/core/config.mts';

export type PortalModel = { enabled: boolean; apiKey?: string; model: 'deepseek-flash' | 'deepseek-v4-pro'; totalCny?: number; dailyCny: number; dailyCalls: number; dailyTokens: number; inputPrice: number; outputPrice: number };
export const modelDefaults: PortalModel = { enabled: false, model: 'deepseek-flash', dailyCny: 1, dailyCalls: 100, dailyTokens: 500_000, inputPrice: 2, outputPrice: 8 };
export function validatePortalModel(body: Record<string, unknown>, previous = modelDefaults): PortalModel {
  const next = { ...previous, ...body } as PortalModel;
  if (Object.keys(body).some(key => !['enabled', 'apiKey', 'model', 'totalCny', 'dailyCny', 'dailyCalls', 'dailyTokens', 'inputPrice', 'outputPrice'].includes(key))
    || typeof next.enabled !== 'boolean' || !['deepseek-flash', 'deepseek-v4-pro'].includes(next.model)
    || next.totalCny !== undefined && (!Number.isFinite(next.totalCny) || next.totalCny < 0 || next.totalCny > 10)
    || !Number.isFinite(next.dailyCny) || next.dailyCny <= 0 || next.dailyCny > 10_000
    || ![next.dailyCalls, next.dailyTokens].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 100_000_000)
    || ![next.inputPrice, next.outputPrice].every(value => Number.isFinite(value) && value > 0 && value <= 1000)
    || next.inputPrice < (next.model === 'deepseek-flash' ? 2 : 9) || next.outputPrice < (next.model === 'deepseek-flash' ? 8 : 27)
    || next.enabled && (typeof next.apiKey !== 'string' || next.apiKey.trim().length < 8 || next.apiKey.length > 512 || /[\s\u0000-\u001f]/.test(next.apiKey))) throw new Error('VALIDATION_FAILED');
  return next;
}
export async function readPortalModel(root: string) {
  try { return validatePortalModel(JSON.parse(await readFile(join(root, '.local-launch/model.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...modelDefaults }; throw new Error('MODEL_CONFIG_INVALID'); }
}
export async function savePortalModel(root: string, value: PortalModel) {
  const directory = join(root, '.local-launch'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'model.json'), temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export function applyPortalModel(env: EnvLike, root: string, config: PortalModel) {
  // Model configuration never authorizes sending or grants another copy of trial funds.
  Object.assign(env, { INTELLIGENCE_PROVIDER: config.enabled ? 'deepseek' : 'persistent-fake',
    QQ_INTELLIGENCE: config.enabled ? 'deepseek' : 'persistent-fake', WECHAT_INTELLIGENCE: config.enabled ? 'deepseek' : 'persistent-fake',
    COLLECTION_ENABLED: config.enabled ? '1' : '0',
    QQ_ENABLE_OUTBOUND: '0', WECHAT_ENABLE_OUTBOUND: '0', WORKER_ENABLED: '0',
    DEEPSEEK_API_KEY: config.apiKey ?? '', DEEPSEEK_MODEL: config.model, DEEPSEEK_MODEL_VERSION: config.model,
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com', DEEPSEEK_THINKING: 'disabled', DEEPSEEK_MAX_TOKENS: '2000',
    DEEPSEEK_DAILY_CNY_LIMIT: String(config.dailyCny), DEEPSEEK_DAILY_CALL_LIMIT: String(config.dailyCalls), DEEPSEEK_DAILY_TOKEN_LIMIT: String(config.dailyTokens),
    DEEPSEEK_INPUT_CNY_PER_MILLION: String(config.inputPrice), DEEPSEEK_OUTPUT_CNY_PER_MILLION: String(config.outputPrice),
    DEEPSEEK_SHARED_BUDGET_PATH: join(root, '.local-launch/model-budget.json'),
    MODEL_SHARED_BUDGET_PATH: join(root, '.local-launch/model-budget.json'),
    MODEL_TOTAL_CNY_LIMIT: String(config.totalCny ?? 0),
    MODEL_DAILY_CNY_LIMIT: String(Math.min(config.dailyCny, config.totalCny ?? 0)) });
}
export async function describePortalModel(root: string, config: PortalModel) {
  const { apiKey, ...safe } = config;
  const budget = await readSharedBudget(join(root, '.local-launch/model-budget.json'));
  return { ...safe, hasApiKey: !!apiKey, budget: { day: budget.day, reservedCny: budget.reservedMicros / 1_000_000, calls: budget.calls, reservedTokens: budget.tokens },
    message: config.enabled ? '真实模型已配置；普通入口需单独配置累计额度，旧每日上限不自动转为授权。真实发送关闭。' : '尚未启用真实模型。配置模型与额度后保存；真实发送保持关闭。' };
}
