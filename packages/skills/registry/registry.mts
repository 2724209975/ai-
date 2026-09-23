import { SkillError, assertOwner, clone, output, uuidv7, type ContactSkillGrant, type OwnerCommand, type Preview, type SkillDefinition, type SkillDraft, type SkillEvent } from './types.mts';

const bad = /```|<script|<iframe|https?:\/\/|(?:npm|pip|curl|wget)\s|(?:import|require)\s*\(|(?:fetch|eval|exec)\s*\(|忽略.{0,12}(权限|规则)|(?:读取|检索).{0,10}(其他|别的)联系人|(?:开启|启用).{0,10}(权限|自动发送)/iu;
const text = (v: unknown, max = 500): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !bad.test(v);
const list = (v: unknown, max = 12): v is string[] => Array.isArray(v) && v.length <= max && v.every(x => text(x, 80));
const fields = ['name', 'purpose', 'stage', 'applicability', 'requiredContext', 'rules', 'examples', 'outputContract', 'visibilityScope'];
export function previewDraft(raw: unknown): Preview {
  const errors: string[] = [], warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return output({ mode: 'import', draft: null, errors: ['INVALID_OBJECT'], warnings, canSave: false });
  const r = raw as Record<string, any>;
  for (const key of fields) if (r[key] === undefined) errors.push(`MISSING_${key}`);
  for (const key of Object.keys(r)) if (!fields.includes(key)) errors.push(`UNSUPPORTED_${key}`);
  if (!text(r.name, 80) || !text(r.purpose) || !['analysis', 'strategy', 'expression'].includes(r.stage)) errors.push('INVALID_IDENTITY');
  if (!r.applicability || !list(r.applicability.topics) || !list(r.applicability.excludeTopics)) errors.push('INVALID_APPLICABILITY');
  else if (Object.keys(r.applicability).some(k => !['topics', 'excludeTopics'].includes(k))) errors.push('UNSUPPORTED_APPLICABILITY');
  else if (r.applicability.topics.some((x: string) => r.applicability.excludeTopics.includes(x))) errors.push('CONFLICTING_TOPICS');
  if (!r.requiredContext || !list(r.requiredContext.factSubjects)) errors.push('INVALID_REQUIRED_CONTEXT');
  else if (Object.keys(r.requiredContext).some(k => k !== 'factSubjects')) errors.push('UNSUPPORTED_REQUIRED_CONTEXT');
  if (!Array.isArray(r.rules) || r.rules.length < 1 || r.rules.length > 12 || r.rules.some((x: any) => !x || !['tone', 'method'].includes(x.kind) || !['gentle', 'concise', 'clarify', 'continue_topic', 'acknowledge'].includes(x.value) || Object.keys(x).some(k => !['kind', 'value'].includes(k)))) errors.push('UNSUPPORTED_RULE');
  if (!Array.isArray(r.examples) || r.examples.length > 5 || r.examples.some((x: any) => !x || !text(x.input) || !text(x.output) || Object.keys(x).some(k => !['input', 'output', 'contactId'].includes(k)) || (x.contactId !== undefined && !text(x.contactId, 100)))) errors.push('UNSAFE_EXAMPLE');
  if (r.outputContract !== 'advice-v1') errors.push('UNSUPPORTED_OUTPUT');
  if (!text(r.visibilityScope, 100)) errors.push('INVALID_SCOPE');
  if (Array.isArray(r.examples) && r.examples.some((x: any) => x?.contactId && x.contactId !== r.visibilityScope)) errors.push('CROSS_CONTACT_EXAMPLE');
  if (r.visibilityScope === 'global' && Array.isArray(r.examples) && r.examples.some((x: any) => x?.contactId)) errors.push('PRIVATE_EXAMPLE_IN_GLOBAL');
  if (r.visibilityScope === 'global' && Array.isArray(r.examples) && r.examples.length) errors.push('GLOBAL_EXAMPLES_REQUIRE_REVIEW');
  if (errors.length) return output({ mode: 'import', draft: null, errors: [...new Set(errors)], warnings, canSave: false });
  return output({ mode: 'import', draft: clone(r) as SkillDraft, errors, warnings, canSave: true });
}

/** D12 provisional JSON-only import. Markdown and executable content are rejected. */
export function previewImport(source: string): Preview {
  if (typeof source !== 'string' || source.length > 16_384 || bad.test(source)) return output({ mode: 'import', draft: null, errors: ['UNSUPPORTED_OR_UNSAFE_IMPORT'], warnings: [], canSave: false });
  try { return previewDraft(JSON.parse(source)); } catch { return output({ mode: 'import', draft: null, errors: ['INVALID_JSON'], warnings: ['D12_FORMAT_PROVISIONAL'], canSave: false }); }
}

export class SkillRegistry {
  #versions = new Map<string, SkillDefinition[]>();
  #grants = new Map<string, ContactSkillGrant>();
  #events: SkillEvent[] = [];
  #globalEpoch = 0;
  #contactEpoch = new Map<string, number>();
  private readonly now: () => Date;
  constructor(now: () => Date = () => new Date()) { this.now = now; }
  #emit(event: Omit<SkillEvent, 'sequence' | 'occurredAt'>) {
    if (event.contactId) this.#contactEpoch.set(event.contactId, (this.#contactEpoch.get(event.contactId) ?? 0) + 1);
    else this.#globalEpoch++;
    this.#events.push({ ...event, sequence: this.#events.length + 1, occurredAt: this.now().toISOString() });
  }
  /** In-memory coordination token only. Production epoch must commit with outbox. */
  getDependencyEpoch(contactId: string): number {
    if (!contactId?.trim()) throw new SkillError('VALIDATION_FAILED');
    return this.#globalEpoch + (this.#contactEpoch.get(contactId) ?? 0);
  }
  createVersion(input: { command: OwnerCommand; draft: SkillDraft; skillId?: string; expectedVersion?: number; source?: 'built_in' | 'custom' }): SkillDefinition {
    assertOwner(input.command);
    const preview = previewDraft(input.draft);
    if (!preview.canSave || !preview.draft) throw new SkillError('VALIDATION_FAILED', preview.errors.join(','));
    const id = input.skillId ?? uuidv7(this.now().getTime()), history = this.#versions.get(id) ?? [], prior = history.at(-1);
    if (!!prior !== (input.expectedVersion !== undefined) || (prior && (prior.version !== input.expectedVersion || prior.status === 'deleted'))) throw new SkillError('CONFLICT_VERSION');
    if (prior?.source === 'built_in') throw new SkillError('FORBIDDEN');
    const at = this.now().toISOString();
    const definition: SkillDefinition = { ...clone(preview.draft), skillId: id, source: input.source ?? 'custom', version: (prior?.version ?? 0) + 1, status: 'active', createdAt: prior?.createdAt ?? at, updatedAt: at };
    history.push(output(definition)); this.#versions.set(id, history);
    this.#emit({ eventType: 'SkillVersionChanged', skillId: id, oldVersion: prior?.version, newVersion: definition.version, reason: prior ? 'UPDATED' : 'CREATED' });
    return output(definition);
  }
  getVersion(skillId: string, version?: number): SkillDefinition | undefined { const rows = this.#versions.get(skillId); const row = version === undefined ? rows?.at(-1) : rows?.find(v => v.version === version); return row && output(row); }
  listCurrent(): SkillDefinition[] { return output([...this.#versions.values()].map(v => v.at(-1)!)); }
  setStatus(input: { command: OwnerCommand; skillId: string; expectedVersion: number; status: 'disabled' | 'deleted' }): SkillDefinition {
    assertOwner(input.command);
    const prior = this.getVersion(input.skillId);
    if (!prior) throw new SkillError('NOT_FOUND');
    if (prior.version !== input.expectedVersion || prior.status === 'deleted') throw new SkillError('CONFLICT_VERSION');
    if (prior.source === 'built_in') throw new SkillError('FORBIDDEN');
    const next = { ...prior, version: prior.version + 1, status: input.status, updatedAt: this.now().toISOString() };
    this.#versions.get(input.skillId)!.push(output(next));
    this.#emit({ eventType: 'SkillVersionChanged', skillId: input.skillId, oldVersion: prior.version, newVersion: next.version, reason: input.status.toUpperCase() });
    return output(next);
  }
  setGrant(input: { command: OwnerCommand; contactId: string; skillId: string; min: number; max: number; enabled: boolean; expectedVersion?: number }): ContactSkillGrant {
    assertOwner(input.command);
    const skill = this.getVersion(input.skillId), key = `${input.contactId}:${input.skillId}`, prior = this.#grants.get(key);
    if (!skill || (input.enabled && skill.status !== 'active') || skill.visibilityScope !== 'global' && skill.visibilityScope !== input.contactId) throw new SkillError('NOT_FOUND');
    if (!input.contactId?.trim() || !Number.isSafeInteger(input.min) || !Number.isSafeInteger(input.max) || input.min < 1 || input.max < input.min || input.max > skill.version) throw new SkillError('VALIDATION_FAILED');
    if (!!prior !== (input.expectedVersion !== undefined) || prior && prior.version !== input.expectedVersion) throw new SkillError('CONFLICT_VERSION');
    const at = this.now().toISOString();
    const grant: ContactSkillGrant = { id: prior?.id ?? uuidv7(this.now().getTime()), contactId: input.contactId, skillId: input.skillId, enabledVersionRange: { min: input.min, max: input.max }, version: (prior?.version ?? 0) + 1, enabled: input.enabled, createdAt: prior?.createdAt ?? at, updatedAt: at };
    this.#grants.set(key, output(grant));
    this.#emit({ eventType: 'GrantChanged', skillId: input.skillId, contactId: input.contactId, grantVersion: grant.version, reason: input.enabled ? 'ENABLED' : 'DISABLED' });
    return output(grant);
  }
  grant(contactId: string, skillId: string): ContactSkillGrant | undefined { const row = this.#grants.get(`${contactId}:${skillId}`); return row && output(row); }
  grants(contactId: string): ContactSkillGrant[] { return output([...this.#grants.values()].filter(x => x.contactId === contactId)); }
  events(afterSequence = 0): SkillEvent[] { return output(this.#events.filter(e => e.sequence > afterSequence)); }
}
