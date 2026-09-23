/** 05-local development contract. Public wire changes require architecture approval. */
import { randomBytes } from 'node:crypto';
export type Stage = 'analysis' | 'strategy' | 'expression';
export type SkillRule = Readonly<{ kind: 'tone' | 'method'; value: 'gentle' | 'concise' | 'clarify' | 'continue_topic' | 'acknowledge' }>;
export type SkillDraft = Readonly<{
  name: string; purpose: string; stage: Stage;
  applicability: { topics: string[]; excludeTopics: string[] };
  requiredContext: { factSubjects: string[] };
  rules: SkillRule[]; examples: { input: string; output: string; contactId?: string }[];
  outputContract: 'advice-v1'; visibilityScope: 'global' | string;
}>;
export type SkillDefinition = SkillDraft & Readonly<{ skillId: string; source: 'built_in' | 'custom'; version: number; status: 'active' | 'disabled' | 'deleted'; createdAt: string; updatedAt: string }>;
export type ContactSkillGrant = Readonly<{ id: string; contactId: string; skillId: string; enabledVersionRange: { min: number; max: number }; version: number; enabled: boolean; createdAt: string; updatedAt: string }>;
export type SkillEvent = Readonly<{ sequence: number; eventType: 'SkillVersionChanged' | 'GrantChanged'; skillId: string; contactId?: string; oldVersion?: number; newVersion?: number; grantVersion?: number; reason: string; occurredAt: string }>;
export type OwnerCommand = Readonly<{ actor: 'owner'; authenticated: true; commandId: string }>;
export type Preview = Readonly<{ mode: 'import'; draft: SkillDraft | null; errors: string[]; warnings: string[]; canSave: boolean }>;

export class SkillError extends Error {
  readonly code: 'VALIDATION_FAILED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT_VERSION';
  constructor(code: SkillError['code'], message = code) { super(message); this.code = code; }
}
export const assertOwner = (command: OwnerCommand): void => {
  if (command?.actor !== 'owner' || command.authenticated !== true || !command.commandId?.trim()) throw new SkillError('FORBIDDEN');
};
export const clone = <T>(value: T): T => structuredClone(value);
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
export const output = <T>(value: T): Readonly<T> => freeze(clone(value));
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Math.max(0, Math.trunc(now)), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
