/** Owner session persistence. Durable on disk so a restart neither drops nor invents a login.
 * Only the hash of the cookie token is stored: reading the directory does not yield a usable session.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type OwnerSession = Readonly<{
  id: string;
  ownerId: string;
  tokenHash: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt: string | null;
}>;

export interface OwnerSessionStore {
  create(session: OwnerSession): Promise<void>;
  update(session: OwnerSession): Promise<void>;
  get(tokenHash: string): Promise<OwnerSession | null>;
  list(ownerId?: string): Promise<OwnerSession[]>;
  revokeAllForOwner(ownerId: string, at: string): Promise<number>;
  prune(now: string): Promise<number>;
}

/** One JSON file per session under a 0700 directory; bodies are 0600 and written atomically. */
export class FileOwnerSessionStore implements OwnerSessionStore {
  readonly #root: string;
  constructor(root: string) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('VALIDATION_FAILED');
    this.#root = root;
  }
  #path(tokenHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error('VALIDATION_FAILED');
    return join(this.#root, `${tokenHash}.json`);
  }
  async #ensure(): Promise<void> { await mkdir(this.#root, { recursive: true, mode: 0o700 }); }
  async #write(session: OwnerSession): Promise<void> {
    await this.#ensure();
    const path = this.#path(session.tokenHash);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(session), { mode: 0o600 });
    await rename(tmp, path);
  }
  async create(session: OwnerSession): Promise<void> {
    await this.#write(session);
  }
  async update(session: OwnerSession): Promise<void> {
    await this.#write(session);
  }
  async get(tokenHash: string): Promise<OwnerSession | null> {
    let raw: string;
    try { raw = await readFile(this.#path(tokenHash), 'utf8'); } catch { return null; }
    try {
      const parsed = JSON.parse(raw) as OwnerSession;
      return parsed?.tokenHash === tokenHash ? parsed : null;
    } catch { return null; }
  }
  async list(ownerId?: string): Promise<OwnerSession[]> {
    let names: string[];
    try { names = await readdir(this.#root); } catch { return []; }
    const rows: OwnerSession[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const session = await this.get(name.slice(0, -5));
      if (session && (!ownerId || session.ownerId === ownerId)) rows.push(session);
    }
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async revokeAllForOwner(ownerId: string, at: string): Promise<number> {
    let revoked = 0;
    for (const session of await this.list(ownerId)) {
      if (session.revokedAt) continue;
      await this.update({ ...session, revokedAt: at });
      revoked++;
    }
    return revoked;
  }
  async prune(now: string): Promise<number> {
    let removed = 0;
    for (const session of await this.list()) {
      const dead = session.absoluteExpiresAt <= now;
      if (!dead) continue;
      try { await rm(this.#path(session.tokenHash), { force: true }); removed++; } catch { /* keep the file for manual inspection */ }
    }
    return removed;
  }
}
