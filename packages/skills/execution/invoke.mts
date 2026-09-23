import { output, uuidv7, type SkillRule } from '../registry/types.mts';
import type { ScopedSkillInput, Selection } from '../selection/select.mts';
import { assertScoped } from '../selection/select.mts';
import { SkillRegistry } from '../registry/registry.mts';

export type SkillInvocation = Readonly<{
  id: string; taskId: string; contactId: string; stage: string; skillVersion: { skillId: string; version: number } | null; skillEpoch: number;
  selectionMode: Selection['mode']; reason: string; inputRefs: { snapshotId: string; snapshotHash: string; messageRefs: { id: string; version: number }[]; factRefs: { id: string; version: number }[]; analysisRefs: { id: string; version: number }[] };
  output: { kind: 'advice'; rules: SkillRule[]; evidenceRefs: string[]; requiresCheck: true } | null;
  status: 'suggested' | 'fallback' | 'manual_required'; fallbackReason: string | null; adopted: boolean | null; createdAt: string;
}>;
export class InvocationJournal {
  #rows: SkillInvocation[] = [];
  record(row: SkillInvocation) { this.#rows.push(output(row)); return output(row); }
  list(contactId: string): SkillInvocation[] { return output(this.#rows.filter(x => x.contactId === contactId)); }
  markAdopted(id: string, contactId: string, adopted: boolean): SkillInvocation {
    const i = this.#rows.findIndex(x => x.id === id && x.contactId === contactId);
    if (i < 0) throw new Error('NOT_FOUND');
    this.#rows[i] = output({ ...this.#rows[i]!, adopted }); return output(this.#rows[i]!);
  }
}
function selectionCurrent(registry: SkillRegistry, input: ScopedSkillInput, selection: Selection): boolean {
  if (selection.contactId !== input.contactId || selection.taskId !== input.taskId || selection.stage !== input.stage) return false;
  if (selection.dependencyEpoch !== registry.getDependencyEpoch(input.contactId)) return false;
  const skill = selection.selected;
  if (!skill) return selection.mode === 'base';
  const current = registry.getVersion(skill.skillId);
  if (!current || current.version !== skill.version || current.status !== 'active' || current.stage !== input.stage ||
      current.visibilityScope !== 'global' && current.visibilityScope !== input.contactId) return false;
  if (selection.mode === 'automatic') {
    const grant = registry.grant(input.contactId, skill.skillId);
    return !!grant?.enabled && grant.version === selection.grantVersion && skill.version >= grant.enabledVersionRange.min && skill.version <= grant.enabledVersionRange.max;
  }
  return selection.mode === 'manual' && selection.manualCommand?.actor === 'owner' && selection.manualCommand.authenticated === true && !!selection.manualCommand.commandId?.trim();
}
export function invokeSkill(registry: SkillRegistry, input: ScopedSkillInput, selection: Selection, journal: InvocationJournal, now = new Date(), executionFailure?: string): SkillInvocation {
  assertScoped(input);
  const current = selectionCurrent(registry, input, selection);
  const skill = selection.selected && current ? registry.getVersion(selection.selected.skillId)! : selection.selected;
  const required = skill?.requiredContext.factSubjects ?? [];
  const available = new Set(input.context.facts.filter(f => f.confirmationStatus === 'confirmed' && f.content && f.validFrom <= input.context.snapshot.cutoffTime && (!f.validUntil || f.validUntil > input.context.snapshot.cutoffTime)).map(f => f.subject));
  const missing = required.filter(x => !available.has(x));
  const status = !current ? 'fallback' : missing.length ? 'manual_required' : executionFailure ? 'fallback' : skill ? 'suggested' : 'fallback';
  const row: SkillInvocation = {
    id: uuidv7(now.getTime()), taskId: input.taskId, contactId: input.contactId, stage: input.stage,
    skillVersion: skill ? { skillId: skill.skillId, version: skill.version } : null, skillEpoch: selection.dependencyEpoch,
    selectionMode: selection.mode, reason: selection.reason,
    inputRefs: { snapshotId: input.context.snapshot.id, snapshotHash: input.context.snapshot.hash, messageRefs: input.context.snapshot.messageRefs.map(x => ({ ...x })), factRefs: input.context.snapshot.factRefs.map(x => ({ ...x })), analysisRefs: input.context.snapshot.analysisRefs.map(x => ({ ...x })) },
    output: status === 'suggested' ? { kind: 'advice', rules: skill!.rules.map(x => ({ ...x })), evidenceRefs: input.context.snapshot.messageRefs.map(x => x.id), requiresCheck: true } : null,
    status, fallbackReason: !current ? 'STALE_SKILL_DEPENDENCY' : missing.length ? `MISSING_FACT:${missing.join(',')}` : executionFailure ? `SKILL_FAILED:${executionFailure}` : skill ? null : selection.reason,
    adopted: null, createdAt: now.toISOString(),
  };
  return journal.record(row);
}
/** Pure advisory output. 04 runs fact/style/risk checks; 02 alone authorizes dispatch. */
export function adviceFor04(invocation: SkillInvocation) { return output({ invocationId: invocation.id, skillVersion: invocation.skillVersion, advice: invocation.output, status: invocation.status, fallbackReason: invocation.fallbackReason }); }

/** 02 consumes these events and synchronously rechecks versions before each send. */
export function skillEventAffectsPendingPlan(event: { eventType: 'SkillVersionChanged' | 'GrantChanged'; skillId: string; contactId?: string }, plan: { contactId: string; skillVersions: Record<string, number>; status: string }): boolean {
  return !['SENT', 'INVALIDATED', 'REJECTED', 'CANCELLED', 'FAILED', 'RESULT_UNKNOWN'].includes(plan.status)
    && plan.skillVersions[event.skillId] !== undefined
    && (event.eventType === 'SkillVersionChanged' || event.contactId === plan.contactId);
}

/** Conservative synchronous development check. 02 must perform it in its dispatch lease. */
export function isSkillDependencyCurrent(registry: SkillRegistry, invocation: SkillInvocation): boolean {
  if (registry.getDependencyEpoch(invocation.contactId) !== invocation.skillEpoch) return false;
  const ref = invocation.skillVersion;
  if (!ref) return true;
  const current = registry.getVersion(ref.skillId);
  if (!current || current.version !== ref.version || current.status !== 'active') return false;
  if (invocation.selectionMode === 'automatic') {
    const grant = registry.grant(invocation.contactId, ref.skillId);
    if (!grant?.enabled || ref.version < grant.enabledVersionRange.min || ref.version > grant.enabledVersionRange.max) return false;
  }
  return true;
}
