import { assertOwner, output, uuidv7, type OwnerCommand } from '../registry/types.mts';
import { SkillRegistry } from '../registry/registry.mts';

export type TrialFixture = Readonly<{ mode: 'trial'; command: OwnerCommand; contactId: string; sourceRefs: string[]; text: string }>;
export type TrialResult = Readonly<{ id: string; mode: 'trial'; skillVersion: { skillId: string; version: number }; contactId: string; sourceRefs: string[]; selectedReason: string; advice: { rules: readonly unknown[]; note: string }; sideEffects: [] }>;
/** No live context, fact repository, SendTask or PlatformPort is accepted. */
export function trialSkill(registry: SkillRegistry, skillId: string, version: number, fixture: TrialFixture): TrialResult {
  assertOwner(fixture.command);
  const skill = registry.getVersion(skillId, version);
  if (!skill || registry.getVersion(skillId)?.version !== version || skill.status !== 'active' || fixture.mode !== 'trial' || !fixture.contactId || skill.visibilityScope !== 'global' && skill.visibilityScope !== fixture.contactId || typeof fixture.text !== 'string' || fixture.text.length > 2000 || !Array.isArray(fixture.sourceRefs) || fixture.sourceRefs.some(x => typeof x !== 'string')) throw new Error('VALIDATION_FAILED');
  const result: TrialResult = { id: uuidv7(), mode: 'trial', skillVersion: { skillId, version }, contactId: fixture.contactId, sourceRefs: fixture.sourceRefs, selectedReason: 'OWNER_TRIAL_FIXTURE', advice: { rules: skill.rules, note: '开发试用建议，须经 04 检查与 02 授权' }, sideEffects: [] };
  return output(result);
}
