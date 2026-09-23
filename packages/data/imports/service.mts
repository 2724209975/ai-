/** Format-neutral import boundary. A D05-approved parser must supply these rows. */
import { createHash, randomUUID } from 'node:crypto';
import { DataError, type Actor, type MessageType, type MemoryDataContextStore } from '../context/store.mts';

export type ParsedRow = Readonly<{ line: number; externalConversationRef: string; platformMessageId: string; platformEventId: string; senderRef: string; type: MessageType; contentRef?: string; sentAt: string }>;
export type ImportPreview = Readonly<{ contactRef: string; firstAt: string; lastAt: string; messageCount: number }>;
export type ImportJob = Readonly<{ id: string; format: string; sourceHash: string; mode: 'import'; preview: readonly ImportPreview[]; identityMapping?: Readonly<Record<string, { contactId: string; ownerSenderRef: string; peerSenderRef: string }>>; confirmedScope?: readonly string[]; status: 'preview' | 'committed'; errorReport: readonly { line: number; reason: string }[]; createdAt: string; updatedAt: string }>;

export class MemoryImportService {
  #jobs = new Map<string, ImportJob>();
  #rows = new Map<string, readonly ParsedRow[]>();
  private readonly data: MemoryDataContextStore;
  private readonly clock: () => number;
  constructor(data: MemoryDataContextStore, clock: () => number = Date.now) { this.data = data; this.clock = clock; }

  previewImport(input: { format: string; sourceBytes: Uint8Array; rows: readonly ParsedRow[] }): ImportJob {
    if (!input.format?.trim() || !input.sourceBytes?.length || !Array.isArray(input.rows)) throw new DataError('VALIDATION_FAILED');
    const sourceHash = createHash('sha256').update(input.sourceBytes).digest('hex');
    const key = `${input.format}:${sourceHash}`;
    const existing = this.#jobs.get(key); if (existing) return structuredClone(existing);
    const errors: { line: number; reason: string }[] = [];
    const groups = new Map<string, { firstAt: string; lastAt: string; messageCount: number }>();
    for (const r of input.rows) {
      if (!Number.isSafeInteger(r.line) || r.line < 1 || !r.externalConversationRef || !r.platformMessageId || !r.platformEventId || !r.senderRef || !Number.isFinite(Date.parse(r.sentAt))) {
        errors.push({ line: r.line, reason: 'INVALID_ROW' }); continue;
      }
      const g = groups.get(r.externalConversationRef) ?? { firstAt: r.sentAt, lastAt: r.sentAt, messageCount: 0 };
      g.firstAt = g.firstAt < r.sentAt ? g.firstAt : r.sentAt;
      g.lastAt = g.lastAt > r.sentAt ? g.lastAt : r.sentAt;
      g.messageCount++; groups.set(r.externalConversationRef, g);
    }
    const t = new Date(this.clock()).toISOString();
    const job: ImportJob = { id: randomUUID(), format: input.format, sourceHash, mode: 'import', preview: [...groups].map(([contactRef, g]) => ({ contactRef, ...g })).sort((a,b) => a.contactRef.localeCompare(b.contactRef)), status: 'preview', errorReport: errors, createdAt: t, updatedAt: t };
    this.#jobs.set(key, job); this.#rows.set(job.id, structuredClone(input.rows)); return structuredClone(job);
  }

  commitImport(input: { jobId: string; platformAccountId: string; identityMapping: Readonly<Record<string, { contactId: string; conversationId: string; ownerSenderRef: string; peerSenderRef: string }>>; confirmedScope: readonly string[] }): { job: ImportJob; inserted: number; duplicates: number } {
    const entry = [...this.#jobs].find(([, j]) => j.id === input.jobId);
    if (!entry) throw new DataError('NOT_FOUND');
    const [key, job] = entry;
    if (job.status === 'committed') return { job: structuredClone(job), inserted: 0, duplicates: 0 };
    if (!input.platformAccountId || !Array.isArray(input.confirmedScope) || input.confirmedScope.length === 0) throw new DataError('VALIDATION_FAILED');
    const selected = new Set(input.confirmedScope);
    if ([...selected].some(ref => !job.preview.some(p => p.contactRef === ref))) throw new DataError('VALIDATION_FAILED');
    const rows = this.#rows.get(job.id)!;
    if (rows.some(r => selected.has(r.externalConversationRef) && job.errorReport.some(e => e.line === r.line))) throw new DataError('VALIDATION_FAILED');
    for (const ref of selected) {
      const m = input.identityMapping[ref];
      if (!m?.contactId || !m.conversationId || !m.ownerSenderRef || !m.peerSenderRef || m.ownerSenderRef === m.peerSenderRef) throw new DataError('VALIDATION_FAILED');
    }
    if (rows.some(row => selected.has(row.externalConversationRef) && ![input.identityMapping[row.externalConversationRef]!.ownerSenderRef, input.identityMapping[row.externalConversationRef]!.peerSenderRef].includes(row.senderRef))) throw new DataError('VALIDATION_FAILED');
    let inserted = 0; let duplicates = 0;
    for (const row of rows) {
      if (!selected.has(row.externalConversationRef)) continue;
      const m = input.identityMapping[row.externalConversationRef]!;
      const actor: Actor = row.senderRef === m.ownerSenderRef ? 'owner' : row.senderRef === m.peerSenderRef ? 'contact' : 'unknown';
      const result = this.data.appendObservedMessage({ contactId: m.contactId, conversationId: m.conversationId, platformAccountId: input.platformAccountId, platformMessageId: row.platformMessageId, platformEventId: row.platformEventId, actor, type: row.type, contentRef: row.contentRef, sentAt: row.sentAt, receivedAt: row.sentAt, provenance: `import:${job.format}`, isAgentGenerated: false, mode: 'import' });
      if (result.duplicate) duplicates++; else inserted++;
    }
    const next: ImportJob = { ...job, identityMapping: Object.fromEntries(Object.entries(input.identityMapping).map(([ref, m]) => [ref, { contactId: m.contactId, ownerSenderRef: m.ownerSenderRef, peerSenderRef: m.peerSenderRef }])), confirmedScope: [...selected], status: 'committed', updatedAt: new Date(this.clock()).toISOString() };
    this.#jobs.set(key, next); this.#rows.delete(job.id);
    return { job: structuredClone(next), inserted, duplicates };
  }
}
