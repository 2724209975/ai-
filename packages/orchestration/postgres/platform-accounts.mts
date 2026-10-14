import type { PgClient } from '../../infrastructure/postgres/transaction.mts';

/** Register from a trusted platform composition root; never guess the platform in the core. */
export async function registerPlatformAccount(tx: PgClient, accountId: string, platform: 'qq' | 'wechat'): Promise<void> {
  const result = await tx.query<{ platform: string | null; mapping_status: string }>(`
    INSERT INTO orch_platform_accounts(account_id,platform,mapping_status) VALUES($1,$2,'verified')
    ON CONFLICT(account_id) DO UPDATE SET updated_at=now()
    RETURNING platform,mapping_status`, [accountId, platform]);
  if (result.rows[0]?.platform !== platform || result.rows[0]?.mapping_status !== 'verified') throw new Error('ACCOUNT_PLATFORM_CONFLICT');
}
