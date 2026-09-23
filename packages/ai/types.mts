/** 04-local projection types. Cross-module semantics remain in docs/contracts.md. */
export type Mode = 'live' | 'import' | 'trial' | 'replay';
export type Actor = 'owner' | 'contact' | 'agent' | 'system' | 'platform' | 'unknown';

export interface SnapshotRef {
  id: string;
  version: number;
}

export interface ContextSnapshotProjection {
  id: string;
  conversationId: string;
  generation: number;
  cutoffMessageId: string | null;
  cutoffTime: string;
  messageRefs: string[];
  summaryRefs: string[];
  factRefs: SnapshotRef[];
  analysisRefs: SnapshotRef[];
  policyVersion: number;
  hash: string;
}

export interface MessageProjection {
  id: string;
  contactId: string;
  actor: Actor;
  type: 'text' | 'image' | 'voice' | 'sticker_static' | 'sticker_animated' | 'unsupported';
  text: string | null;
  sentAt: string;
  isAgentGenerated: boolean;
  mode: Mode;
  evidenceRef: string;
  mediaId?: string;
  mediaInterpretation?: MediaInterpretationDraft;
}

export interface FactProjection {
  id: string;
  contactId: string | null;
  version: number;
  subject: string;
  content: string;
  confirmationStatus: 'confirmed' | 'candidate' | 'inferred';
  validFrom: string;
  validUntil: string | null;
  deletionStatus: 'active' | 'deleted';
  evidenceRefs: string[];
}

export interface AnalysisProjection {
  id: string;
  contactId: string;
  version: number;
  cutoff?: string;
  status: 'valid' | 'invalidated' | 'draft';
  taxonomyVersion: string;
  observation: string;
  strategyHint: string | null;
  evidenceRefs: string[];
  uncertainty: string;
  counterEvidenceRefs?: string[];
  alternativeExplanations?: string[];
}

/** 03 has already filtered and resolved every ref before calling 04. */
export interface ScopedContext {
  contactId: string;
  snapshot: ContextSnapshotProjection;
  messages: MessageProjection[];
  facts: FactProjection[];
  analyses: AnalysisProjection[];
}

/** Read-only 02 projection; no mutation port or platform credential is accepted. */
export interface PolicyProjection {
  contactId: string;
  version: number;
  goal: string;
  sendMode: 'confirm' | 'auto';
  agentEnabled: boolean;
  activeContactEnabled: boolean;
  activeConfessionEnabled: boolean;
  restrictions: string[];
  stylePreferences: string[];
}

export type IntelligenceErrorCode = 'VALIDATION_FAILED' | 'MISSING_FACT' | 'MEDIA_UNCERTAIN' | 'UNSUPPORTED_CAPABILITY' | 'MODEL_UNAVAILABLE';
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: IntelligenceErrorCode; message: string; retryable: boolean; details?: string[] } };

export type RiskCategory = 'STOP_REQUEST' | 'REJECTION' | 'ACTIVE_CONTACT' | 'CONFESSION' | 'RELATIONSHIP_COMMITMENT' | 'CONCRETE_MEETING' | 'MONEY_OR_LEGAL' | 'SENSITIVE_DATA' | 'MISSING_FACT';
export interface ReplyDecision {
  conversationId: string;
  contextSnapshotId: string;
  shouldReply: boolean;
  timing: 'now' | 'wait' | 'delay' | 'no_reply';
  strategy: { summary: string; tone: string; analysisAdjustment: string | null; reason: string };
  riskCategories: RiskCategory[];
  requiredFacts: string[];
  confirmationReasons: string[];
  analysisRefs: SnapshotRef[];
  skillInvocationRefs: string[];
  generatorVersion: string;
  promptVersion: string;
  evidenceRefs: string[];
  uncertainty: string;
}

export interface ReplyPartProposal {
  clientPartKey: string;
  sequence: number;
  type: 'text';
  content: string;
}
export interface ReplyAlternativeProposal {
  clientAlternativeKey: string;
  strategySummary: string;
  parts: ReplyPartProposal[];
}
/** 02 supplies durable plan ID, policy/dependency versions, status and expiry. */
export interface ReplyProposal {
  conversationId: string;
  contextSnapshotId: string;
  triggerMessageIds: string[];
  alternatives: ReplyAlternativeProposal[];
  generatorVersion: string;
  promptVersion: string;
  evidenceRefs: string[];
  uncertainty: string;
}

export interface ReplyCheck {
  status: 'passed' | 'review_required' | 'blocked';
  factIssues: string[];
  styleIssues: string[];
  riskCategories: RiskCategory[];
  confirmationReasons: string[];
  evidenceRefs: string[];
  checkerVersion: string;
  /** A check is advisory. Only 02 may authorize or schedule a send. */
  authorization: 'not_evaluated';
}

export interface AnalysisClaim {
  kind: 'observation' | 'inference' | 'owner_confirmed_fact';
  text: string;
  supportingEvidence: string[];
  counterEvidence: string[];
  alternativeExplanations: string[];
  uncertainty: string;
}
export interface AnalysisDraft {
  contactId: string;
  contextSnapshotId: string;
  taxonomyVersion: 'draft-1';
  status: 'insufficient_evidence' | 'draft';
  sampleRange: { from: string | null; to: string };
  claims: AnalysisClaim[];
  stageHypotheses: [];
  trend: 'unknown';
  uncertainty: string;
  dependencySet: string[];
  analysisVersion: string;
}

export interface MediaInput {
  mediaId: string;
  mediaType: 'image' | 'voice' | 'sticker_static' | 'sticker_animated';
  sourceRef: string;
  /** Explicitly provided by a tested provider, never inferred from a missing value. */
  verifiedInterpretation?: { text: string; completeness: 'complete' | 'partial'; evidenceRefs: string[]; visualCoverage?: 'full_image' | 'single_frame' | 'temporal_sequence'; transcriptCoverage?: 'complete' | 'partial'; criticalUnclear?: boolean };
}
export interface MediaInterpretationDraft {
  mediaId: string;
  interpreterVersion: string;
  text: string;
  structuredMeaning: Record<string, unknown>;
  completeness: 'complete';
  uncertainty: string;
  evidenceRefs: string[];
  correctedByOwner: false;
  status: 'draft';
}
