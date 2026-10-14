import { useLayoutEffect, useRef, useState } from 'react';
import type { Conversation, SendTask } from '../api';
import { label } from '../controls';
import type { RunCommand } from './CandidateEditor';
import { requestKey } from '../browser-crypto';

const time = (at: string) => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function SendBubble({ send, run, blocked }: { send: SendTask; run: RunCommand; blocked: boolean }) {
  const [busy,setBusy] = useState(false), [evidence,setEvidence] = useState('本人核对');
  async function resolve(status: string, resume = false) {
    if (busy || blocked || !send.version) return;
    setBusy(true);
    try { await run(`/sends/${encodeURIComponent(send.sendTaskId)}/resolve`, { expectedVersion: send.version, idempotencyKey: requestKey(), status, evidenceRef: evidence.trim() || '本人核对', ...(resume ? { resume: true } : {}) }); }
    catch { /* Workspace retains errors and uncertain commands. */ } finally { setBusy(false); }
  }
  return <article className="message-bubble outgoing send-bubble"><p>{send.content ?? `第 ${send.sequence} 条回复`}</p>
    <small>{send.at ? `${time(send.at)} · ` : ''}{label(send.status)}</small>
    {send.status === 'RESULT_UNKNOWN' && <div className="send-resolution"><p>请先在原聊天中核对这条回复。</p>
      <button className="primary" disabled={blocked || busy || !send.version} onClick={() => void resolve('DELIVERED',true)}>已收到，恢复聊天</button>
      <details><summary>其他核对选项</summary><label>核对说明<input value={evidence} disabled={busy || blocked} maxLength={120} onChange={e=>setEvidence(e.target.value)} /></label><div className="actions"><button disabled={blocked || busy || !send.version} onClick={()=>void resolve('DELIVERED')}>只记已送达</button><button disabled={blocked || busy || !send.version} onClick={()=>void resolve('FAILED_DEFINITE')}>记明确失败</button></div></details>
    </div>}
    <details><summary>发送详情</summary><small>第 {send.sequence} 条 · {send.receiptLevel ?? '暂无回执'} · {send.correlationId}</small></details>
  </article>;
}

export function MessageTimeline({ conversation, loadOlder, hasOlder, loadingOlder, run, blocked }: { conversation: Conversation; loadOlder: () => void; hasOlder: boolean; loadingOlder: boolean; run: RunCommand; blocked: boolean }) {
  const viewport = useRef<HTMLDivElement>(null), previous = useRef<{ first?: string; last?: string; height: number; top: number; bottom: boolean } | undefined>(undefined);
  const [newMessages,setNewMessages] = useState(false);
  const messages = conversation.messages;
  // Replace only a proven agent echo with its ledger bubble. Text equality cannot prove an echo.
  const echoes = new Map(messages.filter(m=>m.actor==='agent' && m.platformMessageId).map(m=>[m.platformMessageId,m]));
  const matched = new Set(conversation.sends.map(s=>s.platformMessageId).filter(id=>id && echoes.has(id)));
  const events = [
    ...messages.filter(m=>!(m.actor==='agent' && m.platformMessageId && matched.has(m.platformMessageId))).map(message=>({ id:`message:${message.id}`,at:message.at,message,send:undefined })),
    ...conversation.sends.map(send=>({ id:`send:${send.sendTaskId}`,at:(send.platformMessageId && echoes.get(send.platformMessageId)?.at) || send.at || '9999',message:undefined,send })),
  ].sort((a,b)=>a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const first = events[0]?.id, last = events.at(-1)?.id;
  useLayoutEffect(() => {
    const element=viewport.current;
    if (!element) return;
    const old=previous.current;
    if (!old || old.bottom) { element.scrollTop=element.scrollHeight; setNewMessages(false); }
    else if (first !== old.first && last === old.last) element.scrollTop=old.top+element.scrollHeight-old.height;
    else { element.scrollTop=old.top; if (last !== old.last) setNewMessages(true); }
    previous.current={ first,last,height:element.scrollHeight,top:element.scrollTop,bottom:element.scrollHeight-element.scrollTop-element.clientHeight<80 };
  }, [conversation]);
  return <div className="timeline-wrap"><div className="message-timeline" ref={viewport} onScroll={() => {
    const element=viewport.current; if (element) previous.current={ first,last,height:element.scrollHeight,top:element.scrollTop,bottom:element.scrollHeight-element.scrollTop-element.clientHeight<80 };
  }}>
    {hasOlder && <button className="history-button" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder ? '正在加载…' : '加载更早消息'}</button>}
    {!messages.length && <p className="empty">暂无聊天记录</p>}
    {events.map(event => event.send ? <SendBubble key={event.id} send={event.send} run={run} blocked={blocked} /> : event.message && <article className={`message-bubble ${['owner','agent'].includes(event.message.actor) ? 'outgoing' : 'incoming'}`} key={event.id}>
      {(() => { const message=event.message; return <>
      <small>{message.actor === 'contact' ? conversation.contactName : message.actor === 'unknown' ? '自身账号 · 来源待核对' : message.actor === 'owner' ? '本人' : message.actor === 'agent' ? '代理' : '系统'} · {time(message.at)}</small>
      <p>{message.text ?? ({ image:'[图片]',voice:'[语音]',sticker:'[表情]' }[message.type] ?? `[${message.type}]`)}</p>
      {message.actor === 'unknown' && <details><summary>来源详情</summary><small>{message.originEvidenceRefs?.join('、') || '未提供核对证据'}</small></details>}
      </>; })()}
    </article>)}
  </div>{newMessages && <button className="new-message-hint" onClick={()=>{ const element=viewport.current; if (element) element.scrollTop=element.scrollHeight; setNewMessages(false); }}>有新消息，点击查看 ↓</button>}</div>;
}
