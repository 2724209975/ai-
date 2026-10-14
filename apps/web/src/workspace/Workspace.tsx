import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Conversation, type WorkspaceList, type WorkspaceDetail, type CommandResult } from '../api';
import { requestKey } from '../browser-crypto';
import { label, reason, formatError, ContactAgentControl, ContactPolicyEditor } from '../controls';
import { CandidateEditor, draftKey, type DraftStore, type RunCommand } from './CandidateEditor';
import { MessageTimeline } from './MessageTimeline';
import { usePolling } from './usePolling';
import { MemoryPanel } from './MemoryPanel';
import {ReplyJobPanel} from './ReplyJobPanel';

type PendingCommand = { version?: 'v1'|'v2'; path: string; body: Record<string, unknown> };
export type WorkspaceState = { drafts: DraftStore; pending: Map<string, PendingCommand>; busy: Set<string> };
export function createWorkspaceState(): WorkspaceState { return { drafts: new Map(), pending: new Map(), busy: new Set() }; }
const platformName = (platform: string) => ({ qq: 'QQ', wechat: '微信', unknown: '平台待核对' }[platform] ?? platform);
const selectedFromHash = () => location.hash.startsWith('#chat/') ? decodeURIComponent(location.hash.slice(6)) : '';
const dateTime = (at?: number) => at ? new Date(at).toLocaleTimeString('zh-CN') : '尚未读取';

