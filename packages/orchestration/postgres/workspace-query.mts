import { setContactScope, withTransaction, type PgPool } from '../../infrastructure/postgres/transaction.mts';
import { PgOwnerDataPort } from '../../data/postgres/owner-data-port.mts';
import type { PgConfirmedService } from './confirmed-service.mts';

export type WorkspaceQuery = { search?: string; platform?: string; filter?: string; cursor?: string; limit?: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('VALIDATION_FAILED'); }
export function historyCursor(raw?: string): { at: string; id: string } | undefined {
  if (!raw) return;
  if (raw.length > 300 || !/^[\w-]+$/.test(raw)) invalid();
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) || typeof value.id !== 'string' || !uuid.test(value.id)) invalid();
    return { at: value.at, id: value.id };
  } catch { invalid(); }
}

export function createWorkspaceQueries(pool: PgPool, service: PgConfirmedService) {
  return {
    async list(query: WorkspaceQuery = {}) {
      const { search = '', platform = 'all', filter = 'all', cursor = '0', limit = 50 } = query;
      if (search.length > 200 || !['all','qq','wechat','unknown'].includes(platform) || !['all','pending','attention'].includes(filter)
        || !/^\d{1,8}$/.test(cursor) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
      const offset = Number(cursor);
      const items = await withTransaction(pool, async tx => {
        const rows = (await tx.query<{ conversation_id: string; contact_id: string; account_id: string; platform: string | null; state: string; version: number; pause_reasons: string[]; updated_at: string; unreviewed: number; pending: number; unknown: number }>(`
          SELECT c.*,a.platform,c.paused_inbound_unreviewed_count::int AS unreviewed,
          (SELECT count(*)::int FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id WHERE p.conversation_id=c.conversation_id AND t.status='PENDING' AND p.status='AWAITING_CONFIRMATION') AS pending,
          (SELECT count(*)::int FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id WHERE p.conversation_id=c.conversation_id AND s.status='RESULT_UNKNOWN') AS unknown
          FROM orch_conversations c LEFT JOIN orch_platform_accounts a ON a.account_id=c.account_id`)).rows;
        const result = [];
        for (const row of rows) {
          await setContactScope(tx, row.contact_id);
          const latest = (await tx.query<{ display_name: string; content_ref: string | null; type: string | null; sent_at: string | null }>(`
            SELECT c.display_name,m.content_ref,m.type,m.sent_at FROM data_contacts c LEFT JOIN LATERAL
            (SELECT content_ref,type,sent_at FROM data_messages WHERE contact_id=$1 AND conversation_id=$2::uuid AND deletion_status='active' ORDER BY sent_at DESC,id DESC LIMIT 1) m ON true
            WHERE c.id=$1`,[row.contact_id,row.conversation_id])).rows[0];
          if (!latest) throw new Error('FORBIDDEN');
          const name=latest.display_name, message=latest.sent_at ? latest : undefined;
          const needsAttention = row.pause_reasons.length > 0 || row.unknown > 0 || row.unreviewed > 0;
          result.push({ id: row.conversation_id, contactId: row.contact_id, contactName: name, accountId: row.account_id, platform: row.platform ?? 'unknown', status: row.state,
            version: Number(row.version), allowedActions: [...(row.pause_reasons.length ? ['resumeRoutine'] : ['pauseContact']), ...(row.unreviewed ? ['acknowledgePausedInbound'] : [])],
            pauseReasons: row.pause_reasons, pendingCount: row.pending, unknownSendCount: row.unknown, unreviewedPausedInboundCount: row.unreviewed, needsAttention,
            preview: message?.type === 'text' ? message.content_ref ?? '' : message ? `[${message.type}]` : '暂无消息',
            lastActivityAt: new Date(Math.max(new Date(row.updated_at).getTime(), message?.sent_at ? new Date(message.sent_at).getTime() : 0)).toISOString() });
        }
        return result;
      });
      const matches = items.filter(item => item.contactName.toLocaleLowerCase().includes(search.toLocaleLowerCase())
        && (platform === 'all' || item.platform === platform) && (filter === 'all' || (filter === 'pending' ? item.pendingCount > 0 : item.needsAttention)))
        .sort((a,b) => Number(b.needsAttention)-Number(a.needsAttention) || b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id));
      return { items: matches.slice(offset, offset + limit), total: matches.length, nextCursor: offset + limit < matches.length ? String(offset + limit) : null };
    },
    async detail(conversationId: string, before?: string) {
      if (!uuid.test(conversationId)) invalid();
      const cursor = historyCursor(before);
      const conversation = (await service.ownerConversations(conversationId, false)).items[0];
      if (!conversation) throw new Error('NOT_FOUND');
      const contact = (await service.ownerContacts(conversation.contactId)).items[0];
      if (!contact) throw new Error('FORBIDDEN');
      const page = await withTransaction(pool, async tx => {
        await setContactScope(tx, conversation.contactId);
        return (await tx.query<{ id: string; actor: string; type: string; content_ref: string | null; sent_at: string; media_id: string | null; platform_message_id: string }>(`
          SELECT id,actor,type,content_ref,sent_at,media_id,platform_message_id FROM data_messages
          WHERE contact_id=$1 AND conversation_id=$2::uuid AND deletion_status='active'
            AND ($3::timestamptz IS NULL OR (sent_at,id)<($3::timestamptz,$4::uuid))
          ORDER BY sent_at DESC,id DESC LIMIT 51`, [conversation.contactId, conversationId, cursor?.at ?? null, cursor?.id ?? null])).rows;
      });
      const messages = page.slice(0,50).reverse().map(row => ({ id: row.id, actor: row.actor, type: row.type, text: row.content_ref ?? undefined, at: new Date(row.sent_at).toISOString(), mediaId: row.media_id ?? undefined, platformMessageId: row.platform_message_id }));
      const origins = await new PgOwnerDataPort(pool).listUnknownOrigins({ contactIds: [conversation.contactId] });
      const last = page[49];
      return { contact, conversation: { ...conversation, messages: messages.map(m => ({ ...m, ...(m.actor === 'unknown' ? { originStatus: 'unknown', originEvidenceRefs: origins.items.find(o => o.messageId === m.id)?.originEvidenceRefs ?? [] } : {}) })) },
        tasks: (await service.ownerTasks(conversation.contactId)).items,
        nextCursor: page.length > 50 && last ? Buffer.from(JSON.stringify({ at: new Date(last.sent_at).toISOString(), id: last.id })).toString('base64url') : null };
    },
  };
}
