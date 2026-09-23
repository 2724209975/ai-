import type { SkillDraft } from './types.mts';

/** D12 provisional built-in catalog. Installing definitions never creates grants. */
const seeds: readonly Pick<SkillDraft, 'name' | 'purpose' | 'stage' | 'rules'>[] = [
  { name: '对方与关系分析', purpose: '整理有证据的互动观察', stage: 'analysis', rules: [{ kind: 'method', value: 'clarify' }] },
  { name: '话题延续', purpose: '延续当前话题', stage: 'strategy', rules: [{ kind: 'method', value: 'continue_topic' }] },
  { name: '暧昧互动', purpose: '在已授权目标内建议表达分寸', stage: 'strategy', rules: [{ kind: 'tone', value: 'gentle' }] },
  { name: '邀约', purpose: '建议表达见面意向，具体安排交由本人确认', stage: 'strategy', rules: [{ kind: 'method', value: 'clarify' }] },
  { name: '冲突处理', purpose: '澄清误会并表达尊重', stage: 'strategy', rules: [{ kind: 'method', value: 'acknowledge' }] },
  { name: '个人表达', purpose: '使用本人批准的表达习惯', stage: 'expression', rules: [{ kind: 'tone', value: 'concise' }] },
];
export const BUILTIN_DRAFTS: readonly SkillDraft[] = seeds.map(x => ({ ...x, applicability: { topics: [], excludeTopics: [] }, requiredContext: { factSubjects: [] }, examples: [], outputContract: 'advice-v1', visibilityScope: 'global' }));
