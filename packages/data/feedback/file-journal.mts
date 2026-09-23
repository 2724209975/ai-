/** Private, append-only feedback files for development and recovery testing. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError } from '../context/store.mts';

export type Feedback = Readonly<{ id: string; contactId: string; planId: string; shownAlternativeIds: readonly string[]; action: 'selected' | 'edited' | 'rejected' | 'owner-replied' | 'auto-rated'; originalContent: readonly string[]; finalContent: readonly string[]; reason?: string; rating?: Record<string, unknown>; source: 'owner' | 'system'; createdAt: string; updatedAt: string }>;

export class FileFeedbackJournal {
  private readonly root: string;
  private readonly planContact: (planId: string) => Promise<string | null>;
  private readonly clock: () => number;
  constructor(root: string, planContact: (planId: string) => Promise<string | null>, clock: () => number = Date.now) { this.root = root; this.planContact = planContact; this.clock = clock; }
  async recordFeedback(input: Omit<Feedback, 'id' | 'createdAt' | 'updatedAt'> & { callerContactId: string; idempotencyKey: string }): Promise<Feedback> {
    if (!input.contactId || input.callerContactId !== input.contactId) throw new DataError('FORBIDDEN');
    if (await this.planContact(input.planId) !== input.contactId) throw new DataError('NOT_FOUND');
    if (!input.idempotencyKey || Buffer.byteLength(input.idempotencyKey) > 64 || !['selected','edited','rejected','owner-replied','auto-rated'].includes(input.action) || !Array.isArray(input.shownAlternativeIds) || !Array.isArray(input.originalContent) || !Array.isArray(input.finalContent)) throw new DataError('VALIDATION_FAILED');
    const key = Buffer.from(input.idempotencyKey).toString('hex');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, `${key}.json`);
    try {
      const old = JSON.parse(await readFile(path, 'utf8')) as Feedback;
      if (old.contactId !== input.contactId || old.planId !== input.planId || old.action !== input.action || JSON.stringify(old.finalContent) !== JSON.stringify(input.finalContent)) throw new DataError('CONFLICT_VERSION');
      return structuredClone(old);
    } catch (e) { if (e instanceof DataError) throw e; if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const t = new Date(this.clock()).toISOString();
    const feedback: Feedback = { id: randomUUID(), contactId: input.contactId, planId: input.planId, shownAlternativeIds: [...input.shownAlternativeIds], action: input.action, originalContent: [...input.originalContent], finalContent: [...input.finalContent], reason: input.reason, rating: structuredClone(input.rating), source: input.source, createdAt: t, updatedAt: t };
    try { await writeFile(path, JSON.stringify(feedback), { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return this.recordFeedback(input);
    }
    return structuredClone(feedback);
  }
  async readFeedback(input: { callerContactId: string; contactId: string; idempotencyKey: string }): Promise<Feedback> {
    if (input.callerContactId !== input.contactId) throw new DataError('FORBIDDEN');
    if (!input.idempotencyKey || Buffer.byteLength(input.idempotencyKey) > 64) throw new DataError('VALIDATION_FAILED');
    try {
      const f = JSON.parse(await readFile(join(this.root, `${Buffer.from(input.idempotencyKey).toString('hex')}.json`), 'utf8')) as Feedback;
      if (f.contactId !== input.contactId || await this.planContact(f.planId) !== input.contactId) throw new DataError('NOT_FOUND');
      return structuredClone(f);
    } catch (e) { if (e instanceof DataError) throw e; throw new DataError('NOT_FOUND'); }
  }
}