export function Workspace({ state }: { state: WorkspaceState }) {
  const [selected,setSelected] = useState(selectedFromHash);
  const selectionRef=useRef(selected); selectionRef.current=selected;
  const [search,setSearch] = useState(''), [platform,setPlatform] = useState('all'), [filter,setFilter] = useState('all');
  const [depth,setDepth] = useState(1), [revision,setRevision] = useState(0), [settings,setSettings] = useState(false);
  const [notice,setNotice] = useState(''), [commandError,setCommandError] = useState('');
  const [older,setOlder] = useState<{ id: string; messages: Conversation['messages']; cursor: string | null; loaded: boolean }>({ id: '', messages: [], cursor: null, loaded: false });
  const [loadingOlder,setLoadingOlder] = useState(false), [historyError,setHistoryError] = useState('');
  const historyController = useRef<AbortController | null>(null);
  useEffect(() => { const onHash=()=>setSelected(selectedFromHash()); addEventListener('hashchange',onHash); return ()=>removeEventListener('hashchange',onHash); }, []);
  useEffect(() => { setDepth(1); }, [search,platform,filter]);
  useEffect(() => {
    historyController.current?.abort(); setOlder({ id:selected,messages:[],cursor:null,loaded:false }); setLoadingOlder(false); setHistoryError(''); setSettings(false); setNotice(''); setCommandError('');
    return () => historyController.current?.abort();
  }, [selected]);
  const listIdentity = JSON.stringify([search,platform,filter]);
  const fetchList=useCallback(async (signal: AbortSignal): Promise<WorkspaceList> => {
    const items: WorkspaceList['items']=[]; let nextCursor: string|null='0', total=0; let runtime: WorkspaceList['runtime'], candidateOnly: boolean|undefined;
    for (let i=0;i<depth && nextCursor!==null;i++) {
      const page=await api.workspaceList(new URLSearchParams({ search,platform,filter,cursor:nextCursor,limit:'50' }),signal);
      runtime=page.runtime;candidateOnly=page.candidateOnly;items.push(...page.items); nextCursor=page.nextCursor; total=page.total;
    }
    return { items:[...new Map(items.map(item=>[item.id,item])).values()],nextCursor,total,runtime,candidateOnly };
  }, [search,platform,filter,depth]);
  const list=usePolling(listIdentity,fetchList,5000,revision);
  const fetchDetail=useCallback((signal: AbortSignal)=>api.workspaceDetail(selected,undefined,signal),[selected]);
  const detail=usePolling(selected,fetchDetail,3000,revision);
  function choose(id: string) { location.hash=id ? `chat/${encodeURIComponent(id)}` : 'chat'; setSelected(id); }
  const run: RunCommand = async (path,body,version) => {
    const scope=selected || 'global';
    if (state.busy.has(scope) || state.pending.has(scope)) throw new Error('COMMAND_PENDING');
    return execute(scope,{path,body,version});
  };
  async function execute(scope: string,command: PendingCommand): Promise<CommandResult> {
    state.busy.add(scope); state.pending.set(scope,command); setRevision(v=>v+1); setCommandError(''); setNotice('');
    try {
      const result=await api.command(command.path,command.body,command.version);
      state.pending.delete(scope);
      const remaining=result.remainingReasons ?? result.skipped?.flatMap(item=>item.reasons) ?? [];
      if ((selectionRef.current || 'global')===scope) setNotice(remaining.length ? `仍需处理：${[...new Set(remaining)].map(reason).join('、')}`
        : (command.path.endsWith('/confirm') || command.path.endsWith('/approve')) ? '回复已确认，正在等待逐条发送结果。' : label(result.status ?? '操作已完成'));
      return result;
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status===0 || cause.body.code==='INVALID_RESPONSE' || cause.status>=500 && !['SEND_RESULT_UNKNOWN','MODEL_UNAVAILABLE'].includes(cause.body.code))) {
        if ((selectionRef.current || 'global')===scope) setCommandError('操作结果尚未确认，正在查询最新状态。请勿重复发送；需要时可使用下方按钮重试同一请求。');
      } else {
        state.pending.delete(scope);
        if ((selectionRef.current || 'global')===scope) setCommandError(cause instanceof ApiError && cause.status===409 ? '状态已变化，旧版本未发送。已请求最新候选；编辑内容保留供复制。' : formatError(cause));
      }
      throw cause;
    } finally { state.busy.delete(scope); setRevision(v=>v+1); }
  }
  const pending=state.pending.get(selected || 'global');
  useEffect(() => {
    if (!detail.data || !pending || state.busy.has(selected)) return;
    const approval=/\/reply-jobs\/([^/]+)\/approve$/.exec(pending.path);
    if(approval&&detail.data.tasks.some(t=>t.replyJob?.id===decodeURIComponent(approval[1])&&t.replyJob.sends.length>0)){
      state.pending.delete(selected);setCommandError('');setNotice('已从后端核对确认结果。');setRevision(v=>v+1);return;
    }
    const match=/\/tasks\/([^/]+)\/(confirm|reject|regenerate)$/.exec(pending.path);
    if (!match) return;
    const task=detail.data.tasks.find(t=>t.taskId===decodeURIComponent(match[1]));
    if (task && (match[2]==='confirm' ? task.sends.length>0 : match[2]==='reject' ? task.status==='REJECTED' : task.status==='INVALIDATED')) {
      state.pending.delete(selected); setCommandError(''); setNotice('已从后端核对操作结果。'); setRevision(v=>v+1);
    }
  }, [detail.data,pending,selected,state]);
  const current=detail.data;
  const conversation=useMemo(()=>{
    if (!current) return;
    const merged=new Map((older.id===selected ? older.messages : []).map(m=>[m.id,m]));
    for (const m of current.conversation.messages) merged.set(m.id,m);
    return { ...current.conversation,messages:[...merged.values()].sort((a,b)=>a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) };
  }, [current,older,selected]);
  const activeTask=current?.tasks.find(t=>t.status==='AWAITING_CONFIRMATION') ?? current?.tasks.find(t=>t.allowedActions.length>0);
  const blocked=state.busy.has(selected) || state.pending.has(selected) || Boolean(detail.error);
  const cursor=older.id===selected && older.loaded ? older.cursor : current?.nextCursor;
  async function loadOlder() {
    if (!cursor || loadingOlder || !conversation) return;
    const id=selected, controller=new AbortController(); historyController.current=controller;
    setLoadingOlder(true); setHistoryError('');
    try {
      const page=await api.workspaceDetail(id,cursor,controller.signal);
      if (!controller.signal.aborted) setOlder({ id,messages:[...conversation.messages,...page.conversation.messages],cursor:page.nextCursor,loaded:true });
    } catch (cause) { if (!controller.signal.aborted) setHistoryError(formatError(cause)); }
    finally { if (!controller.signal.aborted) setLoadingOlder(false); }
  }
  const oldDrafts=[...state.drafts.entries()].filter(([key,draft])=>draft.conversationId===selected && draft.edited && key!==(activeTask ? draftKey(activeTask) : ''));
  async function contactCommand(action: string, extra: Record<string, unknown> = {}) {
    if (!current || blocked) return;
    try { await run(`/contacts/${encodeURIComponent(current.contact.id)}/${action}`, { expectedVersion: current.conversation.version,idempotencyKey:requestKey(),...extra }); } catch {}
  }
  return <section className={`workspace ${selected ? 'has-selection' : ''} ${settings ? 'settings-open' : ''}`} aria-label="聊天工作台">
    <aside className="conversation-list"><div className="list-heading"><h2>聊天</h2><span className="muted">{list.data?.total ?? '…'} 个会话</span></div>
      {list.data?.runtime && <RuntimeNotice runtime={list.data.runtime}/>}
      <label className="search-field"><span className="sr-only">搜索联系人</span><input placeholder="搜索联系人" value={search} onChange={e=>setSearch(e.target.value)} /></label>
      <div className="list-filters"><label><span className="sr-only">平台筛选</span><select value={platform} onChange={e=>setPlatform(e.target.value)}><option value="all">全部平台</option><option value="qq">QQ</option><option value="wechat">微信</option><option value="unknown">待核对平台</option></select></label><label><span className="sr-only">会话范围</span><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部</option><option value="pending">待确认</option><option value="attention">需处理</option></select></label></div>
      {Boolean(list.error) && <p className="error" role="alert">{formatError(list.error)}</p>}
      <div className="conversation-items">{list.data?.items.map(item=><button className={`conversation-item ${selected===item.id ? 'selected' : ''}`} key={item.id} onClick={()=>choose(item.id)} aria-pressed={selected===item.id}>
        <div className="contact-avatar">{Array.from(item.contactName)[0]}</div><div className="conversation-preview"><strong>{item.contactName}</strong><small>{platformName(item.platform)}{item.pendingCount>0 ? ` · ${item.pendingCount} 条待确认` : ''}{item.needsAttention ? ' · 需处理' : ''}</small><p>{item.preview}</p></div>
      </button>)}{list.data?.items.length===0 && <p className="empty">没有符合条件的会话</p>}{!list.data && !list.error && <p className="muted">正在读取会话…</p>}</div>
      {list.data?.nextCursor && <button className="history-button" onClick={()=>setDepth(v=>v+1)}>加载更多会话</button>}
      <small className="sync-time">更新于 {dateTime(list.at)}</small>
    </aside>
    <div className="chat-panel">{!selected ? <div className="workspace-welcome"><div className="welcome-mark">聊</div><h2>选择一个会话，开始处理回复</h2><p>查看聊天和记忆，编辑候选后复制回复。</p></div>
      : <><header className="chat-heading"><button className="mobile-back" onClick={()=>choose('')}>← 返回</button><div><h2>{current?.contact.name ?? '正在读取聊天…'}</h2><small>{current ? platformName(current.contact.platform) : ''} · 更新于 {dateTime(detail.at)}</small></div><button aria-label="刷新" onClick={()=>setRevision(v=>v+1)}>↻</button><button aria-expanded={settings} onClick={()=>setSettings(v=>!v)}>聊天设置</button></header>
      {Boolean(detail.error) && <p className="error" role="alert">{formatError(detail.error)} 数据可能已过期，操作暂不可用。</p>}
      {notice && <p className="notice" role="status">{notice}</p>}{commandError && <p className="error" role="alert">{commandError}</p>}
      {pending && !state.busy.has(selected) && <div className="actions"><button onClick={()=>setRevision(v=>v+1)}>核对最新状态</button><button onClick={()=>void execute(selected,pending).catch(()=>{})}>重试同一请求</button></div>}
      {current && conversation && <>
        <RecoveryNotice current={current} blocked={blocked} command={contactCommand} run={run} />
        {historyError && <p className="error" role="alert">{historyError}</p>}
        <MessageTimeline conversation={conversation} loadOlder={()=>void loadOlder()} hasOlder={Boolean(cursor)} loadingOlder={loadingOlder} run={run} blocked={blocked} />
        <ReplyJobPanel key={current.conversation.id} id={current.conversation.id} run={run} blocked={blocked}/><div className="composer-wrap">{activeTask ? <CandidateEditor key={draftKey(activeTask)} task={activeTask} drafts={state.drafts} run={run} blocked={blocked} />
          : <p className="composer-empty">{conversation.status==='GENERATING' || conversation.status==='COLLECTING' ? '正在生成候选，请稍候…' : conversation.sends.some(s=>['CREATED','SUBMITTING'].includes(s.status)) ? '回复已确认，等待发送结果…' : '当前没有待确认的回复'}</p>}
          {oldDrafts.length>0 && <details className="saved-drafts"><summary>保留的编辑内容（{oldDrafts.length}）</summary><p className="muted">旧方案不能直接发送，可以复制到最新候选中。</p>{oldDrafts.map(([key,draft])=><textarea key={key} aria-label="旧方案编辑内容" readOnly value={draft.parts.join('\n')} />)}</details>}
          {current.tasks.some(t=>t.taskId!==activeTask?.taskId) && <details><summary>历史候选</summary>{current.tasks.filter(t=>t.taskId!==activeTask?.taskId).map(task=><article className="subcard" key={task.taskId}><p>{label(task.status)}{task.invalidationReason ? ` · ${task.invalidationReason}` : ''}</p>{task.alternatives.map(a=><p key={a.alternativeId}>{a.parts.map(p=>p.content).join(' / ')}</p>)}</article>)}</details>}
        </div>
      </>}
    </> }</div>
    {settings && current && <aside className="chat-settings"><div className="card-head"><h3>聊天设置</h3><button onClick={()=>setSettings(false)}>关闭</button></div><p>{current.contact.name} · {platformName(current.contact.platform)}</p>{!current.candidateOnly && <fieldset disabled={blocked}><ContactAgentControl row={current.contact} run={async (path,body)=>{ await run(path,body); }} />{!current.candidateOnly && <ContactPolicyEditor row={current.contact} run={async (path,body)=>{ await run(path,body); }} />} </fieldset>}<p><a href={current.candidateOnly?"#models":`#models/${encodeURIComponent(current.contact.id)}`}>打开模型配置 →</a></p><MemoryPanel key={current.conversation.id} id={current.conversation.id}/><details><summary>状态详情</summary><p>状态：{label(current.conversation.status)}</p><p>{current.conversation.pauseReasons.map(reason).join('、') || '无联系人暂停'}</p><small>会话版本 {current.conversation.version} · 策略版本 {current.contact.policyVersion}</small></details></aside>}
  </section>;
}

