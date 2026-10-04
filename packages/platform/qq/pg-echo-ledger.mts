/** Durable send-echo ledger: what did this system actually send, according to its own ledger?
 *
 * This is the only admissible proof that a self-message is our own system echo. Nothing about the
 * message body, its timestamp or its `message_sent_type` is consulted: the platform message id is
 * matched against the dispatch ledger this system wrote, and the account and peer have to agree with
 * what was recorded then. A match therefore cannot be forged by sending a similar-looking message.
 */
import { withTransaction, type PgClient, type PgPool } from '../../infrastructure/postgres/transaction.mts';

/** Attempts in these states may legitimately produce an echo; anything else must not match. */
const ECHO_STATES = ['SUBMITTED', 'DELIVERED'];

export type EchoLedgerMatch = {
  account: string; peer: string; platformMessageId: string; sendTaskId: string; sendKey: string;
};

export function createQqSendEchoLedger(pool: PgPool): {
  /** Runs on the caller's transaction when one is supplied, so the read serialises with dispatch writes. */
  findByPlatformMessageId(account: string, platformMessageId: string, tx?: PgClient): Promise<EchoLedgerMatch | undefined>;
} {
  async function queryOn(runner: PgClient, account: string, platformMessageId: string): Promise<EchoLedgerMatch | undefined> {
    const rows = await runner.query<{ account_id: string; external_contact_ref: string;
      platform_message_id: string; send_task_id: string; send_key: string }>(
      `SELECT a.account_id, c.external_contact_ref, a.platform_message_id, a.send_task_id, a.send_key
         FROM dispatch_attempts a
         JOIN orch_conversations c ON c.conversation_id = a.conversation_id
        WHERE a.account_id = $1
          AND a.platform_message_id = $2
          AND a.status = ANY($3::text[])
        ORDER BY a.updated_at DESC
        LIMIT 1
        FOR SHARE OF a, c SKIP LOCKED`, [account, platformMessageId, ECHO_STATES]);
    const row = rows.rows[0];
    return row ? { account: row.account_id, peer: row.external_contact_ref,
      platformMessageId: row.platform_message_id, sendTaskId: row.send_task_id, sendKey: row.send_key } : undefined;
  }
  return {
    findByPlatformMessageId(account, platformMessageId, tx) {
      if (typeof account !== 'string' || !account.trim() || typeof platformMessageId !== 'string' || !platformMessageId.trim())
        throw new Error('VALIDATION_FAILED');
      // Never open a second connection: that would read outside the receiving transaction and lose
      // the serialisation against `finishDispatch` that the echo decision depends on.
      // Never wait for an in-flight finishDispatch to supply missing evidence. A qualifying pair
      // stays locked until reception commits; locked or uncommitted pairs are no proof.
      return tx ? queryOn(tx, account, platformMessageId) : withTransaction(pool, runner => queryOn(runner, account, platformMessageId));
    },
  };
}
