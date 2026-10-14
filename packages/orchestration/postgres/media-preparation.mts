/** 02 owns preparation commits; all slow acquisition/understanding stays outside its locks. */
import { randomUUID } from 'node:crypto';
import type { PgPool, PgClient } from '../../infrastructure/postgres/transaction.mts';
import { withTransaction, setContactScope } from '../../infrastructure/postgres/transaction.mts';
import { acquireDispatchBoundary } from '../../infrastructure/postgres/dispatch-journal.mts';
import type { PgDataProvider } from '../../data/postgres/provider.mts';
import type { MediaAsset } from '../../data/media/file-store.mts';
import type { MediaDraftInput } from '../../data/postgres/media-repository.mts';
import type { Policy } from '../policy/evaluate.mts';
import type { PersistentContext } from './confirmed-service.mts';

export type ImagePreparationPort = {
  acquire?(context: PersistentContext, policy: Policy): Promise<readonly { asset: MediaAsset; expectedMessageVersion: number }[] | null>;
  interpret(context: PersistentContext, policy: Policy): Promise<readonly MediaDraftInput[] | null>;
  discard?(assets: readonly MediaAsset[]): Promise<void>;
};
type Fence = { generation: number; dependency: number; pause: number; globalPause: number; skill: number };
type GateRow = Record<string, unknown> & { pause_reasons: string[] };
type Input = { pool: PgPool; data: PgDataProvider; port: ImagePreparationPort; context: PersistentContext; policy: Policy };

export async function preparePersistentImages(input: Input): Promise<{ context: PersistentContext; ready: boolean }> {
  const { pool, data, port, policy } = input;
  let context = input.context;
  const contactId = context.snapshot.contactId, conversationId = context.snapshot.conversationId;
  if (policy.contactId !== contactId || policy.sendMode !== 'confirm' || !policy.agentEnabled) return { context, ready: false };
  async function check(tx: PgClient, expected?: Fence): Promise<Fence> {
    await acquireDispatchBoundary(tx); await setContactScope(tx, contactId);
    const row = (await tx.query<GateRow>(`SELECT c.generation AS orch_generation,c.state,c.pause_reasons,c.policy_version,
      d.generation,d.dependency_epoch,d.pause_epoch,d.skill_epoch,d.paused,d.unresolved_send_key,
      g.pause_epoch AS global_pause_epoch,g.paused AS global_paused
      FROM orch_conversations c JOIN dispatch_control d USING(conversation_id)
      CROSS JOIN dispatch_global_control g WHERE c.conversation_id=$1 AND c.contact_id=$2 AND g.singleton=true FOR UPDATE OF c`,
      [conversationId, contactId])).rows[0];
    const f = row && { generation: Number(row.generation), dependency: Number(row.dependency_epoch),
      pause: Number(row.pause_epoch), globalPause: Number(row.global_pause_epoch), skill: Number(row.skill_epoch) };
    if (!f || row.state !== 'GENERATING' || row.pause_reasons.length || row.paused || row.global_paused || row.unresolved_send_key ||
      Number(row.policy_version) !== policy.version || Number(row.orch_generation) !== f.generation ||
      (expected ? Object.keys(expected).some(k => f[k as keyof Fence] !== expected[k as keyof Fence]) :
        f.generation !== context.snapshot.generation || f.dependency !== context.dependencyEpoch)) throw new Error('STALE_CONTEXT');
    return f;
  }
  let fence = await withTransaction(pool, tx => check(tx));
  async function commit(write: (tx: PgClient) => Promise<void>): Promise<void> {
    await withTransaction(pool, async tx => {
      await check(tx, fence);
      await data.readContextProjection(tx, { callerContactId: contactId, contactId, allowedScopes: policy.factScopes,
        snapshotId: context.snapshot.id, expectedDependencyEpoch: context.dependencyEpoch });
      await write(tx);
      // Rebase only across dependency changes made under this transaction's boundary lock.
      const d = (await tx.query('SELECT generation,dependency_epoch FROM dispatch_control WHERE conversation_id=$1', [conversationId])).rows[0];
      await tx.query('UPDATE orch_conversations SET generation=$2,version=version+1 WHERE conversation_id=$1', [conversationId, Number(d.generation)]);
      context = await data.buildContext(tx, { callerContactId: contactId, contactId, allowedScopes: policy.factScopes,
        generation: Number(d.generation), policyVersion: policy.version, cutoffTime: context.snapshot.cutoffTime,
        cutoffMessageId: context.snapshot.cutoffMessageId ?? undefined, mode: 'live',
        v2:context.contextPackageV2?{ownerId:context.contextPackageV2.identity.ownerId,revision:context.contextPackageV2.conversationRevision,
          triggerMessageIds:context.contextPackageV2.triggerMessageIds,budget:context.contextPackageV2.budget}:undefined });
      fence = { ...fence, generation: Number(d.generation), dependency: Number(d.dependency_epoch) };
    });
  }
  if (port.acquire) {
    const assets = await port.acquire(context, policy);
    let bound = false;
    try {
      await withTransaction(pool, tx => check(tx, fence));
      if (assets === null) return { context, ready: false };
      if (assets.length > 8) throw new Error('VALIDATION_FAILED');
      if (assets.length) await commit(async tx => {
        for (const item of assets) {
          const source = context.messages.find(m => m.id === item.asset.messageId);
          if (!source || source.type !== 'image' || source.actor !== 'contact' || source.mode !== 'live' || source.mediaId ||
            item.asset.mediaType !== 'image' || context.snapshot.messageRefs.find(r => r.id === source.id)?.version !== item.expectedMessageVersion)
            throw new Error('VALIDATION_FAILED');
          await data.registerMediaAsset(tx, { callerContactId: contactId, contactId, ...item }, randomUUID());
        }
      });
      bound = true;
    } finally { if (!bound && assets?.length) await port.discard?.(assets.map(i => i.asset)); }
  }
  const drafts = await port.interpret(context, policy);
  await withTransaction(pool, tx => check(tx, fence));
  if (drafts === null) return { context, ready: false };
  if (drafts.length > 8) throw new Error('VALIDATION_FAILED');
  if (drafts.length) await commit(async tx => {
    for (const draft of drafts) {
      const message = context.messages.find(m => m.mediaId === draft.mediaId);
      const ref = message && context.snapshot.messageRefs.find(r => r.id === message.id);
      if (!ref || !message || message.type !== 'image' || message.mediaInterpretation) throw new Error('VALIDATION_FAILED');
      await data.storeMediaInterpretation(tx, { callerContactId: contactId, contactId, draft,
        expectedMessageVersion: ref.version, expectedAssetVersion: Number(draft.structuredMeaning.sourceAssetVersion),
        expectedInterpretationVersion: 0, cutoffTime: context.snapshot.cutoffTime }, randomUUID());
    }
  });
  return { context, ready: true };
}
