/** v2 tracks reply work without changing the existing platform or dispatch contracts. */
export const replyJobStates = ['RECEIVED', 'BUFFERING', 'CONTEXT_READY', 'DECIDING', 'GENERATING', 'VALIDATING',
  'PENDING_APPROVAL', 'SEND_QUEUED', 'SENDING', 'SUBMITTED', 'SENT', 'UNCERTAIN', 'FAILED',
  'STALE', 'SKIPPED', 'CANCELLED'] as const;
export type ReplyJobState = typeof replyJobStates[number];
export type PipelineVersion = 1 | 2;

const transitions: Record<ReplyJobState, readonly ReplyJobState[]> = {
  RECEIVED: ['BUFFERING', 'CONTEXT_READY', 'FAILED', 'STALE', 'CANCELLED'],
  BUFFERING: ['CONTEXT_READY', 'FAILED', 'STALE', 'CANCELLED'],
  CONTEXT_READY: ['DECIDING', 'GENERATING', 'FAILED', 'STALE', 'CANCELLED'],
  DECIDING: ['CONTEXT_READY', 'GENERATING', 'VALIDATING', 'SKIPPED', 'FAILED', 'STALE', 'CANCELLED'],
  // Recovery may rebuild context after a process died during a model request.
  GENERATING: ['CONTEXT_READY', 'VALIDATING', 'FAILED', 'STALE', 'CANCELLED'],
  VALIDATING: ['CONTEXT_READY', 'PENDING_APPROVAL', 'SKIPPED', 'FAILED', 'STALE', 'CANCELLED'],
  PENDING_APPROVAL: ['SEND_QUEUED', 'STALE', 'CANCELLED'],
  SEND_QUEUED: ['SENDING', 'STALE', 'CANCELLED'],
  SENDING: ['SEND_QUEUED', 'SUBMITTED', 'SENT', 'UNCERTAIN', 'FAILED'],
  SUBMITTED: ['SENT', 'UNCERTAIN', 'FAILED'],
  UNCERTAIN: ['SUBMITTED', 'SENT', 'FAILED'],
  SENT: [], FAILED: [], STALE: [], SKIPPED: [], CANCELLED: [],
};
export function canTransitionReplyJob(from: ReplyJobState, to: ReplyJobState): boolean {
  return from === to || transitions[from].includes(to);
}
export const cancellableReplyStates: readonly ReplyJobState[] = [
  'RECEIVED', 'BUFFERING', 'CONTEXT_READY', 'DECIDING', 'GENERATING', 'VALIDATING', 'PENDING_APPROVAL', 'SEND_QUEUED',
];
