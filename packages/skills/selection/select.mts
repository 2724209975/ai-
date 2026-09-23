import type { ContextProjection } from '../../data/context/store.mts';
import { SkillError, output, type OwnerCommand, type SkillDefinition, type Stage } from '../registry/types.mts';
import { SkillRegistry } from '../registry/registry.mts';

export type ScopedSkillInput = Readonly<{ callerContactId: string; contactId: string; context: ContextProjection; stage: Stage; taskId: string; mode: 'live' }>;
export type Selection = Readonly<{ selected: SkillDefinition | null; mode: 'automatic' | 'manual' | 'base'; reason: string; contactId: string; taskId: string; stage: Stage; dependencyEpoch: number; grantVersion?: number; manualCommand?: OwnerCommand }>;
export type ManualSelection = Readonly<{ skillId: string; version: number; command: OwnerCommand; taskId: string; stage: Stage }>;

export function assertScoped(input: ScopedSkillInput): void {
  const { context: c, contactId } = input;
  if (!contactId || !input.taskId || input.callerContactId !== contactId || c?.snapshot?.contactId !== contactId || !['analysis', 'strategy', 'expression'].includes(input.stage) || input.mode !== 'live') throw new SkillError('FORBIDDEN');
  const refs = (rows: readonly { id: string; version: number }[]) => new Map(rows.map(x => [x.id, x.version]));
  const messages = refs(c.snapshot.messageRefs), facts = refs(c.snapshot.factRefs), analyses = refs(c.snapshot.analysisRefs);
  if (c.messages.length !== messages.size || c.facts.length !== facts.size || c.analyses.length !== analyses.size ||
      c.messages.some(x => x.contactId !== contactId || x.mode !== 'live' || x.deletionStatus !== 'active' || messages.get(x.id) !== x.version || x.sentAt > c.snapshot.cutoffTime) ||
      c.facts.some(x => !['global', contactId].includes(x.scope) || x.deletionStatus !== 'active' || facts.get(x.id) !== x.version) ||
      c.analyses.some(x => x.contactId !== contactId || x.status !== 'valid' || analyses.get(x.id) !== x.version)) throw new SkillError('FORBIDDEN');
}
function applicable(skill: SkillDefinition, input: ScopedSkillInput): string | null {
  if (skill.status !== 'active' || skill.stage !== input.stage) return 'NOT_APPLICABLE';
  if (skill.visibilityScope !== 'global' && skill.visibilityScope !== input.contactId) return 'OUT_OF_SCOPE';
  const words = input.context.messages.filter(x => x.actor === 'contact').map(x => x.contentRef ?? '').join(' ');
  if (skill.applicability.excludeTopics.some(x => words.includes(x))) return 'EXCLUDED_TOPIC';
  if (skill.applicability.topics.length && !skill.applicability.topics.some(x => words.includes(x))) return 'NOT_APPLICABLE';
  return null;
}
export function selectSkill(registry: SkillRegistry, input: ScopedSkillInput, manual?: ManualSelection): Selection {
  assertScoped(input);
  const dependencyEpoch = registry.getDependencyEpoch(input.contactId);
  const binding = { contactId: input.contactId, taskId: input.taskId, stage: input.stage, dependencyEpoch };
  if (manual) {
    if (manual.command?.actor !== 'owner' || manual.command.authenticated !== true || !manual.command.commandId || manual.taskId !== input.taskId || manual.stage !== input.stage) throw new SkillError('FORBIDDEN');
    const row = registry.getVersion(manual.skillId, manual.version), current = registry.getVersion(manual.skillId);
    if (!row || !current || row.version !== current.version) return output({ ...binding, selected: null, mode: 'base', reason: 'STALE_SKILL_VERSION' });
    const reason = applicable(row, input);
    const result: Selection = reason ? { ...binding, selected: null, mode: 'base', reason } : { ...binding, selected: row, mode: 'manual', reason: `OWNER_TASK_COMMAND:${manual.command.commandId}`, manualCommand: manual.command };
    return output(result);
  }
  const candidates = registry.grants(input.contactId).filter(g => g.enabled).flatMap(g => {
    const row = registry.getVersion(g.skillId);
    return row && row.version >= g.enabledVersionRange.min && row.version <= g.enabledVersionRange.max && !applicable(row, input) ? [{ row, g }] : [];
  }).sort((a, b) => a.row.skillId.localeCompare(b.row.skillId));
  const picked = candidates[0];
  const result: Selection = picked ? { ...binding, selected: picked.row, mode: 'automatic', reason: `GRANT:${picked.g.id}@${picked.g.version}`, grantVersion: picked.g.version } : { ...binding, selected: null, mode: 'base', reason: 'NO_ELIGIBLE_GRANT' };
  return output(result);
}
