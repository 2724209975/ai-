import { useEffect, useState, type KeyboardEvent } from 'react';
import { api, contentHash, type Task, type CommandResult } from '../api';
import { requestKey } from '../browser-crypto';
import { formatError, label, reason } from '../controls';

export type CandidateDraft = { conversationId: string; planId: string; version: number; selectedId: string; parts: string[]; edited: boolean };
export type DraftStore = Map<string, CandidateDraft>;
export type RunCommand = (path: string, body: Record<string, unknown>, version?: 'v1'|'v2') => Promise<CommandResult>;
export function draftKey(task: Task) { return `${task.conversationId}:${task.planId}:${task.planVersion}:${task.taskVersion}`; }

export function CandidateEditor({ task, drafts, run, blocked }: { task: Task; drafts: DraftStore; run: RunCommand; blocked: boolean }) {
  const identity = draftKey(task);
  const [draft, setDraft] = useState<CandidateDraft>(() => drafts.get(identity) ?? {
    conversationId: task.conversationId, planId: task.planId, version: task.planVersion,
    selectedId: task.alternatives[0]?.alternativeId ?? '', parts: task.alternatives[0]?.parts.map(p => p.content ?? '') ?? [], edited: false,
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [copyNotice,setCopyNotice]=useState('');
  const editable = (task.allowedActions.includes('confirmPlan') || task.allowedActions.includes('copyCandidate')) && !blocked && !busy;
  const shownIds = task.alternatives.map(a => a.alternativeId);
  useEffect(() => { drafts.set(identity, draft); }, [identity, draft, drafts]);
  useEffect(() => {
    if (task.allowedActions.length) void api.command(`/tasks/${encodeURIComponent(task.taskId)}/present`, {
      expectedVersion: task.taskVersion, idempotencyKey: `candidate-view:${task.taskId}:${task.taskVersion}`, shownAlternativeIds: shownIds,
    }).catch(() => {});
  }, [task.taskId, task.taskVersion, shownIds.join(','), task.allowedActions.join(',')]);
  function update(next: CandidateDraft) { drafts.set(identity, next); setDraft(next); }
  async function action(name: 'confirm' | 'regenerate' | 'reject') {
    const permission = { confirm: 'confirmPlan', regenerate: 'regeneratePlan', reject: 'rejectPlan' }[name];
    if (busy || blocked || !task.allowedActions.includes(permission)) return;
    setBusy(true); setError('');
    try {
      const base = { idempotencyKey: requestKey(), shownAlternativeIds: shownIds };
      if (name === 'confirm') {
        const alternative = task.alternatives.find(a => a.alternativeId === draft.selectedId);
        if (!alternative || alternative.parts.some(p => p.type !== 'text')) throw new Error('INVALID_PARTS');
        const editedParts = draft.parts.map(content => ({ type: 'text', content: content.trim() }));
        if (!editedParts.length || editedParts.some(p => !p.content || p.content.length > 4000)) { setError('请填写每条回复，单条不超过 4000 字。'); return; }
        await run(task.replyJob ? `/reply-jobs/${encodeURIComponent(task.replyJob.id)}/approve` : `/tasks/${encodeURIComponent(task.taskId)}/confirm`, { ...base, taskVersion: task.taskVersion, planVersion: task.planVersion, alternativeId: draft.selectedId, editedParts, contentHash: await contentHash(editedParts), ...(task.replyJob ? {expectedConversationRevision:task.replyJob.conversationRevision} : {}) }, task.replyJob ? 'v2' : 'v1');
      } else await run(`/tasks/${encodeURIComponent(task.taskId)}/${name}`, { ...base, expectedVersion: task.taskVersion, ...(name === 'reject' && rejectionReason ? { rejectionReason } : {}) });
    } catch (cause) { setError(formatError(cause)); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!editable || !task.allowedActions.includes('copyCandidate')) return;
    const text=draft.parts.join('\n').trim();
    if (!text) {setError('请填写回复内容。');return;}
    try {await navigator.clipboard.writeText(text);setCopyNotice('已复制，请到 QQ 自行发送。');}
    catch {const area=document.createElement('textarea');area.value=text;document.body.append(area);area.select();const copied=document.execCommand('copy');area.remove();setCopyNotice(copied?'已复制，请到 QQ 自行发送。':'请选中编辑框里的文字手动复制。');}
  }
  function shortcut(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (editable) void (task.candidateOnly ? copy() : action('confirm')); }
  }
  return <section className="candidate-editor" aria-label="回复候选" onKeyDown={shortcut}>
    <div className="card-head"><h3>回复候选</h3><span className="badge">{label(task.status)}</span></div>
    {task.triggerMessages.length > 0 && <p className="muted candidate-context">回应：{task.triggerMessages.map(m => m.text ?? `[${m.type}]`).join(' / ')}</p>}
    <div className="candidate-tabs">{task.alternatives.map((a,i) => <button key={a.alternativeId} disabled={!editable} aria-pressed={draft.selectedId === a.alternativeId}
      onClick={() => update({ ...draft, selectedId: a.alternativeId, parts: a.parts.map(p => p.content ?? ''), edited: false })}>{task.replyJob ? ['自然型','轻松型','直接型'][i] : `方案 ${i+1}`}</button>)}</div>
    {draft.parts.map((content,i) => <label key={i}>{draft.parts.length > 1 ? `第 ${i+1} 条回复` : task.candidateOnly ? '复制前编辑' : '发送前编辑'}<textarea rows={2} value={content} disabled={!editable}
      onChange={event => update({ ...draft, edited: true, parts: draft.parts.map((p,n) => n === i ? event.target.value : p) })} /></label>)}
    {!task.allowedActions.length && <p className="warning">当前候选不可发送，请处理上方暂停原因或查看最新候选。</p>}
    {task.alternatives.find(a=>a.alternativeId===draft.selectedId)?.requiresCurrentStateReview && <p className="warning">涉及你当前的情况，请核对并按实际情况修改。</p>}
    {copyNotice && <p role="status">{copyNotice}</p>}
    {task.candidateOnly && <p className="muted">仅生成建议，由你到 QQ 发送。复制不会写入已发送记录或长期记忆。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions">
      {task.allowedActions.includes('copyCandidate') && <button className="primary" disabled={!editable} onClick={()=>void copy()}>复制回复</button>}
      {!task.candidateOnly && task.allowedActions.includes('confirmPlan') && <button className="primary" disabled={!editable} onClick={() => void action('confirm')}>确认并发送</button>}
      {task.allowedActions.includes('regeneratePlan') && <button disabled={blocked || busy} onClick={() => void action('regenerate')}>重新生成候选</button>}
      {task.allowedActions.includes('rejectPlan') && <button disabled={blocked || busy} onClick={() => void action('reject')}>不回复</button>}
    </div>
    <details><summary>候选说明与反馈</summary><p>{task.alternatives.find(a => a.alternativeId === draft.selectedId)?.strategySummary}</p><p>{task.reasonCodes.map(reason).join('、')}</p>
      <label>不回复原因（可选）<select value={rejectionReason} disabled={busy || blocked} onChange={event => setRejectionReason(event.target.value)}><option value="">不填写</option><option value="not_my_style">不像我</option><option value="too_long">太长</option><option value="wrong_tone">语气不对</option><option value="wrong_fact">事实错</option><option value="should_not_reply">不该回</option></select></label>
      <small>方案版本 {task.planVersion} · 待办 {task.taskId}</small>
    </details>
  </section>;
}
