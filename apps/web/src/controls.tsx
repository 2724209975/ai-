import { useEffect, useState } from 'react';
import { requestKey as key } from './browser-crypto';
import { ApiError, type Contact, type Operable } from './api';

const labels: Record<string, string> = {
  PROBE_HEALTHY: '最近探测正常', UNKNOWN: '状态未知', SCHEDULED: '待发送', AWAITING_CONFIRMATION: '待确认', GENERATING: '生成中', READY_CONFIRM: '等待来信', RESUMED: '已恢复', ACTIVE: '已恢复', PARTIAL_RESUME: '部分恢复，仍需处理', PAUSED: '已暂停', REJECTED: '已选择不回复',
  DISABLED: '代理已关闭', UPDATED: '设置已保存',
  GENERATION_REQUESTED: '已加入候选生成队列', REVIEWED: '来信提醒已清除',
  CREATED: '尚未发送', PREFLIGHT: '发送前检查', LEASED: '待提交', SUBMITTING: '提交中',
  SUBMITTED: '平台已接收', DELIVERED: '已送达', FAILED_DEFINITE: '确定失败',
  REJECTED_PREFLIGHT: '发送前拒绝', CANCELLED_PRE_SUBMIT: '提交前取消',
  RESULT_UNKNOWN: '结果未知，禁止重复发送', PARTIALLY_SENT: '部分已发送',
  INVALIDATED: '已过期', PAUSED_UNKNOWN_SEND: '未知发送，已暂停',
  PAUSED_OWNER: '人工接管或来源待核，已暂停', PAUSED_GLOBAL: '全局暂停',
  PAUSED_FAILURE: '故障暂停', PAUSED_MEDIA: '媒体待核，已暂停',
  PAUSED_MISSING_FACT: '缺少事实，已暂停', PAUSED_STOP_REQUEST: '停止联系，已暂停',
  RELOGIN_REQUIRED: '需要重新登录', RECONCILING: '正在核对历史与发送结果',
  DISCONNECTED: '已断开', DEGRADED: '能力受限', CONNECTED: '连接已建立',
};
export const label = (value: string) => labels[value] ?? labels[value.toUpperCase()] ?? value;
const reasonLabels: Record<string, string> = {
  AWAITING_MANUAL_RESUME: '等待人工恢复', NEW_MESSAGE: '新来信使旧方案失效',
  OWNER_PAUSE: '手动暂停', OWNER_ORIGIN_UNMAPPED: '自身账号消息未匹配联系人', ACCOUNT_FAULT: '账号故障或待恢复', GLOBAL_PAUSE: '全局暂停', STOP_REQUEST: '对方要求停止联系', MISSING_FACT: '事实待补充', AGENT_DISABLED: '代理关闭', INTELLIGENCE_FAILURE: '模型调用失败', CONFIRMATION_REJECTED: '已选择不回复',
  AUTO_REVIEW_UNAVAILABLE: '自动模式暂未开放，本轮转人工确认',
  CONFIRM_MODE: '联系人使用确认模式',
  OWNER_ORIGIN: '自身账号消息来源未明或人工接管，须本人核对',
  UNKNOWN_SEND: '发送结果未知，核对前禁止重复发送',
  MEDIA_UNCERTAIN: '媒体含义待核对',
  MODEL_UNAVAILABLE: '模型故障，处理已暂停',
};
export const reason = (code: string) => reasonLabels[code] ?? code;
export const can = (row: Operable, action: string) => row.allowedActions.includes(action);
export const formatError = (error: unknown) => {
  if (!(error instanceof ApiError)) return '读取失败，请稍后重试。';
  const message = error.status === 501 ? '该页面的持久化接口尚未提供，当前状态不可用。'
    : error.status === 503 ? error.body.code === 'SEND_RESULT_UNKNOWN' ? '发送结果未知，须先核对平台状态；不要重复提交。' : '服务或依赖暂不可用，当前状态不能视为正常。'
    : error.message;
  return `${message}${error.body.correlationId ? ` · 追踪 ${error.body.correlationId}` : ''}`;
};
export const safeMediaUrl = (url?: string) => url?.startsWith('/api/v1/media/') && !url.includes('..') ? url : undefined;

export function RowActions({ row, prefix, run, actions }: { row: Operable; prefix: string; run: (path: string, body: Record<string, unknown>) => Promise<void>; actions: { name: string; title: string; extra?: Record<string, unknown> }[] }) {
  return <div className="actions">{actions.filter(action => can(row, action.name)).map(action => <button key={action.name} onClick={() => void run(`${prefix}/${encodeURIComponent(row.id)}/${action.name}`, { expectedVersion: row.version, idempotencyKey: key(), ...action.extra })}>{action.title}</button>)}</div>;
}

export function ContactAgentControl({ row, run }: { row: Contact; run: (path: string, body: Record<string, unknown>) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      await run(`/contacts/${encodeURIComponent(row.id)}/updatePolicy`, {
        expectedVersion: row.version, idempotencyKey: key(), policy: { agentEnabled: !row.agentEnabled },
      });
    } catch { /* The shared command handler displays errors and refreshes stale versions. */ }
    finally { setBusy(false); }
  }
  return <button disabled={busy} onClick={() => void toggle()}>{row.agentEnabled ? '关闭代理' : '开启代理'}</button>;
}

export function ContactPolicyEditor({ row, run }: { row: Contact; run: (path: string, body: Record<string, unknown>) => Promise<void> }) {
  const [goal, setGoal] = useState(row.goal);
  const [style, setStyle] = useState((row.stylePreferences ?? []).join('\n'));
  const [restrictions, setRestrictions] = useState((row.restrictions ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setGoal(row.goal);
    setStyle((row.stylePreferences ?? []).join('\n'));
    setRestrictions((row.restrictions ?? []).join('\n'));
    setError('');
  }, [row.policyVersion]);
  const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  async function save() {
    if (busy) return;
    const styles = lines(style), limits = lines(restrictions);
    if (!goal.trim() || goal.length > 200 || styles.length > 24 || limits.length > 24 ||
      [...styles, ...limits].some(line => line.length > 120)) {
      setError('目标或条目过长，请缩短后再保存。'); return;
    }
    setBusy(true); setError('');
    try {
      await run(`/contacts/${encodeURIComponent(row.id)}/updatePolicy`, {
        expectedVersion: row.version, idempotencyKey: key(),
        policy: { goal: goal.trim(), stylePreferences: styles, restrictions: limits },
      });
    } catch { /* The shared command handler shows the backend error and refreshes stale versions. */ }
    finally { setBusy(false); }
  }
  return <div className="editor">
    <label>聊天目标<input value={goal} maxLength={200} disabled={busy} onChange={event => setGoal(event.target.value)} /></label>
    <label>表达偏好（每行一条）<textarea rows={2} value={style} disabled={busy} placeholder="例如：简短、像日常聊天" onChange={event => setStyle(event.target.value)} /></label>
    <label>避免内容（每行一条）<textarea rows={2} value={restrictions} disabled={busy} placeholder="例如：不提具体见面时间" onChange={event => setRestrictions(event.target.value)} /></label>
    {error && <p className="error" role="alert">{error}</p>}
    <button disabled={busy} onClick={() => void save()}>保存聊天设置</button>
  </div>;
}

