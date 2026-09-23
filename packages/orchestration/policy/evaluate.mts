/** 02-owned policy reducer. Model output is untrusted advice, never an authorization. */
export type Risk = 'ordinary' | 'confession' | 'relationship_decision' | 'meeting_commitment' | 'major_commitment' | 'sensitive' | 'unknown_fact' | 'media_uncertain' | 'stop_request';
export type SendMode = 'confirm' | 'auto';
export type Policy = {
  contactId: string; agentEnabled: boolean; sendMode: SendMode; goal: string;
  activeContactEnabled: boolean; activeConfessionEnabled: boolean;
  allowedWindows: readonly { start: string; end: string }[]; timezone: string;
  factScopes: readonly string[]; restrictions: readonly string[]; version: number;
};
export type Route = { kind: 'confirm' | 'auto' | 'block'; reasons: string[] };

export function routeReply(policy: Policy, risks: readonly Risk[], proactive = false): Route {
  if (!policy.agentEnabled) return { kind: 'block', reasons: ['AGENT_DISABLED'] };
  if (risks.includes('stop_request')) return { kind: 'block', reasons: ['STOP_REQUEST'] };
  if (risks.includes('unknown_fact')) return { kind: 'confirm', reasons: ['MISSING_FACT'] };
  if (risks.includes('media_uncertain')) return { kind: 'confirm', reasons: ['MEDIA_UNCERTAIN'] };
  if (risks.includes('sensitive')) return { kind: 'confirm', reasons: ['SENSITIVE_CONTENT'] };
  if (proactive && !policy.activeContactEnabled) return { kind: 'block', reasons: ['ACTIVE_CONTACT_DISABLED'] };
  if (policy.sendMode === 'confirm') return { kind: 'confirm', reasons: ['CONFIRM_MODE'] };
  const reasons: string[] = [];
  if (proactive && !policy.allowedWindows.length) reasons.push('NO_ACTIVE_WINDOW');
  if (risks.includes('confession') && !policy.activeConfessionEnabled) reasons.push('CONFESSION_NOT_AUTHORIZED');
  if (risks.includes('relationship_decision')) reasons.push('RELATIONSHIP_DECISION');
  if (risks.includes('meeting_commitment')) reasons.push('MEETING_COMMITMENT');
  if (risks.includes('major_commitment')) reasons.push('MAJOR_COMMITMENT');
  return reasons.length ? { kind: 'confirm', reasons } : { kind: 'auto', reasons: [] };
}

export function defaultPolicy(contactId: string, timezone: string, goal: string): Policy {
  if (!contactId || !timezone || !goal) throw new Error('VALIDATION_FAILED');
  return { contactId, agentEnabled: true, sendMode: 'confirm', goal,
    activeContactEnabled: false, activeConfessionEnabled: false,
    allowedWindows: [], timezone, factScopes: [], restrictions: [], version: 1 };
}
