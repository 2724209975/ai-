/** 05 PostgreSQL port for the approved 0009 global-only Skill storage. */
import { createHash } from 'node:crypto';
import { setContactScope, type PgClient } from '../../infrastructure/postgres/transaction.mts';
import { acquireDispatchBoundary } from '../../infrastructure/postgres/dispatch-journal.mts';
import { appendOutbox } from '../../infrastructure/postgres/event-store.mts';
import { SkillError, assertOwner, output, uuidv7, type ContactSkillGrant, type OwnerCommand, type SkillDefinition, type SkillDraft } from './types.mts';
import { previewDraft } from './registry.mts';
import type { SkillInvocation } from '../execution/invoke.mts';

type CurrentRow = { skill_id: string; source: 'built_in' | 'custom'; current_version: number | string; status: SkillDefinition['status']; visibility_scope: string };
type VersionRow = { definition: SkillDefinition };
type GrantRow = { id: string; contact_id: string; skill_id: string; min_version: number | string; max_version: number | string; version: number | string; enabled: boolean; created_at: Date | string; updated_at: Date | string };
type InvocationRow = { id: string; task_id: string; contact_id: string; stage: string; skill_id: string | null; skill_version: number | string | null; skill_epoch: number | string; selection_mode: SkillInvocation['selectionMode']; reason: string; input_refs: SkillInvocation['inputRefs']; output: SkillInvocation['output']; status: SkillInvocation['status']; fallback_reason: string | null; adopted: boolean | null; created_at: Date | string };
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
const fail = (code: SkillError['code']): never => { throw new SkillError(code); };
const commandHash = (kind: string, args: unknown): string => hash([kind, args]);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const refList = (value: unknown): value is { id: string; version: number }[] => Array.isArray(value) && value.every(x => x && uuid(x.id) && Number.isSafeInteger(x.version) && x.version > 0);
const rule = (value: unknown): boolean => !!value && typeof value === 'object' && ['tone', 'method'].includes((value as any).kind) && ['gentle', 'concise', 'clarify', 'continue_topic', 'acknowledge'].includes((value as any).value) && Object.keys(value).every(x => ['kind', 'value'].includes(x));
function grantFrom(row: GrantRow): ContactSkillGrant {
  return output({ id: row.id, contactId: row.contact_id, skillId: row.skill_id, enabledVersionRange: { min: Number(row.min_version), max: Number(row.max_version) }, version: Number(row.version), enabled: row.enabled, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function invocationFrom(row: InvocationRow): SkillInvocation {
  return output({ id: row.id, taskId: row.task_id, contactId: row.contact_id, stage: row.stage, skillVersion: row.skill_id && row.skill_version !== null ? { skillId: row.skill_id, version: Number(row.skill_version) } : null, skillEpoch: Number(row.skill_epoch), selectionMode: row.selection_mode, reason: row.reason, inputRefs: row.input_refs, output: row.output, status: row.status, fallbackReason: row.fallback_reason, adopted: row.adopted, createdAt: iso(row.created_at) });
}

/** Caller owns BEGIN/COMMIT and must not publish any of these methods separately. */
export class PgSkillStore {
  private readonly now: () => Date;
  constructor(now: () => Date = () => new Date()) { this.now = now; }

  async #receipt<T>(tx: PgClient, command: OwnerCommand, requestHash: string): Promise<T | null> {
    const prior = await tx.query<{ request_hash: string; result: T }>('SELECT request_hash,result FROM skills_command_receipts WHERE command_id=$1', [command.commandId]);
    if (!prior.rows.length) return null;
    if (prior.rows[0]!.request_hash !== requestHash) fail('CONFLICT_VERSION');
    return output(prior.rows[0]!.result) as T;
  }
  async #saveReceipt(tx: PgClient, command: OwnerCommand, requestHash: string, result: unknown): Promise<void> {
    await tx.query('INSERT INTO skills_command_receipts(command_id,request_hash,result) VALUES($1,$2,$3::jsonb)', [command.commandId, requestHash, JSON.stringify(result)]);
  }
  async #event(tx: PgClient, input: { kind: 'SkillVersionChanged' | 'GrantChanged'; skillId: string; version: number; contactId?: string; oldVersion?: number; reason: string; command: OwnerCommand }): Promise<void> {
    const eventId = uuidv7(this.now().getTime());
    await appendOutbox(tx, { eventId, eventType: input.kind, eventVersion: 1, occurredAt: this.now().toISOString(), correlationId: input.command.commandId, causationId: input.command.commandId,
      aggregateId: input.skillId, aggregateVersion: input.version,
      payload: { skillId: input.skillId, contactId: input.contactId, oldVersion: input.oldVersion, newVersion: input.kind === 'SkillVersionChanged' ? input.version : undefined, grantVersion: input.kind === 'GrantChanged' ? input.version : undefined, reason: input.reason } });
  }
  async #bumpEpoch(tx: PgClient, contactId?: string): Promise<void> {
    if (!contactId) {
      await tx.query('UPDATE dispatch_control SET skill_epoch=skill_epoch+1,updated_at=now()');
      return;
    }
    const changed = await tx.query<{ conversation_id: string }>(`UPDATE dispatch_control SET skill_epoch=skill_epoch+1,updated_at=now()
      WHERE conversation_id=(SELECT conversation_id::text FROM data_contacts WHERE id=$1::uuid)
      RETURNING conversation_id`, [contactId]);
    if (changed.rows.length !== 1) fail('NOT_FOUND');
  }
  async getDependencyEpoch(tx: PgClient, contactId: string): Promise<number> {
    if (!contactId) fail('VALIDATION_FAILED');
    const result = await tx.query<{ skill_epoch: number | string }>(`SELECT dc.skill_epoch FROM dispatch_control dc
      JOIN data_contacts c ON c.conversation_id::text=dc.conversation_id WHERE c.id=$1::uuid`, [contactId]);
    if (result.rows.length !== 1) fail('NOT_FOUND');
    return Number(result.rows[0]!.skill_epoch);
  }
  async getVersion(tx: PgClient, skillId: string, version?: number): Promise<SkillDefinition | null> {
    const result = await tx.query<VersionRow>(`SELECT v.definition FROM skills_versions v
      JOIN skills_current c ON c.skill_id=v.skill_id
      WHERE v.skill_id=$1::uuid AND v.version=COALESCE($2::bigint,c.current_version)`, [skillId, version ?? null]);
    return result.rows[0] ? output(result.rows[0].definition) : null;
  }
  async grant(tx: PgClient, contactId: string, skillId: string): Promise<ContactSkillGrant | null> {
    const result = await tx.query<GrantRow>('SELECT * FROM skills_grants WHERE contact_id=$1::uuid AND skill_id=$2::uuid', [contactId, skillId]);
    return result.rows[0] ? grantFrom(result.rows[0]) : null;
  }
  async listGranted(tx: PgClient, callerContactId: string, contactId: string): Promise<{ definition: SkillDefinition; grant: ContactSkillGrant }[]> {
    if (!callerContactId || callerContactId !== contactId) fail('FORBIDDEN');
    await setContactScope(tx, contactId);
    const result = await tx.query<GrantRow & VersionRow>(`SELECT g.*,v.definition FROM skills_grants g
      JOIN skills_current c ON c.skill_id=g.skill_id AND c.status='active'
      JOIN skills_versions v ON v.skill_id=c.skill_id AND v.version=c.current_version
      WHERE g.contact_id=$1::uuid AND g.enabled AND c.current_version BETWEEN g.min_version AND g.max_version
        AND (c.visibility_scope='global' OR c.visibility_scope=$1::text)`, [contactId]);
    return output(result.rows.map(row => ({ definition: row.definition, grant: grantFrom(row) })));
  }
  async createVersion(tx: PgClient, input: { command: OwnerCommand; draft: SkillDraft; skillId?: string; expectedVersion?: number; source?: 'built_in' | 'custom' }): Promise<SkillDefinition> {
    assertOwner(input.command);
    const preview = previewDraft(input.draft);
    if (!preview.canSave || !preview.draft) throw new SkillError('VALIDATION_FAILED', preview.errors.join(','));
    await acquireDispatchBoundary(tx);
    const requestHash = commandHash('createVersion', { draft: preview.draft, skillId: input.skillId, expectedVersion: input.expectedVersion, source: input.source });
    const duplicate = await this.#receipt<SkillDefinition>(tx, input.command, requestHash);
    if (duplicate) return duplicate;
    const skillId = input.skillId ?? uuidv7(this.now().getTime());
    const current = await tx.query<CurrentRow>('SELECT * FROM skills_current WHERE skill_id=$1::uuid FOR UPDATE', [skillId]);
    const prior = current.rows[0];
    if (!!prior !== (input.expectedVersion !== undefined) || prior && (Number(prior.current_version) !== input.expectedVersion || prior.status === 'deleted')) fail('CONFLICT_VERSION');
    if (prior?.source === 'built_in') fail('FORBIDDEN');
    const at = this.now().toISOString(), version = Number(prior?.current_version ?? 0) + 1;
    const definition: SkillDefinition = { ...preview.draft, skillId, source: prior?.source ?? input.source ?? 'custom', version, status: 'active', createdAt: prior ? (await this.getVersion(tx, skillId))!.createdAt : at, updatedAt: at };
    if (prior) await tx.query(`UPDATE skills_current SET current_version=$2,status='active',visibility_scope=$3,updated_at=$4 WHERE skill_id=$1`, [skillId, version, definition.visibilityScope, at]);
    else await tx.query(`INSERT INTO skills_current(skill_id,source,current_version,status,visibility_scope,created_at,updated_at)
      VALUES($1,$2,1,'active',$3,$4,$4)`, [skillId, definition.source, definition.visibilityScope, at]);
    await tx.query(`INSERT INTO skills_versions(skill_id,version,definition,status,created_at)
      VALUES($1,$2,$3::jsonb,'active',$4)`, [skillId, version, JSON.stringify(definition), at]);
    await this.#bumpEpoch(tx);
    await this.#event(tx, { kind: 'SkillVersionChanged', skillId, version, oldVersion: prior && Number(prior.current_version), reason: prior ? 'UPDATED' : 'CREATED', command: input.command });
    await this.#saveReceipt(tx, input.command, requestHash, definition);
    return output(definition);
  }
  async setStatus(tx: PgClient, input: { command: OwnerCommand; skillId: string; expectedVersion: number; status: 'disabled' | 'deleted' }): Promise<SkillDefinition> {
    assertOwner(input.command);
    await acquireDispatchBoundary(tx);
    const requestHash = commandHash('setStatus', input);
    const duplicate = await this.#receipt<SkillDefinition>(tx, input.command, requestHash);
    if (duplicate) return duplicate;
    const current = await tx.query<CurrentRow>('SELECT * FROM skills_current WHERE skill_id=$1::uuid FOR UPDATE', [input.skillId]);
    const row = current.rows[0];
    if (!row) fail('NOT_FOUND');
    if (Number(row.current_version) !== input.expectedVersion || row.status === 'deleted') fail('CONFLICT_VERSION');
    if (row.source === 'built_in') fail('FORBIDDEN');
    const prior = await this.getVersion(tx, input.skillId, input.expectedVersion);
    if (!prior) fail('NOT_FOUND');
    const at = this.now().toISOString(), version = input.expectedVersion + 1;
    const next: SkillDefinition = { ...prior, version, status: input.status, updatedAt: at };
    await tx.query('UPDATE skills_current SET current_version=$2,status=$3,updated_at=$4 WHERE skill_id=$1', [input.skillId, version, input.status, at]);
    await tx.query('INSERT INTO skills_versions(skill_id,version,definition,status,created_at) VALUES($1,$2,$3::jsonb,$4,$5)', [input.skillId, version, JSON.stringify(next), input.status, at]);
    await this.#bumpEpoch(tx);
    await this.#event(tx, { kind: 'SkillVersionChanged', skillId: input.skillId, version, oldVersion: input.expectedVersion, reason: input.status.toUpperCase(), command: input.command });
    await this.#saveReceipt(tx, input.command, requestHash, next);
    return output(next);
  }
  async setGrant(tx: PgClient, input: { command: OwnerCommand; contactId: string; skillId: string; min: number; max: number; enabled: boolean; expectedVersion?: number }): Promise<ContactSkillGrant> {
    assertOwner(input.command);
    if (!input.contactId || !Number.isSafeInteger(input.min) || !Number.isSafeInteger(input.max) || input.min < 1 || input.max < input.min) fail('VALIDATION_FAILED');
    await setContactScope(tx, input.contactId);
    await acquireDispatchBoundary(tx);
    const requestHash = commandHash('setGrant', input);
    const duplicate = await this.#receipt<ContactSkillGrant>(tx, input.command, requestHash);
    if (duplicate) return duplicate;
    const current = await tx.query<CurrentRow>('SELECT * FROM skills_current WHERE skill_id=$1::uuid FOR UPDATE', [input.skillId]);
    const skill = current.rows[0];
    if (!skill || input.enabled && skill.status !== 'active' || skill.visibility_scope !== 'global' && skill.visibility_scope !== input.contactId) fail('NOT_FOUND');
    if (input.max > Number(skill.current_version)) fail('VALIDATION_FAILED');
    const prior = await this.grant(tx, input.contactId, input.skillId);
    if (!!prior !== (input.expectedVersion !== undefined) || prior && prior.version !== input.expectedVersion) fail('CONFLICT_VERSION');
    const at = this.now().toISOString();
    const grant: ContactSkillGrant = { id: prior?.id ?? uuidv7(this.now().getTime()), contactId: input.contactId, skillId: input.skillId, enabledVersionRange: { min: input.min, max: input.max }, version: (prior?.version ?? 0) + 1, enabled: input.enabled, createdAt: prior?.createdAt ?? at, updatedAt: at };
    if (prior) await tx.query(`UPDATE skills_grants SET min_version=$3,max_version=$4,version=$5,enabled=$6,updated_at=$7
      WHERE contact_id=$1::uuid AND skill_id=$2::uuid`, [input.contactId, input.skillId, input.min, input.max, grant.version, input.enabled, at]);
    else await tx.query(`INSERT INTO skills_grants(id,contact_id,skill_id,min_version,max_version,version,enabled,created_at,updated_at)
      VALUES($1,$2::uuid,$3::uuid,$4,$5,1,$6,$7,$7)`, [grant.id, input.contactId, input.skillId, input.min, input.max, input.enabled, at]);
    await this.#bumpEpoch(tx, input.contactId);
    await this.#event(tx, { kind: 'GrantChanged', skillId: input.skillId, contactId: input.contactId, version: grant.version, oldVersion: prior?.version, reason: input.enabled ? 'ENABLED' : 'DISABLED', command: input.command });
    await this.#saveReceipt(tx, input.command, requestHash, grant);
    return output(grant);
  }
  async recordInvocation(tx: PgClient, callerContactId: string, mode: 'live', invocation: SkillInvocation): Promise<SkillInvocation> {
    if (!callerContactId || callerContactId !== invocation.contactId) fail('FORBIDDEN');
    if (mode !== 'live' || !uuid(invocation.id) || !uuid(invocation.contactId) || !uuid(invocation.taskId) || !Number.isSafeInteger(invocation.skillEpoch) || invocation.skillEpoch < 0 ||
      invocation.skillVersion && (!uuid(invocation.skillVersion.skillId) || !Number.isSafeInteger(invocation.skillVersion.version) || invocation.skillVersion.version < 1) ||
      !['analysis', 'strategy', 'expression'].includes(invocation.stage) || !['automatic', 'manual', 'base'].includes(invocation.selectionMode) || !['suggested', 'fallback', 'manual_required'].includes(invocation.status) ||
      typeof invocation.reason !== 'string' || invocation.reason.length > 500 || invocation.fallbackReason !== null && (typeof invocation.fallbackReason !== 'string' || invocation.fallbackReason.length > 500) ||
      invocation.adopted !== null && typeof invocation.adopted !== 'boolean') fail('VALIDATION_FAILED');
    await setContactScope(tx, callerContactId);
    const refs = invocation.inputRefs;
    if (!refs || !uuid(refs.snapshotId) || typeof refs.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/i.test(refs.snapshotHash) || !refList(refs.messageRefs) || !refList(refs.factRefs) || !refList(refs.analysisRefs)) fail('VALIDATION_FAILED');
    if (invocation.output && (invocation.output.kind !== 'advice' || invocation.output.requiresCheck !== true || !Array.isArray(invocation.output.rules) || !invocation.output.rules.every(rule) || !Array.isArray(invocation.output.evidenceRefs) || invocation.output.evidenceRefs.some(x => typeof x !== 'string' || x.length > 200))) fail('VALIDATION_FAILED');
    if (invocation.status === 'suggested' && !invocation.output || invocation.status !== 'suggested' && invocation.output) fail('VALIDATION_FAILED');
    const safeRefs = { snapshotId: refs.snapshotId, snapshotHash: refs.snapshotHash, messageRefs: refs.messageRefs.map(x => ({ id: x.id, version: x.version })), factRefs: refs.factRefs.map(x => ({ id: x.id, version: x.version })), analysisRefs: refs.analysisRefs.map(x => ({ id: x.id, version: x.version })) };
    const safeOutput = invocation.output && { kind: 'advice' as const, rules: invocation.output.rules.map(x => ({ kind: x.kind, value: x.value })), evidenceRefs: [...invocation.output.evidenceRefs], requiresCheck: true as const };
    await tx.query(`INSERT INTO skills_invocations(id,task_id,contact_id,stage,skill_id,skill_version,skill_epoch,selection_mode,reason,input_refs,output,status,fallback_reason,adopted,created_at)
      VALUES($1,$2,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15)`,
      [invocation.id, invocation.taskId, invocation.contactId, invocation.stage, invocation.skillVersion?.skillId ?? null, invocation.skillVersion?.version ?? null, invocation.skillEpoch, invocation.selectionMode, invocation.reason, JSON.stringify(safeRefs), safeOutput ? JSON.stringify(safeOutput) : null, invocation.status, invocation.fallbackReason, invocation.adopted, invocation.createdAt]);
    return output({ ...invocation, inputRefs: safeRefs, output: safeOutput ?? null });
  }
  async listInvocations(tx: PgClient, callerContactId: string, contactId: string): Promise<SkillInvocation[]> {
    if (!callerContactId || callerContactId !== contactId) fail('FORBIDDEN');
    await setContactScope(tx, contactId);
    const result = await tx.query<InvocationRow>('SELECT * FROM skills_invocations WHERE contact_id=$1::uuid ORDER BY created_at,id', [contactId]);
    return output(result.rows.map(invocationFrom));
  }
  async markAdopted(tx: PgClient, callerContactId: string, contactId: string, invocationId: string, adopted: boolean): Promise<SkillInvocation> {
    if (!callerContactId || callerContactId !== contactId) fail('FORBIDDEN');
    await setContactScope(tx, contactId);
    const result = await tx.query<InvocationRow>('UPDATE skills_invocations SET adopted=$3 WHERE id=$1::uuid AND contact_id=$2::uuid RETURNING *', [invocationId, contactId, adopted]);
    if (!result.rows[0]) fail('NOT_FOUND');
    return invocationFrom(result.rows[0]);
  }
}
