export const memoryTypes = ['fact','preference','boundary','episode','promise','relationship_event','temporary_state'] as const;
export type MemoryType = typeof memoryTypes[number];
export type EvidenceType = 'explicit_statement' | 'user_confirmed' | 'inferred' | 'imported_unverified';
export type SourceRef = { id: string; version: number };
export type MemoryInput = {
  memoryType: MemoryType; subject: string; predicate: string; object: string; content: string;
  evidenceType: EvidenceType; evidenceRefs: SourceRef[]; confidence: number; importance: number;
  validFrom?: string; validUntil?: string; conflictKey?: string; locked?: boolean;
};
export type MemoryView = MemoryInput & {
  id: string; version: number; ownerId: string; contactId: string; conversationId: string; accountId: string;
  status: 'pending'|'active'|'superseded'|'expired'|'deleted'; observedAt: string; supersedesId: string|null;
  score?: number; selectionReasons?: string[];
};
export type ContextBudget = { totalTokens: number; outputReserve: number; systemReserve: number; recentLimit: number };
export const defaultContextBudget: ContextBudget = { totalTokens: 8192,outputReserve: 1024,systemReserve: 1024,recentLimit: 40 };
export type ContextV2Options = { ownerId: string; revision: number; triggerMessageIds: readonly string[]; budget?: Partial<ContextBudget>; retrievalMode?:'light'|'full' };
export type ContextMessageV2 = { id: string; version: number; actor: string; type: string; content: string; sentAt: string; quotedMessageId: string|null };
export type SummaryV2 = { id: string; version: number; content: string; sourceRefs: SourceRef[]; pendingTopics: { messageId: string; text: string }[]; fromMessageId: string; toMessageId: string; generatorVersion: string };
export type RelationshipV2 = { confirmedStage: string; inferredHint: string|null; locked: boolean; version: number; sourceRefs: SourceRef[] };
export type StyleV2 = { globalVersion: number|null; contactVersion: number|null; settings: Record<string,unknown>; statistics: Record<string,unknown>|null; examples: string[]; sourceRefs: SourceRef[]; deliveredEditRefs: SourceRef[] };
export type ContextPackageV2 = {
  personBackground?: import('./people.mts').PersonBackground;
  schemaVersion: '2.0'; identity: { ownerId: string; accountId: string; contactId: string; conversationId: string; platform: string };
  conversationRevision: number; triggerMessageIds: string[]; recentMessages: ContextMessageV2[]; quotedMessages: ContextMessageV2[];
  summary: SummaryV2|null; relationship: RelationshipV2; memories: MemoryView[]; personalStyle: StyleV2;
  facts: { id: string; version: number; subject: string; content: string }[];
  sourceRefs: SourceRef[]; selection: { id: string; included: boolean; reason: string }[];
  retrieval: { keyword: boolean; vector: boolean; embeddingModel: string|null };
  budget: ContextBudget & { estimatedInputTokens: number; estimateVersion: 'cjk-char-latin4-v1' };
};
