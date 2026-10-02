import { createHash } from 'node:crypto';
import { iso } from './trial-report.mts';
import type { PolicyProjection, ScopedContext } from '../types.mts';

const fail = (): never => { throw new Error('REPLAY_SAMPLE_INVALID'); };
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
  return value as Record<string, any>;
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /wxid_|sk-[A-Za-z0-9]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b1[3-9]\d{9}\b/i.test(value)) fail();
  return value;
}
const time = (value: unknown): string => iso(value) ?? fail();
function list(value: unknown, max: number): any[] { if (!Array.isArray(value) || value.length > max) fail(); return value; }
function id(value: unknown, prefix: string): string { if (typeof value !== 'string' || !new RegExp(`^${prefix}[1-9][0-9]{0,3}$`).test(value)) fail(); return value; }
function strings(value: unknown): string[] { return list(value, 24).map(v => text(v, 120)); }
export type ReplaySample = { context: ScopedContext; policy: PolicyProjection; excludedMessages: number; excludedFacts: number };
export function prepareReplaySamples(raw: unknown): { externalAuthorized: boolean; samples: ReplaySample[] } {
  const root = object(raw, ['schemaVersion', 'authorization', 'samples']);
  const auth = object(root.authorization, ['ownerAuthorized', 'deidentified', 'externalModelAuthorized']);
  if (root.schemaVersion !== 1 || auth.ownerAuthorized !== true || auth.deidentified !== true || (auth.externalModelAuthorized !== undefined && typeof auth.externalModelAuthorized !== 'boolean')) fail();
  const samples = list(root.samples, 50).map((value, index) => {
    const sample = object(value, ['cutoffTime', 'cutoffMessageId', 'policy', 'messages', 'facts']);
    const cutoff = time(sample.cutoffTime), cutoffMessageId = id(sample.cutoffMessageId, 'm');
    const p = object(sample.policy, ['effectiveAt', 'sendMode', 'goal', 'restrictions', 'stylePreferences']);
    if (time(p.effectiveAt) > cutoff || !['confirm', 'auto'].includes(p.sendMode)) fail();
    const contactId = `sample-${index + 1}`, policy: PolicyProjection = { contactId, version: 1, goal: text(p.goal, 200), sendMode: p.sendMode,
      agentEnabled: true, activeContactEnabled: false, activeConfessionEnabled: false, restrictions: strings(p.restrictions), stylePreferences: strings(p.stylePreferences) };
    const rawMessages = list(sample.messages, 200).map(v => {
      const m = object(v, ['id', 'actor', 'sentAt', 'text']);
      if (!['owner', 'contact', 'agent'].includes(m.actor)) fail();
      return { id: id(m.id, 'm'), sentAt: time(m.sentAt), actor: m.actor as 'owner' | 'contact' | 'agent', text: text(m.text) };
    });
    if (new Set(rawMessages.map(m => m.id)).size !== rawMessages.length) fail();
    const target = rawMessages.find(m => m.id === cutoffMessageId);
    if (!target || target.actor !== 'contact' || target.sentAt > cutoff) fail();
    const targetOrder = rawMessages.indexOf(target);
    const visible = rawMessages.filter((m, order) => m.sentAt < target.sentAt || (m.sentAt === target.sentAt && order <= targetOrder))
      .filter(m => m.sentAt <= cutoff).sort((a, b) => a.sentAt.localeCompare(b.sentAt) || rawMessages.indexOf(a) - rawMessages.indexOf(b));
    const visibleIds = new Set(visible.map(m => m.id));
    const rawFacts = list(sample.facts, 100).map(v => {
      const f = object(v, ['id', 'version', 'recordedAt', 'confirmedAt', 'validFrom', 'validUntil', 'subject', 'content', 'evidenceMessageIds', 'confirmed', 'deleted']);
      if (!Number.isSafeInteger(f.version) || f.version < 1 || typeof f.confirmed !== 'boolean' || typeof f.deleted !== 'boolean') fail();
      const evidence = list(f.evidenceMessageIds, 20).map(v => id(v, 'm'));
      return { id: id(f.id, 'f'), version: f.version as number, recordedAt: time(f.recordedAt), confirmedAt: time(f.confirmedAt), validFrom: time(f.validFrom),
        validUntil: f.validUntil === null ? null : time(f.validUntil), subject: text(f.subject, 120), content: text(f.content), evidence, confirmed: f.confirmed, deleted: f.deleted };
    });
    if (new Set(rawFacts.map(f => `${f.id}:${f.version}`)).size !== rawFacts.length) fail();
    const latest = new Map<string, typeof rawFacts[number]>();
    for (const f of rawFacts) if (f.recordedAt <= cutoff && (!latest.has(f.id) || latest.get(f.id)!.version < f.version)) latest.set(f.id, f);
    const facts = [...latest.values()].filter(f => f.confirmed && !f.deleted && f.confirmedAt <= cutoff && f.validFrom <= cutoff &&
      (!f.validUntil || f.validUntil > cutoff) && f.evidence.length > 0 && f.evidence.every(ref => visibleIds.has(ref))).map(f => ({
        id: f.id, contactId, version: f.version, subject: f.subject, content: f.content, confirmationStatus: 'confirmed' as const,
        validFrom: f.validFrom, validUntil: f.validUntil, deletionStatus: 'active' as const, evidenceRefs: f.evidence.map(ref => `message:${ref}`) }));
    const messages = visible.map(m => ({ ...m, contactId, type: 'text' as const, isAgentGenerated: m.actor === 'agent', mode: 'replay' as const, evidenceRef: `message:${m.id}` }));
    const context: ScopedContext = { contactId, messages, facts, analyses: [], snapshot: { id: `replay-snapshot-${index + 1}`, conversationId: `replay-conversation-${index + 1}`,
      generation: 1, cutoffMessageId, cutoffTime: cutoff, messageRefs: messages.map(m => m.id), summaryRefs: [], factRefs: facts.map(f => ({ id: f.id, version: f.version })),
      analysisRefs: [], policyVersion: 1, hash: createHash('sha256').update(JSON.stringify({ messages, facts, policy })).digest('hex') } };
    return { context, policy, excludedMessages: rawMessages.length - messages.length, excludedFacts: rawFacts.length - facts.length };
  });
  if (!samples.length) fail();
  return { externalAuthorized: auth.externalModelAuthorized === true, samples };
}
