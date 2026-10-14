/** Registered immutable candidate templates. Version 1 is the baseline; production uses the humanlike version 3. */
export const DEFAULT_CANDIDATE_PROMPT = 'reply-candidates-1';
/** Owner's style examples, style summary, image descriptions, a tail reminder and chat-like output cleanup. */
export const HUMANLIKE_CANDIDATE_PROMPT = 'reply-candidates-3';
export const CANDIDATE_PROMPTS = [DEFAULT_CANDIDATE_PROMPT, 'reply-candidates-2', HUMANLIKE_CANDIDATE_PROMPT] as const;
export type CandidatePromptVersion = typeof CANDIDATE_PROMPTS[number];
export function candidatePromptVersion(value: unknown): CandidatePromptVersion {
  if (!(CANDIDATE_PROMPTS as readonly unknown[]).includes(value)) throw new Error('PROMPT_VERSION_UNKNOWN');
  return value as CandidatePromptVersion;
}
export function promptInstruction(version: string): string {
  candidatePromptVersion(version);
  return version === DEFAULT_CANDIDATE_PROMPT ? '' : '6) 优先一句简短回应；避免连续追问和重复复述，保留本人自然表达。';
}
export function isHumanlikePrompt(version: string): boolean {
  return version === HUMANLIKE_CANDIDATE_PROMPT;
}
/** Fixed labels only; arbitrary stored strings cannot leak into public trial reports. */
export function reportPromptVersion(value: unknown): string {
  return value === 'fixture-1' || (CANDIDATE_PROMPTS as readonly unknown[]).includes(value) ? value as string : 'unknown';
}
