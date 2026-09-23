import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, contentHash, type Alternative, type Analysis, type Contact, type Conversation, type Fact, type Fault, type ImportJob, type Media, type Operable, type Overview, type SendTask, type Skill, type Task, type AuditEntry } from './api';

type Page = 'overview' | 'contacts' | 'conversations' | 'tasks' | 'facts' | 'analyses' | 'media' | 'skills' | 'imports' | 'audit' | 'faults';
const pages: { id: Page; label: string }[] = [
  { id: 'overview', label: '总览' }, { id: 'tasks', label: '待办' }, { id: 'contacts', label: '联系人' },
  { id: 'conversations', label: '会话' }, { id: 'facts', label: '资料记忆' }, { id: 'analyses', label: '分析证据' },
  { id: 'media', label: '媒体素材' }, { id: 'skills', label: 'Skill' }, { id: 'imports', label: '导入' },
  { id: 'audit', label: '审计' }, { id: 'faults', label: '故障' },
];
const labels: Record<string, string> = {
  CREATED: '尚未发送', PREFLIGHT: '发送前检查', LEASED: '待提交', SUBMITTING: '提交中',
  SUBMITTED: '平台已接收', DELIVERED: '已送达', FAILED_DEFINITE: '确定失败',
  REJECTED_PREFLIGHT: '发送前拒绝', CANCELLED_PRE_SUBMIT: '提交前取消',
  RESULT_UNKNOWN: '结果未知，禁止重复发送', PARTIALLY_SENT: '部分已发送',
  INVALIDATED: '已过期', PAUSED_UNKNOWN_SEND: '未知发送，已暂停',
};
const label = (value: string) => labels[value] ?? value;
const can = (row: Operable, action: string) => row.allowedActions.includes(action);
const key = () => crypto.randomUUID();
const formatError = (error: unknown) => error instanceof ApiError ? `${error.message}${error.body.correlationId ? ` · 追踪 ${error.body.correlationId}` : ''}` : '读取失败，请稍后重试。';
const safeMediaUrl = (url?: string) => url?.startsWith('/api/v1/media/') && !url.includes('..') ? url : undefined;

function SendState({ sends }: { sends: SendTask[] }) {
  if (!sends.length) return <p className="muted">尚无发送任务，不代表已发送。</p>;
  return <ol className="send-list">{sends.map(send => <li key={send.sendTaskId}><strong>第 {send.sequence} 条：{label(send.status)}</strong>
    {send.receiptLevel && <span> · 回执 {send.receiptLevel}</span>}
    {send.lastError && <p className="muted">{send.lastError}</p>}
    {send.correlationId && <small>追踪 {send.correlationId}</small>}
  </li>)}</ol>;
}

