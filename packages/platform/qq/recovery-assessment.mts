/** Conservative, side-effect-free recovery assessment. It never submits or replays a send. */
import { WireError } from './onebot-codec.mts';

export type PendingAttempt = {
  conversationId: string; sendTaskId: string; sendKey: string;
  state: 'PRE_SUBMIT' | 'SUBMITTING' | 'RESULT_UNKNOWN' | 'SUBMITTED';
};
export type SendEvidence = {
  accountRef: string; conversationId: string; sendKey: string;
  outcome: 'accepted' | 'definitely_unsent' | 'unknown'; platformMessageId?: string;
};
export type RecoveryInput = {
  expectedAccountRef: string; persistedCursor: string | null;
  connection: { state: 'online' | 'offline' | 'relogin_required' | 'unknown'; observedAccountRef?: string };
  history: { coverage: 'complete' | 'partial' | 'unknown' | 'unavailable'; coversPersistedCursor: boolean; latestCursor?: string };
  attempts: PendingAttempt[]; evidence: SendEvidence[];
};
export type RecoveryAssessment = {
  state: 'DISCONNECTED' | 'RELOGIN_REQUIRED' | 'RECONCILING' | 'READY_FOR_PREFLIGHT';
  mayRequestNewPreflight: boolean; historyComplete: boolean; nextCursor: string | null;
  invalidatePreSubmitTaskIds: string[];
  unresolvedSendKeys: string[]; blockedConversations: string[];
  acceptedEvidence: { sendKey: string; platformMessageId: string }[];
  confirmedUnsentKeys: string[];
  requiresManualReview: boolean;
};

function required(x: unknown): x is string { return typeof x === 'string' && x.trim().length > 0; }

/** The caller must persist this assessment and have 02 redo live preflight; READY never means send now. */
export function assessQqRecovery(input: RecoveryInput): RecoveryAssessment {
  if (!required(input.expectedAccountRef) || !['online', 'offline', 'relogin_required', 'unknown'].includes(input.connection?.state)
    || !['complete', 'partial', 'unknown', 'unavailable'].includes(input.history?.coverage)
    || !Array.isArray(input.attempts) || !Array.isArray(input.evidence)
    || (input.persistedCursor !== null && !required(input.persistedCursor))) throw new WireError();
  const keys = new Set<string>(); const attemptByKey = new Map<string, PendingAttempt>();
  for (const a of input.attempts) {
    if (![a.conversationId, a.sendTaskId, a.sendKey].every(required)
      || !['PRE_SUBMIT', 'SUBMITTING', 'RESULT_UNKNOWN', 'SUBMITTED'].includes(a.state) || keys.has(a.sendKey)) throw new WireError();
    keys.add(a.sendKey); attemptByKey.set(a.sendKey, a);
  }
  const byKey = new Map<string, SendEvidence>();
  for (const e of input.evidence) {
    if (![e.accountRef, e.conversationId, e.sendKey].every(required) || !['accepted', 'definitely_unsent', 'unknown'].includes(e.outcome)
      || byKey.has(e.sendKey) || !keys.has(e.sendKey)) throw new WireError();
    const attempt = attemptByKey.get(e.sendKey)!;
    if (e.accountRef !== input.expectedAccountRef || e.conversationId !== attempt.conversationId) throw new WireError('CONFLICT_VERSION');
    const attemptedState = attempt.state;
    if ((attemptedState === 'PRE_SUBMIT' && e.outcome === 'accepted')
      || (attemptedState === 'SUBMITTED' && e.outcome === 'definitely_unsent')) throw new WireError('CONFLICT_VERSION');
    byKey.set(e.sendKey, e);
  }
  const accountMatches = input.connection.observedAccountRef === input.expectedAccountRef;
  const historyComplete = input.history.coverage === 'complete' && input.history.coversPersistedCursor === true
    && required(input.history.latestCursor) && input.persistedCursor !== null;
  const state: RecoveryAssessment['state'] = input.connection.state === 'relogin_required' ? 'RELOGIN_REQUIRED'
    : input.connection.state !== 'online' ? 'DISCONNECTED'
    : !accountMatches || !historyComplete ? 'RECONCILING' : 'READY_FOR_PREFLIGHT';
  const unresolvedSendKeys: string[] = []; const blocked = new Set<string>();
  const acceptedEvidence: RecoveryAssessment['acceptedEvidence'] = []; const confirmedUnsentKeys: string[] = [];
  for (const a of input.attempts) {
    if (a.state === 'PRE_SUBMIT' || a.state === 'SUBMITTED') continue;
    const e = byKey.get(a.sendKey);
    if (e?.outcome === 'accepted' && required(e.platformMessageId)) acceptedEvidence.push({ sendKey: a.sendKey, platformMessageId: e.platformMessageId });
    else if (e?.outcome === 'definitely_unsent') confirmedUnsentKeys.push(a.sendKey);
    else { unresolvedSendKeys.push(a.sendKey); blocked.add(a.conversationId); }
  }
  return {
    state, mayRequestNewPreflight: state === 'READY_FOR_PREFLIGHT', historyComplete: Boolean(historyComplete),
    nextCursor: state === 'READY_FOR_PREFLIGHT' ? input.history.latestCursor! : input.persistedCursor,
    invalidatePreSubmitTaskIds: input.attempts.filter(a => a.state === 'PRE_SUBMIT').map(a => a.sendTaskId),
    unresolvedSendKeys, blockedConversations: [...blocked], acceptedEvidence, confirmedUnsentKeys,
    requiresManualReview: state !== 'READY_FOR_PREFLIGHT' || unresolvedSendKeys.length > 0,
  };
}
