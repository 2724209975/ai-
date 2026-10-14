import {ModelUsageSummary} from './workspace/ModelUsageSummary';
import {ModelSettingsPage} from './workspace/ModelSettingsPage';
import { MobileLink } from './MobileLink';
import {PeoplePage} from './PeoplePage';
import {projectRelease} from '../../../packages/infrastructure/release.mts';
import { useCallback, useEffect, useState } from 'react';
import { requestKey as key } from './browser-crypto';
import { api, ApiError, type Analysis, type Fact, type Fault, type ImportJob, type Media, type Overview, type Skill, type AuditEntry } from './api';

type Page = 'people' | 'models' | 'link' | 'chat' | 'more' | 'overview' | 'contacts' | 'conversations' | 'tasks' | 'facts' | 'analyses' | 'media' | 'skills' | 'imports' | 'audit' | 'faults';
const pages: { id: Page; label: string }[] = [
  {id:'people',label:'人物与导入'},
  { id: 'models', label: '模型配置' }, { id: 'link', label: '手机联动' }, { id: 'chat', label: '聊天' }, { id: 'more', label: '更多' },
  { id: 'overview', label: '运行状态' }, { id: 'tasks', label: '待办' }, { id: 'contacts', label: '联系人' },
  { id: 'conversations', label: '会话' }, { id: 'facts', label: '资料记忆' }, { id: 'analyses', label: '分析证据' },
  { id: 'media', label: '媒体素材' }, { id: 'skills', label: 'Skill' }, { id: 'imports', label: '导入' },
  { id: 'audit', label: '审计' }, { id: 'faults', label: '故障' },
];
import { label, reason, can, formatError, safeMediaUrl, RowActions } from './controls';
import { Workspace, createWorkspaceState } from './workspace/Workspace';
function App() {
  const routePage = () => {
    const target = location.hash.slice(1).split('/')[0] as Page;
    return ['tasks','contacts','conversations'].includes(target) ? 'chat' : target;
  };
  const initial = routePage();
  const [page, setPage] = useState<Page>(pages.some(item => item.id === initial) ? initial : 'chat');
  /** Tagged with the page it belongs to: a hash change renders the new page before its fetch
   * resolves, and stale data from the previous page must never be rendered as the new one. */
  const [workspaceState, setWorkspaceState] = useState(createWorkspaceState);
  const [data, setData] = useState<{ page: Page; value: unknown } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [auth, setAuth] = useState<'checking' | 'anonymous' | 'signed-in'>('checking');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [serverVersion,setServerVersion]=useState('');
  useEffect(()=>{if(auth!=='signed-in')return;let active=true;void fetch('/api/v1/project-version',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(value=>{if(active&&value?.desktopVersion)setServerVersion(value.desktopVersion);}).catch(()=>{});return()=>{active=false;};},[auth]);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  useEffect(() => {
    const onHash = () => { const target = routePage(); if (pages.some(item => item.id === target)) setPage(target); };
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
  function clearSession() { setAuth('anonymous'); setData(null); setDrafts({}); setWorkspaceState(createWorkspaceState()); }
  useEffect(() => { addEventListener('owner-session-expired',clearSession); return () => removeEventListener('owner-session-expired',clearSession); }, []);
  async function signOut() {
    try { await api.logout(); } catch { /* the cookie is cleared server-side even if the call races */ }
    clearSession();
  }
  useEffect(() => {
    if (auth !== 'signed-in' || page === 'people' || page === 'chat' || page === 'more' || page === 'link' || page === 'models') { setLoading(false); return; }
    let active = true;
    let inFlight = false;
    setLoading(data?.page !== page);
    setError('');
    const load = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const value = await api[page]();
        if (active) { setData({ page, value }); setError(''); }
      } catch (cause) {
        if (active) setError(formatError(cause));
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    void load();
    const onVisible = () => { if (!document.hidden) void load(); };
    if (page === 'tasks' || page === 'overview') document.addEventListener('visibilitychange', onVisible);
    const interval = page === 'tasks' || page === 'overview' ? setInterval(() => { void load(); }, 5_000) : undefined;
    return () => {
      active = false;
      if (interval) clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [page, reload, auth]);
  async function run(path: string, body: Record<string, unknown>) {
    setError(''); setNotice('');
    try {
      const result = await api.command(path, body);
      setNotice(result.skipped?.length ? `恢复 ${result.restored?.length ?? 0} 个联系人，${result.skipped.length} 个仍需处理：${[...new Set(result.skipped.flatMap(item=>item.reasons))].map(reason).join('、')}` : `操作已完成：${result.status ? label(result.status) : '等待最新状态'}`);
      refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setNotice(cause.body.code === 'STALE_PLAN' || path.endsWith('/confirm')
          ? `${cause.body.code}：旧版本未发送，已请求最新状态。请重新查看候选与权限。`
          : `${cause.body.code}：状态已变化，已请求最新状态。请重新查看后端权限。`);
        refresh();
      } else if (cause instanceof ApiError && cause.status === 503 && cause.body.code === 'SEND_RESULT_UNKNOWN') {
        setError(formatError(cause));
        refresh();
      } else setError(formatError(cause));
      throw cause;
    }
  }
  const current = data?.page === page ? data.value : null;
  const showContent = !loading && (!error || current !== null);
  const list = <T,>() => (current as { items: T[] } | null)?.items ?? [];
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
  return <main className={`page ${page === 'chat' ? 'workspace-page' : ''}`}>
    <header className="topbar"><div><p className="eyebrow">聊天工作台</p><h1>个人聊天代理</h1><small>电脑 {projectRelease.desktopVersion} · 手机推荐 {projectRelease.androidVersion}{serverVersion&&serverVersion!==projectRelease.desktopVersion?' · 请刷新页面以匹配运行版本':''}</small></div><div className="actions"><span className="badge">已登录</span><button onClick={() => void signOut()}>退出登录</button></div></header>
    <nav aria-label="管理页面" className="nav">{pages.filter(item => ['chat','people','models','overview','more'].includes(item.id)).sort((a,b) => ['chat','people','models','overview','more'].indexOf(a.id)-['chat','people','models','overview','more'].indexOf(b.id)).map(item => <a key={item.id} href={`#${item.id}`} aria-current={page === item.id ? 'page' : undefined}>{item.label}</a>)}</nav>
    {page !== 'chat' && <div className="page-title"><h2>{pages.find(item => item.id === page)?.label}</h2><button onClick={refresh} disabled={loading}>刷新</button></div>}
    {page === 'models' && <ModelSettingsPage refreshVersion={reload}/>}
    {page === 'people' && <PeoplePage refreshVersion={reload}/>}
    {page === 'link' && <MobileLink refreshVersion={reload}/>}
    {page === 'chat' && <Workspace state={workspaceState} />}
    {page === 'more' && <section className="more-grid">{pages.filter(item => ['people','link','facts','analyses','media','audit'].includes(item.id)).map(item => <a className="card" key={item.id} href={`#${item.id}`}>{item.label}<span>查看与管理 →</span></a>)}</section>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {loading && <p role="status">正在读取后端状态…</p>}
    {showContent && page === 'overview' && (() => { const row = current as Overview | null; if (!row) return null; return <section className="stack">
      <article className="card"><h3>运行状态</h3><p>全局调度：<strong>{row.globalPaused ? '已暂停' : '未暂停'}</strong></p><p>待办 {row.pendingCount} · 结果未知 {row.unknownSendCount}</p>
        {row.unknownSendCount > 0 && <p role="alert" className="warning">存在结果未知的发送。须核对平台回执，不能盲目重发。</p>}
        <div className="actions">{row.allowedActions.includes('pauseAll') && <button onClick={() => void run('/control/pause-all', { expectedVersion: row.version, idempotencyKey: key() }).catch(() => {})}>暂停全部代理</button>}
          {row.allowedActions.includes('resumeAll') && <button onClick={() => void run('/control/resume-all', { expectedVersion: row.version, idempotencyKey: key() }).catch(() => {})}>恢复全部代理</button>}</div></article>
      <ModelUsageSummary refreshVersion={reload}/><article className="card"><h3>账号连接与恢复</h3>{row.connections.length ? row.connections.map((connection, index) => <div className="subcard" key={connection.accountId ?? connection.id ?? index}>
        <p><strong>{connection.platform}：{label(connection.connectionState ?? connection.state ?? '未知')}</strong></p>
        <p>最近探测：{connection.lastReconciledAt ? new Date(connection.lastReconciledAt).toLocaleString('zh-CN') : '尚无探测记录'}</p>
        <p>下一步：{connection.connectionState === 'probe_healthy' ? '可以查看当前聊天；若仍有人工暂停，点击一键恢复。' : connection.connectionState === 'disconnected' ? '检查对应平台客户端、桥接和登录状态，探测正常后再恢复。' : '检查对应桥接是否启动，等待新的健康探测；当前状态无法确认。'}</p>
        {connection.recovery && <p>恢复状态：{label(connection.recovery.status)} · 历史覆盖：{connection.recovery.historyComplete ? '已证实连续' : '未证实连续'} · 未决发送 {connection.recovery.unresolvedSendCount ?? '未提供'}</p>}
        {!!connection.recovery?.gaps?.length && <p className="warning">同步缺口：{connection.recovery.gaps.join('、')}</p>}
        {!!connection.limitations?.length && <p>限制：{connection.limitations.join('、')}</p>}
      </div>) : <p className="warning">{row.connectionQueryStatus === 'ready' ? '当前没有已登记账号；不能推断微信或 QQ 已连接。' : '连接与恢复查询尚未接入；无法判断账号是否在线或历史是否补齐。'}</p>}</article>
      <article className="card"><h3>故障</h3>{row.faults.length ? row.faults.map(fault => <p key={fault.id}>{fault.summary} · {fault.status === 'ACTIVE' ? '仍需处理' : fault.status === 'RECOVERED_AWAITING_OWNER' ? '探测曾恢复，等待本人处理' : label(fault.status)}</p>) : <p className="warning">{row.faultQueryStatus === 'ready' ? '当前查询范围内没有故障记录。' : '故障汇总查询尚未接入；不能判断系统无故障。'}</p>}</article>
      <p className="muted">本页轮询或手动刷新不构成可靠后台通知。</p>
    </section>; })()}
    {showContent && page === 'facts' && <section className="stack">{list<Fact>().map(row => <article className="card" key={row.id}><h3>{row.content}</h3><p>范围 {row.scope} · 来源 {row.sourceKind} · {row.confirmed ? '已确认' : '未确认'}</p><p>更新 {row.updatedAt} · 有效期 {row.expiresAt ?? '未设置'}</p><p>证据 {row.evidenceRefs?.join('、') || '无'}</p>
      {can(row, 'correctFact') && <label>纠正内容<input value={drafts[row.id] ?? row.content} onChange={event => setDrafts(old => ({ ...old, [row.id]: event.target.value }))} /></label>}
      <div className="actions">{can(row, 'correctFact') && <button onClick={() => void run(`/facts/${encodeURIComponent(row.id)}/correctFact`, { expectedVersion: row.version, content: drafts[row.id] ?? row.content, idempotencyKey: key() }).catch(() => {})}>保存纠正</button>}</div>
      <RowActions row={row} prefix="/facts" run={(path, body) => run(path, body).catch(() => {})} actions={[{ name: 'confirmFact', title: '确认为事实' }, { name: 'deleteFact', title: '删除记忆' }]} /></article>)}</section>}
    {showContent && page === 'analyses' && <section className="stack">{list<Analysis>().map(row => <article className="card" key={row.id}><h3>{row.contactName}</h3><p className="muted">分析 {row.analysisVersion} · 分类草案 {row.taxonomyVersion} · 截止 {row.cutoffAt} · 范围 {row.sampleRange}</p><p>状态：{label(row.status)}{row.invalidationReason ? ` · ${row.invalidationReason}` : ''}</p>
      {row.claims.map((claim, index) => <div className="subcard" key={index}><h4>{claim.label}：{claim.hypothesis}</h4><p>支持证据：{claim.supportingEvidence.join('、') || '无'}</p><p>反向证据：{claim.counterEvidence.join('、') || '无'}</p><p>替代解释：{claim.alternativeExplanation || '未提供'}</p><p>不确定性：{claim.uncertainty}</p></div>)}
      {can(row, 'correctAnalysis') && <label>纠正说明<textarea value={drafts[row.id] ?? ''} onChange={event => setDrafts(old => ({ ...old, [row.id]: event.target.value }))} /></label>}
      <div className="actions">{can(row, 'correctAnalysis') && <button onClick={() => void run(`/analyses/${encodeURIComponent(row.id)}/correctAnalysis`, { expectedVersion: row.version, correction: drafts[row.id] ?? '', idempotencyKey: key() }).catch(() => {})}>提交纠正</button>}</div>
    </article>)}</section>}
    {showContent && page === 'media' && <section className="stack">{list<Media>().map(row => <article className="card" key={row.id}><h3>{row.kind} · {row.capturedAt}</h3><p>联系人 {row.contactId} · 状态 {label(row.status)}</p>
      {safeMediaUrl(row.previewUrl) ? <a href={safeMediaUrl(row.previewUrl)} target="_blank" rel="noreferrer">查看受控原始媒体</a> : <p className="muted">原始媒体地址未提供或不符合受控端点约定</p>}
      <p>识别：{row.recognition ?? '未识别'} · 不确定：{row.uncertainty ?? '未提供'}</p><p>来源：{row.source ?? '未提供'} · 可发送平台：{row.approvedPlatforms?.join('、') || '无'}</p>
      {can(row, 'correctRecognition') && <label>纠正识别<textarea value={drafts[row.id] ?? row.recognition ?? ''} onChange={event => setDrafts(old => ({ ...old, [row.id]: event.target.value }))} /></label>}
      <div className="actions">{can(row, 'correctRecognition') && <button onClick={() => void run(`/media/${encodeURIComponent(row.id)}/correctRecognition`, { expectedVersion: row.version, recognition: drafts[row.id] ?? row.recognition ?? '', idempotencyKey: key() }).catch(() => {})}>保存纠正</button>}</div>
      <RowActions row={row} prefix="/media" run={(path, body) => run(path, body).catch(() => {})} actions={[{ name: 'approveAsset', title: '批准素材' }, { name: 'revokeAsset', title: '撤销批准' }]} />
    </article>)}</section>}
    {showContent && page === 'skills' && <section className="stack"><p className="muted">试用不发送；手动指定只作用于当前任务，不能改变长期授权。</p>{list<Skill>().map(row => <article className="card" key={row.id}><h3>{row.name} · v{row.skillVersion}</h3><p>{row.purpose}</p><p>来源 {row.source} · 启用联系人 {row.enabledContactIds.join('、') || '无'}</p><p>调用原因 {row.invocationReason ?? '无'} · 结果 {row.invocationStatus ?? '无'}</p>
      <RowActions row={row} prefix="/skills" run={(path, body) => run(path, body).catch(() => {})} actions={[{ name: 'trialSkill', title: '试用（不发送）' }, { name: 'disableSkill', title: '停用' }]} /></article>)}</section>}
    {showContent && page === 'imports' && <section className="stack"><p className="muted">历史导入只进入预览与导入流程，不触发真实发送或主动联系。格式等待样本确认。</p>{list<ImportJob>().map(row => <article className="card" key={row.id}><h3>{row.filename}</h3><p>阶段 {row.phase} · {label(row.status)} · 消息 {row.messageCount ?? '未知'} · 重复 {row.duplicates ?? '未知'}</p><p>日期 {row.dateRange ?? '未知'} · 身份映射 {row.contactMappings?.join('、') || '未确认'}</p><p>解析异常 {row.anomalies?.join('、') || '无'}</p>
      <RowActions row={row} prefix="/imports" run={(path, body) => run(path, body).catch(() => {})} actions={[{ name: 'commitImport', title: '确认导入' }]} /></article>)}</section>}
    {showContent && page === 'audit' && <section className="stack">{list<AuditEntry>().map(row => <article className="card" key={row.id}><h3>{row.action}</h3><p>{row.at} · 联系人 {row.contactId ?? '全局'}</p><p>{row.decisionSummary}</p><p>策略版本 {row.policyVersion ?? '无'} · 方案版本 {row.planVersion ?? '无'} · 发送 {row.sendStatus ? label(row.sendStatus) : '无'}</p><small>追踪 {row.correlationId}</small></article>)}</section>}
    {showContent && page === 'faults' && <section className="stack">{list<Fault>().map(row => <article className="card" key={row.id}><h3>{row.summary}</h3><p>状态 {label(row.status)} · 发生 {row.occurredAt}</p><p>影响联系人 {row.affectedContactIds.join('、') || '未列出'} · 恢复 {row.recoveryState ?? '待核对'}</p><small>追踪 {row.correlationId}</small></article>)}</section>}
    {showContent && !['chat','people','models','more','overview','link'].includes(page) && list<unknown>().length === 0 && <p className="empty">后端当前无记录。</p>}
  </main>;
}
export default App;
