/** Private inputs, public numeric projection. Never return source rows or arbitrary labels. */
import { reportPromptVersion } from '../generation/prompt-versions.mts';
export type TrialWindow = { contactIds: string[]; start: string; end: string };
export type Tariff = { inputPerMillion: number; outputPerMillion: number; currency: 'CNY' | 'USD' };
export type TrialRow = { contact_id: string; plan_id: string; action: string; reason?: unknown; terminal_at: unknown;
  alternatives?: unknown; approved_alternative_id?: unknown; final_parts?: unknown; shown_alternative_ids?: unknown; context_snapshot_id?: string; prompt_version?: unknown };
export type PauseRow = { contact_id: string; pause_reasons: unknown; paused: unknown; global_paused?: unknown };
export type ModelCall = { planId?: string; contextSnapshotId?: string; callId?: string; at: string; outcome: 'ok' | 'error'; inputTokens: number | null;
  outputTokens: number | null; elapsedMs: number | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actions = ['selected', 'edited', 'rejected', 'regenerated', 'expired'] as const;
const reasons = ['not_my_style', 'too_long', 'wrong_tone', 'wrong_fact', 'should_not_reply', 'unspecified', 'unknown'];
const pauseReasons = ['GLOBAL_PAUSE', 'OWNER_PAUSE', 'OWNER_ORIGIN', 'OWNER_ORIGIN_UNMAPPED', 'STOP_REQUEST', 'MISSING_FACT',
  'MEDIA_UNCERTAIN', 'UNKNOWN_SEND', 'SEND_FAILURE', 'INTELLIGENCE_FAILURE', 'PLATFORM_MUTATION_UNVERIFIED', 'AUTO_REVIEW_UNAVAILABLE', 'AGENT_DISABLED'];
export function iso(value: unknown): string | null {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const at = Date.parse(text); return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
export function trialWindow(env: Record<string, string | undefined>): TrialWindow {
  const contactIds = (env.TRIAL_CONTACT_IDS ?? '').split(',').map(s => s.trim().toLowerCase());
  const start = iso(env.TRIAL_START), end = iso(env.TRIAL_END);
  if (!contactIds.length || contactIds.length > 100 || contactIds.some(id => !uuid.test(id)) || new Set(contactIds).size !== contactIds.length || !start || !end || start >= end)
    throw new Error('TRIAL_WINDOW_INVALID');
  return { contactIds, start, end };
}
export function tariffFromEnv(env: Record<string, string | undefined>): Tariff | undefined {
  const values = [env.TRIAL_INPUT_PER_MILLION, env.TRIAL_OUTPUT_PER_MILLION, env.TRIAL_CURRENCY];
  if (values.every(v => v === undefined)) return undefined;
  const [input, output] = values;
  if (!input?.trim() || !output?.trim() || !['CNY', 'USD'].includes(values[2] ?? '') ||
    ![input, output].every(v => /^\d+(?:\.\d+)?$/.test(v!) && Number.isFinite(Number(v)) && Number(v) <= 1e6)) throw new Error('TRIAL_TARIFF_INVALID');
  return { inputPerMillion: Number(input), outputPerMillion: Number(output), currency: values[2] as Tariff['currency'] };
}
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function parseModelLogs(logs: string[], window: TrialWindow): ModelCall[] {
  const calls: ModelCall[] = []; const ids = new Map<string, string>();
  for (const log of logs) for (const line of log.split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.event !== 'model_call') continue;
    const at = iso(row.at ?? row.ts);
    if (!at || at < window.start || at >= window.end) continue;
    const callId = typeof row.callId === 'string' && uuid.test(row.callId) ? row.callId.toLowerCase() : undefined;
    const call: ModelCall = { at, callId, planId: typeof row.planId === 'string' && uuid.test(row.planId) ? row.planId.toLowerCase() : undefined,
      contextSnapshotId: typeof row.contextSnapshotId === 'string' && uuid.test(row.contextSnapshotId) ? row.contextSnapshotId.toLowerCase() : undefined,
      outcome: row.outcome === 'ok' ? 'ok' : 'error', inputTokens: count(row.inputTokens), outputTokens: count(row.outputTokens),
      elapsedMs: typeof row.elapsedMs === 'number' && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 ? row.elapsedMs : null };
    if (callId) {
      const signature = JSON.stringify(call), prior = ids.get(callId);
      if (prior !== undefined) { if (prior !== signature) throw new Error('TRIAL_CALL_CONFLICT'); continue; }
      ids.set(callId, signature);
    }
    calls.push(call);
    if (calls.length > 100_000) throw new Error('TRIAL_LOG_TOO_LARGE');
  }
  return calls;
}

/** Unicode code points; two DP rows and an explicit work bound. Empty original has no ratio. */
export function editMagnitude(original: string, final: string) {
  let a = Array.from(original), b = Array.from(final);
  const originalLength = a.length;
  if (a.length * b.length > 4_000_000 || a.length > 20_000 || b.length > 20_000) return null;
  if (a.length > b.length) [a, b] = [b, a];
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const next = [j];
    for (let i = 1; i <= a.length; i++) next[i] = Math.min(next[i - 1]! + 1, prev[i]! + 1, prev[i - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = next;
  }
  const distance = prev[a.length]!;
  return { originalLength, finalLength: Array.from(final).length, distance, ratio: originalLength ? distance / originalLength : null };
}
function parts(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length || !value.every(p => p && typeof p.content === 'string')) return null;
  return value.map(p => p.content).join('\n');
}
function modelMetrics(calls: ModelCall[], tariff?: Tariff) {
  const total = (key: 'inputTokens' | 'outputTokens' | 'elapsedMs') => {
    if (!calls.length || !calls.every(c => c[key] !== null)) return null;
    const sum = calls.reduce((n, c) => n + c[key]!, 0);
    return Number.isFinite(sum) && (key === 'elapsedMs' || Number.isSafeInteger(sum)) ? sum : null;
  };
  const inputTokens = total('inputTokens'), outputTokens = total('outputTokens'), elapsed = total('elapsedMs');
  const estimatedCost = tariff && inputTokens !== null && outputTokens !== null
    ? (inputTokens * tariff.inputPerMillion + outputTokens * tariff.outputPerMillion) / 1e6 : null;
  return { calls: calls.length, errors: calls.filter(c => c.outcome === 'error').length, inputTokens, outputTokens,
    meanElapsedMs: elapsed === null ? null : elapsed / calls.length, estimatedCost };
}
export function buildTrialReport(window: TrialWindow, rows: TrialRow[], pauses: PauseRow[], calls: ModelCall[], tariff?: Tariff) {
  const selectedContacts = new Set(window.contactIds), seen = new Set<string>();
  const valid = rows.filter(row => {
    const at = iso(row.terminal_at);
    if (!selectedContacts.has(row.contact_id) || !at || at < window.start || at >= window.end || !actions.includes(row.action as typeof actions[number])) return false;
    if (seen.has(row.plan_id)) throw new Error('TRIAL_DUPLICATE_PLAN'); seen.add(row.plan_id); return true;
  });
  const linked = calls.flatMap(c => {
    if (c.at < window.start || c.at >= window.end) return [];
    const matches = valid.filter(r => c.planId ? r.plan_id === c.planId && (!c.contextSnapshotId || r.context_snapshot_id === c.contextSnapshotId) :
      !!c.contextSnapshotId && r.context_snapshot_id === c.contextSnapshotId);
    return matches.length === 1 ? [{ ...c, planId: matches[0]!.plan_id }] : [];
  });
  const summary = (items: TrialRow[]) => {
    const counts = Object.fromEntries(actions.map(action => [action, items.filter(r => r.action === action).length]));
    return { terminalCount: items.length, counts, directAdoptionRate: items.length ? counts.selected! / items.length : null,
      editedAdoptionRate: items.length ? counts.edited! / items.length : null, rejectionRate: items.length ? counts.rejected! / items.length : null,
      rejectionReasons: Object.fromEntries(reasons.map(reason => [reason, items.filter(r => r.action === 'rejected' &&
        (r.reason == null ? 'unspecified' : reasons.slice(0, 5).includes(String(r.reason)) ? r.reason : 'unknown') === reason).length])) };
  };
  const contacts = window.contactIds.map((contactId, index) => {
    const items = valid.filter(r => r.contact_id === contactId);
    const candidates = items.map((row, ordinal) => {
      const alternatives = Array.isArray(row.alternatives) ? row.alternatives : [];
      const chosenIndex = typeof row.approved_alternative_id === 'string' ? alternatives.findIndex(a => a?.alternativeId === row.approved_alternative_id) : -1;
      const original = chosenIndex < 0 ? null : parts(alternatives[chosenIndex]?.parts), final = parts(row.final_parts);
      const metric = original === null || final === null || !['selected', 'edited'].includes(row.action) ? null : editMagnitude(original, final);
      return { candidate: ordinal + 1, action: row.action, promptVersion: reportPromptVersion(row.prompt_version), chosenAlternative: chosenIndex < 0 ? null : chosenIndex + 1,
        shownAlternativeCount: Array.isArray(row.shown_alternative_ids) ? new Set(row.shown_alternative_ids).size : 0,
        edit: metric, model: modelMetrics(linked.filter(c => c.planId === row.plan_id), tariff) };
    });
    const pause = pauses.find(p => p.contact_id === contactId);
    const currentReasons = new Set(Array.isArray(pause?.pause_reasons) ? pause.pause_reasons.map(r => typeof r === 'string' && pauseReasons.includes(r) ? r : 'unknown') : []);
    if (pause?.global_paused === true) currentReasons.add('GLOBAL_PAUSE');
    return { contact: index + 1, ...summary(items), candidates,
      pauses: { intervalCount: null, historyCoverage: 'unavailable', currentPaused: pause ? pause.paused === true : null,
        currentReasons: Object.fromEntries([...currentReasons].map(r => [r, 1])) } };
  });
  return { schemaVersion: 1, window: { start: window.start, end: window.end }, cohort: 'terminal-at', ...summary(valid),
    contacts, promptVersions: [...new Set(valid.map(r => reportPromptVersion(r.prompt_version)))].map(version => {
      const items = valid.filter(r => reportPromptVersion(r.prompt_version) === version), ids = new Set(items.map(r => r.plan_id));
      return { promptVersion: version, ...summary(items), model: modelMetrics(linked.filter(c => ids.has(c.planId!)), tariff) };
    }), pricing: tariff ?? null, model: { ...modelMetrics(linked, tariff), linkedCandidateCount: new Set(linked.map(c => c.planId)).size,
      unattributedWindowRows: calls.length - linked.length, attribution: 'explicit-plan-or-unique-snapshot' },
    limitations: ['Rates use all terminal outcomes; presented is excluded. Confirmation is not delivery.',
      'Unlinked model logs cannot be assigned to selected contacts. Null means unavailable, never zero.',
      'Costs use supplied flat rates, exclude cache discounts and are estimates for whole plan generation.',
      'Pause counts have no complete historical source; current reasons are a snapshot at report execution.',
      'Edit distance uses Unicode code points and newline-separated parts; oversized comparisons are unavailable.'] };
}
export type TrialReport = ReturnType<typeof buildTrialReport>;
const value = (v: number | null) => v === null ? '数据不足' : String(Math.round(v * 1e6) / 1e6);
export function renderTrialMarkdown(report: TrialReport): string {
  const lines = ['# 试用统计（去标识化）', '', `区间：${report.window.start} 至 ${report.window.end}（末端不含）`, '',
    `终态方案：${report.terminalCount}；直接采用率：${value(report.directAdoptionRate)}；编辑采用率：${value(report.editedAdoptionRate)}；拒绝率：${value(report.rejectionRate)}`, '',
    '| 联系人序号 | 方案序号 | 动作 | 选中候选序号 | 编辑距离/原长 | 输入/输出 token | 平均时延 ms | 估算费用 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const contact of report.contacts) for (const candidate of contact.candidates) lines.push(`| ${contact.contact} | ${candidate.candidate} | ${candidate.action} | ${candidate.chosenAlternative ?? '—'} | ${value(candidate.edit?.ratio ?? null)} | ${value(candidate.model.inputTokens)}/${value(candidate.model.outputTokens)} | ${value(candidate.model.meanElapsedMs)} | ${value(candidate.model.estimatedCost)} |`);
  lines.push('', `费用币种：${report.pricing?.currency ?? '未提供费率'}；已关联方案：${report.model.linkedCandidateCount}；区间不可归属日志行：${report.model.unattributedWindowRows}。`, '');
  for (const group of report.promptVersions) lines.push(`提示词 ${group.promptVersion}：终态 ${group.terminalCount}，直接采用率 ${value(group.directAdoptionRate)}，编辑采用率 ${value(group.editedAdoptionRate)}，拒绝率 ${value(group.rejectionRate)}。`);
  for (const contact of report.contacts) lines.push(`联系人 ${contact.contact}：拒绝原因 ${JSON.stringify(contact.rejectionReasons)}；区间暂停次数：数据不足；当前暂停原因 ${JSON.stringify(contact.pauses.currentReasons)}。`);
  lines.push('', '口径：采用率以全部区间终态为分母；确认不代表送达。模型只接受明确方案关联；空值代表未知。费用按显式平价费率估算，方案生成费用不按替代候选重复计费。暂停历史不完整，当前原因是执行时快照。', '');
  return lines.join('\n');
}
