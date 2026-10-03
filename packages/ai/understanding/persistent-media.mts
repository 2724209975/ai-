/** 04 returns unpersisted image drafts; 02 commits them through 03 before requesting candidates. */
import type { ImagePreparationPort } from '../../orchestration/postgres/media-preparation.mts';
import { adaptDataContextProjection } from './context-adapter.mts';
import { interpretContextMedia, type MediaUnderstandingOptions } from './media-provider.mts';
import { pendingContactBatch } from '../strategy/fake-decision.mts';

export function createImageMediaInterpreter(options: MediaUnderstandingOptions): ImagePreparationPort['interpret'] {
  return async (context, policy) => {
    const scoped = adaptDataContextProjection(context);
    const pending = pendingContactBatch(scoped);
    if (pending.some(m => !['image', 'text'].includes(m.type) || m.actor !== 'contact' || m.mode !== 'live')) return null;
    if (!pending.some(m => m.type === 'image' && !m.mediaInterpretation)) return [];
    const result = await interpretContextMedia(scoped, { ...policy, stylePreferences: [...(policy.stylePreferences ?? [])] }, options);
    if (!result.ok) return null;
    return pendingContactBatch(result.value).flatMap(m => m.mediaInterpretation?.status === 'draft' ? [m.mediaInterpretation] : []);
  };
}
