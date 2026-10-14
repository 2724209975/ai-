import { useState,useCallback } from 'react';
import { request,ApiError } from '../api';
import { requestKey } from '../browser-crypto';
import { formatError } from '../controls';
import { usePolling } from './usePolling';
import type { MemoryView,RelationshipV2,StyleV2,ContextPackageV2 } from '../../../../packages/contracts/context-memory-v2.mts';
type State={items:MemoryView[];relationship:RelationshipV2;personalStyle:StyleV2;controls:{version:number;enabled:boolean;styleSamples:boolean;retentionDays:number};pipeline:{pipelineVersion:number;conversationVersion:number;contactId:string;factScopes:string[]}};
const names:Record<string,string>={fact:'事实',preference:'偏好',boundary:'边界',episode:'经历',promise:'承诺',relationship_event:'关系事件',temporary_state:'临时状态',pending:'待确认',active:'有效',superseded:'已替代',expired:'已失效',deleted:'已删除'};
export function MemoryPanel({id}:{id:string}){
  const base=`/conversations/${encodeURIComponent(id)}`;
  const [revision,setRevision]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState<{path:string;body:Record<string,unknown>;version?:'v1'|'v2'}|null>(null);
  const [editing,setEditing]=useState<MemoryView|null>(null),[content,setContent]=useState(''),[object,setObject]=useState('');
  const [newContent,setNewContent]=useState(''),[style,setStyle]=useState(''),[global,setGlobal]=useState(false);
  const [styleLocked,setStyleLocked]=useState(true);
  const [subject,setSubject]=useState('contact');
  const [purpose,setPurpose]=useState('manual_note');
  const [search,setSearch]=useState(''),[statusFilter,setStatusFilter]=useState('all'),[memoryType,setMemoryType]=useState('fact');
  const [preview,setPreview]=useState<{context:ContextPackageV2|null;status:string}|null>(null);
  const fetchState=useCallback(async(signal:AbortSignal)=>{
    const [memory,pipeline]=await Promise.all([request<Omit<State,'pipeline'>>(`${base}/memories`,{signal},'v2'),request<State['pipeline']>(`${base}/reply-jobs`,{signal},'v2')]);return {...memory,pipeline};
  },[base]);
  const data=usePolling(id,fetchState,10_000,revision),state=data.data;
  async function execute(cmd:{path:string;body:Record<string,unknown>;version?:'v1'|'v2'}){
    setBusy(true);setPending(cmd);setError('');
    try{await request(cmd.path,{method:'POST',body:JSON.stringify(cmd.body)},cmd.version??'v2');setPending(null);setEditing(null);setRevision(v=>v+1);setPreview(null);}
    catch(e){setError(formatError(e));if(e instanceof ApiError&&!e.body.retryable&&e.status!==0)setPending(null);}
    finally{setBusy(false);}
  }
  const run=(path:string,body:Record<string,unknown>,version:'v1'|'v2'='v2')=>execute({path,body:{...body,idempotencyKey:requestKey()},version});
  const blocked=busy||!!pending||!!data.error||!state;
  return <section aria-label="联系人记忆"><h3>聊天记忆</h3>
    <p className="muted">待确认内容不会作为事实使用。设置或记忆修改后，已有候选可能需要重新生成。</p>
    {Boolean(data.error)&&<p role="alert" className="error">{formatError(data.error)}</p>}{error&&<p role="alert" className="error">{error}</p>}
    {pending&&!busy&&<button onClick={()=>void execute(pending)}>重试同一请求</button>}
    {state&&<fieldset disabled={blocked}>
      <label><input type="checkbox" checked={state.pipeline.pipelineVersion===2} onChange={e=>void run(`${base}/pipeline`,{version:e.target.checked?2:1,expectedVersion:state.pipeline.conversationVersion})}/>使用 v2 上下文与记忆</label>
      <label><input type="checkbox" checked={state.controls.enabled} onChange={e=>void run(`${base}/memory-controls`,{...state.controls,expectedVersion:state.controls.version,version:undefined,enabled:e.target.checked})}/>保存此联系人记忆</label>
      {state.pipeline.contactId&&<label><input type="checkbox" checked={(state.pipeline.factScopes??[]).includes(state.pipeline.contactId)} onChange={e=>void run(`/contacts/${encodeURIComponent(state.pipeline.contactId)}/policy`,{expectedVersion:state.pipeline.conversationVersion,policy:{factScopes:e.target.checked?[...new Set([...(state.pipeline.factScopes??[]),state.pipeline.contactId])]:(state.pipeline.factScopes??[]).filter(s=>s!==state.pipeline.contactId)}},'v1')}/>回复中使用此联系人已确认记忆</label>}
      <label><input type="checkbox" checked={state.controls.styleSamples} onChange={e=>void run(`${base}/memory-controls`,{expectedVersion:state.controls.version,enabled:state.controls.enabled,retentionDays:state.controls.retentionDays,styleSamples:e.target.checked})}/>从真实发送学习表达习惯</label>
      <label>记忆有效天数<input type="number" min="1" max="3650" defaultValue={state.controls.retentionDays} key={state.controls.version} onBlur={e=>{const days=Number(e.target.value);if(days!==state.controls.retentionDays)void run(`${base}/memory-controls`,{expectedVersion:state.controls.version,enabled:state.controls.enabled,styleSamples:state.controls.styleSamples,retentionDays:days});}}/></label>
      <label>已确认关系<select value={state.relationship.confirmedStage} onChange={e=>void run(`${base}/relationship`,{expectedVersion:state.relationship.version,stage:e.target.value,locked:state.relationship.locked})}>
        <option value="unknown">未确认</option><option value="stranger">陌生</option><option value="familiar">普通熟悉</option><option value="getting_to_know">正在了解</option><option value="dating">已明确恋爱</option>
      </select></label>
      <label><input type="checkbox" checked={state.relationship.locked} onChange={e=>void run(`${base}/relationship`,{expectedVersion:state.relationship.version,stage:state.relationship.confirmedStage,locked:e.target.checked})}/>锁定关系设置</label>
      <details><summary>表达偏好</summary><p>已保存：{String(state.personalStyle.settings.tone??'未设置')} · 本人样本 {Number(state.personalStyle.statistics?.sampleSize??0)} 条</p>
        <label>语气<input value={style} onChange={e=>setStyle(e.target.value)} placeholder="例如：自然简短，少用表情"/></label><label><input type="checkbox" checked={global} onChange={e=>setGlobal(e.target.checked)}/>作为全局偏好</label>
        <label><input type="checkbox" checked={styleLocked} onChange={e=>setStyleLocked(e.target.checked)}/>锁定画像，暂停自动学习</label>
        <button disabled={!style.trim()} onClick={()=>void run(`${base}/style`,{expectedVersion:(global?state.personalStyle.globalVersion:state.personalStyle.contactVersion)??0,settings:{tone:style},global,locked:styleLocked})}>保存表达偏好</button>
      </details>
      <label>记忆类型<select value={memoryType} onChange={e=>setMemoryType(e.target.value)}>{Object.keys(names).slice(0,7).map(k=><option key={k} value={k}>{names[k]}</option>)}</select></label><label>记忆属于<select value={subject} onChange={e=>setSubject(e.target.value)}><option value="contact">对方</option><option value="owner">本人</option></select></label>
      <label>记忆用途<select value={purpose} onChange={e=>setPurpose(e.target.value)}><option value="manual_note">一般资料</option><option value="current_personal_status_or_schedule">当前状态或安排（24小时有效）</option></select></label>
      <label>补充本人已确认的记忆<input value={newContent} onChange={e=>setNewContent(e.target.value)} maxLength={2000}/></label><button disabled={!newContent.trim()} onClick={()=>void run(`${base}/memories`,{memory:{memoryType:purpose==='current_personal_status_or_schedule'?'temporary_state':memoryType,subject,predicate:purpose,object:newContent,content:newContent,evidenceType:'user_confirmed',evidenceRefs:[],confidence:1,importance:0.5,...(purpose==='current_personal_status_or_schedule'?{validUntil:new Date(Date.now()+86400000).toISOString()}: {})}})}>保存已确认记忆</button>
      <label>搜索聊天记忆<input value={search} onChange={e=>setSearch(e.target.value)}/></label><label>记忆状态<select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="all">全部未删除记忆</option>{['pending','active','superseded','expired'].map(k=><option key={k} value={k}>{names[k]}</option>)}</select></label>
      {state.items.filter(m=>m.status!=='deleted'&&(statusFilter==='all'||m.status===statusFilter)&&m.content.includes(search)).map(m=><article className="subcard" key={m.id}><p>{names[m.memoryType]} · {names[m.status]}</p><p>{m.content}</p><small>版本 {m.version} · 来源 {m.evidenceRefs.map(r=>`${r.id.slice(0,8)} / v${r.version}`).join('、')||'本人明确确认'}</small>
        {['active','pending'].includes(m.status)&&<div className="actions">{m.status==='pending'&&m.evidenceType==='explicit_statement'&&<button onClick={()=>void run(`${base}/memories/${m.id}/confirm`,{expectedVersion:m.version})}>确认事实</button>}
          <button onClick={()=>{setEditing(m);setContent(m.content);setObject(m.object);}}>纠正</button><button onClick={()=>void run(`${base}/memories/${m.id}/expire`,{expectedVersion:m.version})}>失效</button></div>}<button onClick={()=>void run(`${base}/memories/${m.id}/delete`,{expectedVersion:m.version})}>删除</button></article>)}
      {editing&&<div><label>纠正后的内容<textarea value={content} onChange={e=>setContent(e.target.value)}/></label><label>纠正后的值<input value={object} onChange={e=>setObject(e.target.value)}/></label><button onClick={()=>void run(`${base}/memories/${editing.id}/correct`,{expectedVersion:editing.version,content,object})}>确认纠正</button><button onClick={()=>setEditing(null)}>取消</button></div>}
      <button onClick={()=>void request<{context:ContextPackageV2|null;status:string}>(`${base}/context-preview`,undefined,'v2').then(setPreview).catch(e=>setError(formatError(e)))}>查看最近回复使用的资料</button>
    </fieldset>}
    {preview&&<details open><summary>上下文检查 · {preview.status==='valid'?'有效':preview.status==='stale'?'已过期':'尚未构建'}</summary>{preview.context&&<><p>近期 {preview.context.recentMessages.length} 条 · 记忆 {preview.context.memories.length} 条 · 输入约 {preview.context.budget.estimatedInputTokens} tokens</p><p>{preview.context.summary?.content??'无较早摘要'}</p><pre>{JSON.stringify(preview.context.selection,null,2)}</pre></>}</details>}
  </section>;
}