function RecoveryNotice({ current,blocked,command,run }: { current: WorkspaceDetail; blocked: boolean; command: (action:string,extra?:Record<string,unknown>)=>Promise<void>; run: RunCommand }) {
  const row=current.conversation;
  const special=row.pauseReasons.filter(r=>!['OWNER_PAUSE','OWNER_ORIGIN','OWNER_ORIGIN_UNMAPPED','AWAITING_MANUAL_RESUME','GLOBAL_PAUSE','ACCOUNT_FAULT','UNKNOWN_SEND'].includes(r));
  return <div className="recovery-notice">
    {(row.globalPaused || row.pauseReasons.length>0) && <div className="warning"><p>{row.globalPaused ? '全部代理已暂停，恢复全部后才可继续处理聊天。' : `聊天已暂停：${row.pauseReasons.map(reason).join('、')}`}</p>
      {row.globalPaused && row.globalVersion !== undefined && <button disabled={blocked} onClick={()=>void run('/control/resume-all',{expectedVersion:row.globalVersion,idempotencyKey:requestKey()}).catch(()=>{})}>恢复全部代理</button>}
      {row.allowedActions.includes('resumeRoutine') && <button disabled={blocked} onClick={()=>void command('resumeRoutine')}>一键恢复</button>}
      {special.length>0 && <details><summary>处理其他暂停原因</summary>{special.map(r=><div key={r}><p>{reason(r)}。请核对并处理后再恢复。</p><button disabled={blocked} onClick={()=>void command('resumeContact',{reason:r})}>已处理，清除这项暂停</button></div>)}</details>}
    </div>}
    {!current.contact.agentEnabled && <p className="muted">此联系人代理已关闭，可以在聊天设置中开启。</p>}
    {!!row.unreviewedPausedInboundCount && <div className="inbound-reminder"><span>暂停期间有 {row.unreviewedPausedInboundCount} 条来信待查看</span>
      {row.allowedActions.includes('requestPausedReply') && <button disabled={blocked} onClick={()=>void command('requestPausedReply')}>为最新来信生成候选</button>}
      {row.allowedActions.includes('acknowledgePausedInbound') && <button disabled={blocked} onClick={()=>void command('acknowledgePausedInbound')}>已核对，清除提醒</button>}
    </div>}
    {row.allowedActions.includes('pauseContact') && <button className="quiet-button" disabled={blocked} onClick={()=>void command('pauseContact')}>暂停此聊天</button>}
  </div>;
}

function RuntimeNotice({runtime:r}:{runtime:NonNullable<WorkspaceList['runtime']>}) {
  const status=r.budget.halted?'费用尚未结清，已停止模型调用':r.status==='budget_exhausted'?'额度已用完，已保留现有候选':r.connected?'QQ 已连接':'QQ 断开，正在重连';
  return <div className="trial-runtime" role="status"><strong>{status}</strong><small>仅生成建议 · 自动发送关闭</small>{!r.connected&&<small>工作台和手机资料同步仍可使用。请检查 QQ 客户端登录；核对账号和联系人后会自动恢复接收。</small>}<small>电脑剩余额度约 {Math.max(0,r.budget.limitCny-r.budget.accountedCny-(r.phoneAllocatedCny??0)).toFixed(2)} 元 · <a href="#link">查看费用</a></small><small>{r.imageEnabled?'图片理解已启用':'图片理解未启用'} · 断线期间的消息可能需要重新同步</small></div>;
}