function TaskCard({ task, run }: { task: Task; run: (path: string, body: Record<string, unknown>) => Promise<void> }) {
  const [selected, setSelected] = useState<Alternative | null>(task.alternatives[0] ?? null);
  const [parts, setParts] = useState((task.alternatives[0]?.parts ?? []).map(part => part.content ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const first = task.alternatives[0] ?? null; setSelected(first); setParts((first?.parts ?? []).map(part => part.content ?? '')); setError(''); }, [task.taskVersion, task.planVersion, task.planId]);
  async function submit() {
    if (!selected || busy || !can(task, 'confirmPlan')) return;
    if (selected.parts.some(part => part.type !== 'text')) { setError('当前页面只能编辑文字；表情素材确认接口待定。'); return; }
    const editedParts = parts.map(content => ({ type: 'text', content: content.trim() }));
    if (!editedParts.length || editedParts.some(part => !part.content)) { setError('请填写每条回复内容。'); return; }
    setBusy(true); setError('');
    try {
      await run(`/tasks/${encodeURIComponent(task.taskId)}/confirm`, {
        taskVersion: task.taskVersion, planVersion: task.planVersion, alternativeId: selected.alternativeId,
        editedParts, contentHash: await contentHash(editedParts), idempotencyKey: key(),
      });
    } catch (cause) { setError(formatError(cause)); }
    finally { setBusy(false); }
  }
  return <article className="card">
    <div className="card-head"><div><h3>{task.contactName}</h3><p className="muted">待办 {task.taskId} · 方案版本 {task.planVersion}</p></div><span className="badge">{label(task.status)}</span></div>
    <p>触发原因：{task.reasonCodes.join('、') || '未提供'}</p>
    {task.invalidationReason && <p role="alert" className="warning">已失效：{task.invalidationReason}。旧内容未发送。</p>}
    {task.triggerMessages.map(message => <blockquote key={message.id}><small>{message.at} · {message.type}</small><p>{message.text ?? '媒体消息，请查看会话中的受控媒体。'}</p></blockquote>)}
    {!!task.requiredInputs?.length && <p>需要补充：{task.requiredInputs.join('、')}</p>}
    <h4>候选方案</h4>
    <div className="choices">{task.alternatives.map((alternative, index) => <button type="button" key={alternative.alternativeId}
      className={selected?.alternativeId === alternative.alternativeId ? 'choice selected' : 'choice'}
      aria-pressed={selected?.alternativeId === alternative.alternativeId}
      disabled={busy || !can(task, 'confirmPlan')}
      onClick={() => { setSelected(alternative); setParts(alternative.parts.map(part => part.content ?? '')); setError(''); }}>
      <strong>方案 {index + 1}</strong><span>{alternative.parts.map(part => part.content ?? '已批准表情素材').join(' / ')}</span><small>{alternative.strategySummary}</small>
    </button>)}</div>
    {selected && can(task, 'confirmPlan') && <div className="editor"><h4>发送前编辑</h4>{selected.parts.map((part, index) => <label key={part.replyPartId}>第 {index + 1} 条
      <textarea rows={3} value={parts[index] ?? ''} disabled={busy || part.type !== 'text'} onChange={event => setParts(old => old.map((value, i) => i === index ? event.target.value : value))} />
    </label>)}</div>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions">
      {can(task, 'confirmPlan') && <button className="primary" disabled={busy} onClick={() => void submit()}>确认并发送</button>}
      {can(task, 'rejectPlan') && <button disabled={busy} onClick={() => void run(`/tasks/${encodeURIComponent(task.taskId)}/reject`, { expectedVersion: task.taskVersion, idempotencyKey: key() })}>拒绝候选</button>}
    </div>
    <h4>逐条发送状态</h4><SendState sends={task.sends} />
  </article>;
}

function RowActions({ row, prefix, run, actions }: { row: Operable; prefix: string; run: (path: string, body: Record<string, unknown>) => Promise<void>; actions: { name: string; title: string; extra?: Record<string, unknown> }[] }) {
  return <div className="actions">{actions.filter(action => can(row, action.name)).map(action => <button key={action.name} onClick={() => void run(`${prefix}/${encodeURIComponent(row.id)}/${action.name}`, { expectedVersion: row.version, idempotencyKey: key(), ...action.extra })}>{action.title}</button>)}</div>;
}

function App() {
  const initial = location.hash.slice(1) as Page;
  const [page, setPage] = useState<Page>(pages.some(item => item.id === initial) ? initial : 'overview');
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [auth, setAuth] = useState<'checking' | 'anonymous' | 'signed-in'>('checking');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  useEffect(() => {
    const onHash = () => { const target = location.hash.slice(1) as Page; if (pages.some(item => item.id === target)) setPage(target); };
    addEventListener('hashchange', onHash); return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    let active = true;
    void api.session().then(() => { if (active) setAuth('signed-in'); }).catch(() => { if (active) setAuth('anonymous'); });
    return () => { active = false; };
  }, []);
  async function signIn() {
    if (signingIn || !password) return;
    setSigningIn(true); setAuthError('');
    try {
      await api.login(password);
      setPassword('');
      setAuth('signed-in');
      refresh();
    } catch (cause) {
      const body = cause instanceof ApiError ? cause.body : undefined;
      setAuthError(body?.code === 'RATE_LIMITED' ? '尝试次数过多，请稍后再试。' : '密码不正确，或未通过来源校验。');
    } finally { setSigningIn(false); }
  }
  async function signOut() {
    try { await api.logout(); } catch { /* the cookie is cleared server-side even if the call races */ }
    setAuth('anonymous'); setData(null);
  }
  useEffect(() => {
    if (auth !== 'signed-in') return;
    let active = true; setLoading(true); setError(''); setData(null);
    const load = api[page]();
    void load.then(value => { if (active) setData(value); }).catch(cause => { if (active) setError(formatError(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, reload, auth]);
  async function run(path: string, body: Record<string, unknown>) {
    setError(''); setNotice('');
    try {
      const result = await api.command(path, body);
      setNotice(`命令已受理，当前结果：${result.status ? label(result.status) : '等待最新状态'}。追踪 ${result.correlationId}`);
      refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setNotice(`${cause.body.code}：旧版本未发送，已请求最新状态。请重新查看候选与权限。`);
        refresh();
      } else setError(formatError(cause));
      throw cause;
    }
  }
  const list = <T,>() => (data as { items: T[] } | null)?.items ?? [];
  if (auth !== 'signed-in') return <main className="page">
    <header className="topbar"><div><p className="eyebrow">管理端 · 仅本人可访问</p><h1>个人聊天代理</h1></div><span className="badge">未登录</span></header>
    {auth === 'checking'
      ? <p role="status">正在检查登录状态…</p>
      : <section className="card login-card"><h2>登录</h2>
        <p className="muted">请使用本人密码登录。连续失败会暂时限制尝试；会话可随时在服务端撤销。</p>
        <form onSubmit={event => { event.preventDefault(); void signIn(); }}>
          <label>密码<input type="password" autoComplete="current-password" value={password} disabled={signingIn} onChange={event => setPassword(event.target.value)} /></label>
          {authError && <p role="alert" className="error">{authError}</p>}
          <div className="actions"><button className="primary" type="submit" disabled={signingIn || !password}>{signingIn ? '登录中…' : '登录'}</button></div>
        </form>
      </section>}
  </main>;
  return <main className="page">
    <header className="topbar"><div><p className="eyebrow">管理端 · 以后端状态为准</p><h1>个人聊天代理</h1></div><div className="actions"><span className="badge">已登录</span><button onClick={() => void signOut()}>退出登录</button></div></header>
    <nav aria-label="管理页面" className="nav">{pages.map(item => <a key={item.id} href={`#${item.id}`} aria-current={page === item.id ? 'page' : undefined}>{item.label}</a>)}</nav>
    <div className="page-title"><h2>{pages.find(item => item.id === page)?.label}</h2><button onClick={refresh} disabled={loading}>刷新</button></div>
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {loading && <p role="status">正在读取后端状态…</p>}
    {!loading && !error && page === 'overview' && (() => { const row = data as Overview; return <section className="stack">
      <article className="card"><h3>运行状态</h3><p>全局：<strong>{row.globalPaused ? '已暂停' : '运行中'}</strong></p><p>待办 {row.pendingCount} · 结果未知 {row.unknownSendCount}</p>
        <div className="actions">{row.allowedActions.includes('pauseAll') && <button onClick={() => void run('/control/pause-all', { expectedVersion: row.version, idempotencyKey: key() }).catch(() => {})}>暂停全部代理</button>}
          {row.allowedActions.includes('resumeAll') && <button onClick={() => void run('/control/resume-all', { expectedVersion: row.version, idempotencyKey: key() }).catch(() => {})}>恢复全部代理</button>}</div></article>
      <article className="card"><h3>连接</h3>{row.connections.length ? row.connections.map(connection => <p key={connection.id}>{connection.platform}：{label(connection.state)}{connection.limitations?.length ? ` · 限制：${connection.limitations.join('、')}` : ''}</p>) : <p className="muted">暂无连接信息</p>}</article>
      <article className="card"><h3>故障</h3>{row.faults.length ? row.faults.map(fault => <p key={fault.id}>{fault.summary} · {label(fault.status)}</p>) : <p className="muted">暂无故障记录</p>}</article>
      <p className="muted">本页轮询或手动刷新不构成可靠后台通知。</p>
    </section>; })()}
    {!loading && !error && page === 'tasks' && <section className="stack">{list<Task>().length ? list<Task>().map(task => <TaskCard key={task.taskId} task={task} run={run} />) : <p className="empty">暂无待办</p>}</section>}
    {!loading && !error && page === 'contacts' && <section className="stack">{list<Contact>().map(row => <article className="card" key={row.id}><div className="card-head"><h3>{row.name}</h3><span className="badge">{label(row.status)}</span></div>
      <p>{row.platform} · {row.agentEnabled ? '代理开启' : '代理关闭'} · {row.sendMode}</p><p>目标：{row.goal}</p><p>关系：{row.relationshipStatus ?? '未配置'} · 风格：{row.stylePreference ?? '未配置'}</p>
      <p>主动联系：{row.activeContactEnabled ? '开启' : '关闭'} · 主动表白：{row.activeConfessionEnabled ? '开启' : '关闭'}</p>
      <p>允许时段：{row.allowedWindows?.join('、') || '未配置'} · 限制：{row.restrictions?.join('、') || '无'}</p><p className="muted">策略版本 {row.policyVersion} · 暂停原因 {row.pauseReasons?.join('、') || '无'}</p>
      {can(row, 'updatePolicy') && <div className="editor"><label>聊天目标<input value={drafts[row.id] ?? row.goal} onChange={event => setDrafts(old => ({ ...old, [row.id]: event.target.value }))} /></label><button onClick={() => void run(`/contacts/${encodeURIComponent(row.id)}/updatePolicy`, { expectedVersion: row.version, policy: { goal: drafts[row.id] ?? row.goal }, idempotencyKey: key() }).catch(() => {})}>保存目标</button></div>}
      <RowActions row={row} prefix="/contacts" run={(path, body) => run(path, body).catch(() => {})} actions={[{ name: 'pauseContact', title: '暂停联系人' }, { name: 'resumeContact', title: '恢复联系人', extra: { reason: row.pauseReasons?.[0] } }]} />
    </article>)}</section>}
    {!loading && !error && page === 'conversations' && <section className="stack">{list<Conversation>().map(row => <article className="card" key={row.id}><div className="card-head"><h3>{row.contactName}</h3><span className="badge">{label(row.status)}</span></div><p className="muted">修订 {row.revision} · generation {row.generation} · 暂停 {row.pauseReasons.join('、') || '无'}</p>
      {row.messages.map(message => <blockquote key={message.id}><small>{message.at} · {message.actor} · {message.type}</small><p>{message.text ?? '媒体内容请到媒体页面查看'}</p></blockquote>)}<h4>发送记录</h4><SendState sends={row.sends} /></article>)}</section>}
    {!loading && !error && page === 'facts' && <section className="stack">{list<Fact>().map(row => <article className="card" key={row.id}><h3>{row.content}</h3><p>范围 {row.scope} · 来源 {row.sourceKind} · {row.confirmed ? '已确认' : '未确认'}</p><p>更新 {row.updatedAt} · 有效期 {row.expiresAt ?? '未设置'}</p><p>证据 {row.evidenceRefs?.join('、') || '无'}</p>
      {can(row, 'correctFact') && <label>纠正内容<input value={drafts[row.id] ?? row.content} onChange={event => setDrafts(old => ({ ...old, [row.id]: event.target.value }))} /></label>}
      <div className="actions">{can(row, 'correctFact') && <button onClick={() => void run(`/facts/${encodeURIComponent(row.id)}/correctFact`, { expectedVersion: row.version, content: drafts[row.id] ?? row.content, idempotencyKey: key() }).catch(() => {})}>保存纠正</button>}</div>
      <RowActions row={row} prefix="/facts" run={(path, body) => run(path, body).catch(() => {})} actions={[{ name: 'confirmFact', title: '确认为事实' }, { name: 'deleteFact', title: '删除记忆' }]} /></article>)}</section>}
    {!loading && !error && page === 'analyses' && <section className="stack">{list<Analysis>().map(row => <article className="card" key={row.id}><h3>{row.contactName}</h3><p className="muted">分析 {row.analysisVersion} · 分类草案 {row.taxonomyVersion} · 截止 {row.cutoffAt} · 范围 {row.sampleRange}</p><p>状态：{label(row.status)}{row.invalidationReason ? ` · ${row.invalidationReason}` : ''}</p>
      {row.claims.map((claim, index) => <div className="subcard" key={index}><h4>{claim.label}：{claim.hypothesis}</h4><p>支持证据：{claim.supportingEvidence.join('、') || '无'}</p><p>反向证据：{claim.counterEvidence.join('、') || '无'}</p><p>替代解释：{claim.alternativeExplanation || '未提供'}</p><p>不确定性：{claim.uncertainty}</p></div>)}
      {can(row, 'correctAnalysis') && <label>纠正说明<textarea value={drafts[row.id] ?? ''} onChange={event => setDrafts(old => ({ ...old, [row.id]: event.target.value }))} /></label>}
      <div className="actions">{can(row, 'correctAnalysis') && <button onClick={() => void run(`/analyses/${encodeURIComponent(row.id)}/correctAnalysis`, { expectedVersion: row.version, correction: drafts[row.id] ?? '', idempotencyKey: key() }).catch(() => {})}>提交纠正</button>}</div>
    </article>)}</section>}
    {!loading && !error && page === 'media' && <section className="stack">{list<Media>().map(row => <article className="card" key={row.id}><h3>{row.kind} · {row.capturedAt}</h3><p>联系人 {row.contactId} · 状态 {label(row.status)}</p>
      {safeMediaUrl(row.previewUrl) ? <a href={safeMediaUrl(row.previewUrl)} target="_blank" rel="noreferrer">查看受控原始媒体</a> : <p className="muted">原始媒体地址未提供或不符合受控端点约定</p>}
      <p>识别：{row.recognition ?? '未识别'} · 不确定：{row.uncertainty ?? '未提供'}</p><p>来源：{row.source ?? '未提供'} · 可发送平台：{row.approvedPlatforms?.join('、') || '无'}</p>
      {can(row, 'correctRecognition') && <label>纠正识别<textarea value={drafts[row.id] ?? row.recognition ?? ''} onChange={event => setDrafts(old => ({ ...old, [row.id]: event.target.value }))} /></label>}
      <div className="actions">{can(row, 'correctRecognition') && <button onClick={() => void run(`/media/${encodeURIComponent(row.id)}/correctRecognition`, { expectedVersion: row.version, recognition: drafts[row.id] ?? row.recognition ?? '', idempotencyKey: key() }).catch(() => {})}>保存纠正</button>}</div>
      <RowActions row={row} prefix="/media" run={(path, body) => run(path, body).catch(() => {})} actions={[{ name: 'approveAsset', title: '批准素材' }, { name: 'revokeAsset', title: '撤销批准' }]} />
    </article>)}</section>}
    {!loading && !error && page === 'skills' && <section className="stack"><p className="muted">试用不发送；手动指定只作用于当前任务，不能改变长期授权。</p>{list<Skill>().map(row => <article className="card" key={row.id}><h3>{row.name} · v{row.skillVersion}</h3><p>{row.purpose}</p><p>来源 {row.source} · 启用联系人 {row.enabledContactIds.join('、') || '无'}</p><p>调用原因 {row.invocationReason ?? '无'} · 结果 {row.invocationStatus ?? '无'}</p>
      <RowActions row={row} prefix="/skills" run={(path, body) => run(path, body).catch(() => {})} actions={[{ name: 'trialSkill', title: '试用（不发送）' }, { name: 'disableSkill', title: '停用' }]} /></article>)}</section>}
    {!loading && !error && page === 'imports' && <section className="stack"><p className="muted">历史导入只进入预览与导入流程，不触发真实发送或主动联系。格式等待样本确认。</p>{list<ImportJob>().map(row => <article className="card" key={row.id}><h3>{row.filename}</h3><p>阶段 {row.phase} · {label(row.status)} · 消息 {row.messageCount ?? '未知'} · 重复 {row.duplicates ?? '未知'}</p><p>日期 {row.dateRange ?? '未知'} · 身份映射 {row.contactMappings?.join('、') || '未确认'}</p><p>解析异常 {row.anomalies?.join('、') || '无'}</p>
      <RowActions row={row} prefix="/imports" run={(path, body) => run(path, body).catch(() => {})} actions={[{ name: 'commitImport', title: '确认导入' }]} /></article>)}</section>}
    {!loading && !error && page === 'audit' && <section className="stack">{list<AuditEntry>().map(row => <article className="card" key={row.id}><h3>{row.action}</h3><p>{row.at} · 联系人 {row.contactId ?? '全局'}</p><p>{row.decisionSummary}</p><p>策略版本 {row.policyVersion ?? '无'} · 方案版本 {row.planVersion ?? '无'} · 发送 {row.sendStatus ? label(row.sendStatus) : '无'}</p><small>追踪 {row.correlationId}</small></article>)}</section>}
    {!loading && !error && page === 'faults' && <section className="stack">{list<Fault>().map(row => <article className="card" key={row.id}><h3>{row.summary}</h3><p>状态 {label(row.status)} · 发生 {row.occurredAt}</p><p>影响联系人 {row.affectedContactIds.join('、') || '未列出'} · 恢复 {row.recoveryState ?? '待核对'}</p><small>追踪 {row.correlationId}</small></article>)}</section>}
    {!loading && !error && page !== 'overview' && page !== 'tasks' && list<unknown>().length === 0 && <p className="empty">后端当前无记录。</p>}
  </main>;
}
export default App;
