import {useEffect,useState} from 'react';
import {ApiError,request} from './api';
import {requestKey} from './browser-crypto';
type Profile={name:string;platform:string;relationship:string;style:string;preferences:{id:string;text:string}[];memory:{consent:boolean;paused:boolean;profile:string;entries:unknown[]}};
type RecordVersion={id:string;version:number;seq:number;kind:string;body:any;deleted:boolean};
type Group={id:string;deviceId?:string;contactId:string|null;revision:number;historyCorrections?:boolean;resetRevision?:number;records:Record<string,RecordVersion>;packet:{summary:string;style:string;examples:string[];method:string;sourceIds:string[]};conflicts:{id:string;current:RecordVersion;operation:{kind:string;body:unknown;deleted:boolean}}[];syncReceipt?:{confirmedCursor:number;confirmedAt:number;lastRequestAt:number;lastRequestCursor?:number}};
type DesktopContact={id:string;name:string;platform:string};
type EvidenceSource={id:string;version:number;status:'current'|'updated'|'deleted'|'unavailable';speaker?:string;text?:string;timestamp?:number|null;origin?:string;uncertain?:boolean;generated?:boolean};
type Budget={budgetId:string;limitMicroCny:number;desktopMicroCny:number;halted:boolean;phones:{deviceId:string;limitMicroCny:number;spentMicroCny:number;calls:number;tokens:number;updatedAt:number;lastReportedAt?:number}[];daily?:{day:string;reservedMicroCny:number;calls:number;tokens:number}};
type LinkData={devices:{id:string;name:string;revoked:boolean}[];groups:Group[];budget?:Budget|null;contacts?:DesktopContact[]};
const time=(at:number)=>new Date(at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function versionText(kind:string,body:any,deleted:boolean){
 if(deleted||!body)return '已删除';
 if(kind==='memory_v2')return `${body.content}（${body.status==='active'?'有效':body.status==='pending'?'待确认':'已失效'}）`;
 if(kind==='context_v2')return `已确认关系：${body.relationship?.confirmedStage??'未知'}；长期记忆${body.enabled?'已启用':'已停用'}`;
 if(kind==='profile')return `关系：${body.relationship||'未填写'}\n风格：${body.style||'未填写'}\n偏好：${body.preferences.map((x:{text:string})=>x.text).join('；')||'未填写'}${body.memory.consent?'\n背景：'+(body.memory.profile||'未填写'):''}`;
 return `${body.speaker==='ME'?'我':body.speaker==='OTHER'?'对方':'说话人不确定'}：${body.text}`;
}
export function MobileLink({refreshVersion=0}:{refreshVersion?:number}){
 const [data,setData]=useState<LinkData|null>(null),[error,setError]=useState(''),[invite,setInvite]=useState<{qr:string;payload:string;expiresAt:number}|null>(null),[busy,setBusy]=useState(false),[now,setNow]=useState(Date.now()),[readAt,setReadAt]=useState(0),[search,setSearch]=useState(''),[copied,setCopied]=useState(false);
 const load=async()=>{const next=await request<LinkData>('/mobile-link');setData(next);setReadAt(Date.now());setError('');};
 useEffect(()=>{const refresh=()=>void load().catch(()=>setError('电脑联动暂时不可用，已显示资料保留。请检查联动服务后刷新。'));refresh();const t=setInterval(()=>{if(!document.hidden)refresh();},10000);return()=>clearInterval(t);},[refreshVersion]);
 useEffect(()=>{if(!invite)return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[invite]);
 async function command(path:string,body:unknown){setBusy(true);setError('');try{const result=await request<any>('/mobile-link/'+path,{method:'POST',body:JSON.stringify(body)});await load();return result;}catch(e){setError(e instanceof ApiError&&e.status===409?'资料已有新版本，请刷新后比较两端修改。':path==='allowance'?'额度分配失败：总额度不足、模型费用尚未结清或尝试缩减离线额度。刷新后核对。':'操作未完成，请刷新后重试。');}finally{setBusy(false);}}
 const remaining=invite?Math.max(0,Math.ceil((invite.expiresAt-now)/1000)):0;
 const contactFor=(g:Group)=>data?.contacts?.find(c=>c.id===g.contactId);
 const matches=(g:Group)=>[g.records.profile?.body?.name??'',g.records.profile?.body?.platform??'',contactFor(g)?.name??'',contactFor(g)?.platform??''].join(' ').toLowerCase().includes(search.toLowerCase());
 return <section className="stack">
 {error&&<p role="alert" className="error">{error}</p>}
 <article className="card"><h3>连接手机</h3><p>1. 电脑与手机连接同一 Wi-Fi。2. 手机「电脑联动」扫码。3. 选择手机对象并关联同一人的电脑联系人。</p><p>电脑关闭后，手机仍可用已下载资料继续回复；修改在下次连接时同步。</p>
 <button disabled={!data||busy} onClick={()=>void command('invite',{}).then(r=>{if(r){setInvite(r);setNow(Date.now());setCopied(false);}})}>{invite?'重新生成配对二维码':'生成配对二维码'}</button>
 {invite&&<div>{remaining>0&&<img width="300" style={{maxWidth:'100%'}} alt="手机配对二维码" src={invite.qr}/>}<p role="status">{remaining>0?`配对码还剩 ${remaining} 秒，仅可使用一次。`:'配对码已过期，请重新生成。'}</p>
 {remaining>0&&<><textarea readOnly value={invite.payload} aria-label="配对内容"/><button onClick={()=>void navigator.clipboard.writeText(invite.payload).then(()=>setCopied(true)).catch(()=>setError('未能复制，可直接选中配对内容复制。'))}>{copied?'已复制配对内容':'复制配对内容'}</button></>}</div>}
 </article>
 {data?.budget&&<article className="card"><h3>费用概览</h3><p>已用约 {money(data.budget.desktopMicroCny+data.budget.phones.reduce((n,p)=>n+p.spentMicroCny,0))} 元</p><p>电脑可用约 {money(Math.max(0,data.budget.limitMicroCny-data.budget.desktopMicroCny-data.budget.phones.reduce((n,p)=>n+p.limitMicroCny,0)))} 元</p><p className="muted">按保守估算显示，手机费用在同步后更新。</p>{data.budget.halted&&<p role="alert" className="warning">费用尚未结清，模型调用已暂停。</p>}{data.budget.limitMicroCny===0&&<p role="status">尚未配置总额度，暂时无法分配手机额度。</p>}<details><summary>管理手机额度</summary><p>手机离线可使用已分配额度；已分配金额不能缩减，撤销连接也不会回收。</p>{data.devices.filter(d=>!d.revoked).map(d=><AllowanceEditor key={d.id} name={d.name} deviceId={d.id} budget={data.budget!} busy={busy} command={command}/>)}</details></article>}
 {data&&!data.budget&&<p>当前服务尚未提供费用数据，请更新电脑服务后刷新。已领取的手机额度仍保留。</p>}
 {data?.devices.map(d=><article className="card" key={d.id}><h3>{d.name}</h3><p>{d.revoked?'已撤销授权，手机保留此前下载的资料':'已配对，只同步手机选择关联的对象'}</p>{!d.revoked&&<button disabled={busy} onClick={()=>void command('revoke',{deviceId:d.id})}>撤销连接</button>}</article>)}
 <article className="card"><h3>关联对象资料</h3><p>{readAt?`最近读取电脑资料：${time(readAt)}（手机成功同步时间在手机查看）`:'正在读取资料…'}</p><button disabled={busy} onClick={()=>void load().catch(()=>setError('电脑联动暂时不可用，请检查服务后重试。'))}>刷新联动资料</button><label>查找关联对象<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="名称 / 平台"/></label>{data?.groups.length===0&&<p>手机配对后，选择对象并点击「关联当前对象」，资料就会出现在这里。</p>}</article>
 {data?.groups.map(g=><LinkedGroup key={g.id} group={g} contact={contactFor(g)} revoked={data.devices.some(d=>d.id===g.deviceId&&d.revoked)} visible={matches(g)} busy={busy} command={command}/>)}
 {data&&data.groups.length>0&&!data.groups.some(matches)&&<p>没有匹配的关联对象。</p>}
 </section>;
}
const money=(micro:number)=>micro>0&&micro<10000?'不足 0.01':(micro/1e6).toFixed(2);
function AllowanceEditor({name,deviceId,budget,busy,command}:{name:string;deviceId:string;budget:Budget;busy:boolean;command:(path:string,body:unknown)=>Promise<any>}){
 const [amount,setAmount]=useState('');const p=budget.phones.find(p=>p.deviceId===deviceId);const micro=Math.round(Number(amount)*1e6);const maximum=Math.max(0,budget.limitMicroCny-budget.desktopMicroCny-budget.phones.reduce((n,p)=>n+p.limitMicroCny,0)+(p?.limitMicroCny??0));const valid=amount.trim()!==''&&Number.isSafeInteger(micro)&&micro>0&&micro>=(p?.limitMicroCny??0)&&micro<=maximum;
 return <div className="subcard"><h4>{name}</h4><p>累计分配 {money(p?.limitMicroCny??0)} 元 · 已上报 {money(p?.spentMicroCny??0)} 元 · {p?.calls??0} 次调用{p?.lastReportedAt?` · 最近上报 ${time(p.lastReportedAt)}`:''}</p><p>{p?.lastReportedAt?'已收到手机费用上报。':'尚未记录手机费用上报时间，手机下次同步后更新。'}</p><p>本设备最高累计额度 {(maximum/1e6).toFixed(6)} 元；已分配额度不能缩减。</p><label>手机累计额度（元）<input type="number" min={(p?.limitMicroCny??0)/1e6} max={maximum/1e6} step="0.000001" value={amount} onChange={e=>setAmount(e.target.value)}/></label>{amount.trim()!==''&&!valid&&<p role="status">金额超出当前可分配范围，请核对最高累计额度。</p>}<button disabled={busy||budget.halted||!valid} onClick={()=>void command('allowance',{deviceId,limitMicroCny:micro}).then(r=>{if(r)setAmount('');})}>分配额度，随后在手机同步领取</button></div>;
}
function LinkedGroup({group:g,contact,revoked,visible,busy,command}:{group:Group;contact?:DesktopContact;revoked:boolean;visible:boolean;busy:boolean;command:(path:string,body:unknown)=>Promise<any>}){
 const record=g.records.profile,p=record?.body as Profile|undefined;
 const [relationship,setRelationship]=useState(''),[style,setStyle]=useState(''),[preferences,setPreferences]=useState(''),[background,setBackground]=useState(''),[editBase,setEditBase]=useState<RecordVersion|null>(null);
 const dirty=editBase!==null;
 useEffect(()=>{if(!dirty&&p){setRelationship(p.relationship);setStyle(p.style);setPreferences(p.preferences.map(x=>x.text).join('\n'));setBackground(p.memory.profile);}},[record?.version,dirty]);
 if(!p)return null;
 const beginEdit=()=>{if(!editBase)setEditBase(record);};
 const requestedCursor=g.syncReceipt?.lastRequestCursor??g.syncReceipt?.confirmedCursor??0;
 return <article className="card" style={visible?undefined:{display:'none'}}><h3>{p.name} · {p.platform}{g.deviceId===''?'（旧关联）':revoked?'（授权已撤销）':''}</h3><p>{g.deviceId===''?'已解除关联，保留旧资料':revoked?'手机授权已撤销，保留旧资料':g.contactId?`已关联电脑联系人：${contact?`${contact.name} · ${contact.platform}`:'名称暂不可用'}`:'仅整理手机资料'} · 资料版本 {g.revision} · {g.conflicts.length} 项修改待选择</p>
 {g.deviceId!==''&&!revoked&&<div className="subcard"><h4>手机接收确认</h4>{g.syncReceipt?<><p>手机已确认收到第 {g.syncReceipt.confirmedCursor} 版资料 · 确认时间 {time(g.syncReceipt.confirmedAt)}</p>{requestedCursor<g.syncReceipt.confirmedCursor&&<p>手机本次报告的是较早资料，正在补齐；历史接收确认保留。</p>}<p>{requestedCursor>=g.revision?'手机已确认收到电脑当前资料。':`待手机确认 ${Object.values(g.records).filter(r=>r.seq>requestedCursor).length} 项更新；回到手机「电脑联动」同步。`}</p>{Date.now()-g.syncReceipt.lastRequestAt>120000&&<p>超过两分钟未收到手机同步，这里保留上次确认；手机回到联动页后可继续同步。</p>}</>:<p>尚未记录手机接收确认，下次手机同步后更新。</p>}<p>电脑保存的聊天资料 {Object.values(g.records).filter(r=>r.kind==='message'&&!r.deleted).length} 条；这里的资料数量不代表完整 QQ 历史。</p></div>}
 <details><summary>整理背景与回复偏好{dirty?'（有未保存修改）':''}</summary>
 {editBase&&editBase.version!==record.version&&<p role="status">手机已更新资料。你的修改仍保留，保存后会比较两端版本。</p>}
 <label>关系说明<textarea aria-label="关系说明" value={relationship} onChange={e=>{beginEdit();setRelationship(e.target.value);}}/></label>
 <label>回复风格<textarea aria-label="回复风格" value={style} onChange={e=>{beginEdit();setStyle(e.target.value);}}/></label>
 <label>已保存偏好（每行一项）<textarea aria-label="已保存偏好（每行一项）" value={preferences} onChange={e=>{beginEdit();setPreferences(e.target.value);}}/></label>
 {p.memory.consent&&<label>关系背景<textarea aria-label="关系背景" value={background} onChange={e=>{beginEdit();setBackground(e.target.value);}}/></label>}
 <button disabled={busy||!editBase} onClick={()=>{const base=editBase!.body as Profile;void command('profile',{groupId:g.id,expectedVersion:editBase!.version,profile:{...base,relationship,style,preferences:preferences.split('\n').map(x=>x.trim()).filter(Boolean).map((text,i)=>({id:base.preferences.find(x=>x.text===text)?.id??`desktop-${g.id}-${editBase!.version}-${i}`,text})),memory:{...base.memory,profile:background}}}).then(r=>{if(r)setEditBase(null);});}}>保存资料</button>
 <button disabled={busy||!dirty} onClick={()=>setEditBase(null)}>放弃未保存修改</button></details>
 {g.conflicts.map(c=><div className="subcard" key={c.id}><h4>两端修改需要选择</h4><p>电脑当前版本</p><pre style={{whiteSpace:'pre-wrap'}}>{versionText(c.current.kind,c.current.body,c.current.deleted)}</pre><p>待合并版本</p><pre style={{whiteSpace:'pre-wrap'}}>{versionText(c.operation.kind,c.operation.body,c.operation.deleted)}</pre><button disabled={busy} onClick={()=>void command('resolve',{groupId:g.id,recordId:c.id,side:'current',expectedVersion:c.current.version})}>使用电脑当前版本</button><button disabled={busy} onClick={()=>void command('resolve',{groupId:g.id,recordId:c.id,side:'incoming',expectedVersion:c.current.version})}>使用待合并版本</button></div>)}
 <LinkedMemories group={g}/>
 <LinkedHistory group={g} busy={busy} command={command} revoked={revoked}/></article>;
}
const memoryNames:Record<string,string>={fact:'事实',preference:'偏好',boundary:'边界',episode:'经历',promise:'承诺',relationship_event:'关系事件',temporary_state:'临时状态'};
function memoryReason(body:any,context:any,now:number){
 if(body.status==='pending')return '待确认';if(body.status==='superseded')return '已被新记忆替代';if(body.status==='expired'||body.validUntil&&Date.parse(body.validUntil)<=now)return '已过期';if(body.validUntil&&!Number.isFinite(Date.parse(body.validUntil)))return '有效期待核对';
 if(!context?.enabled)return '长期记忆已停用';
 if(body.contactId!==context.contactId||body.ownerId!==context.ownerId||body.accountId!==context.accountId||body.conversationId!==context.conversationId)return '所属对象不匹配';
 if(!['explicit_statement','user_confirmed'].includes(body.evidenceType))return '来源尚未确认';
 if(!body.evidenceValid||body.evidenceType!=='user_confirmed'&&!body.evidenceRefs?.length)return '聊天来源已失效';
 if(body.validFrom&&!(Date.parse(body.validFrom)<=now))return '尚未到生效时间';
 if(!(Date.parse(body.observedAt)>now-(context.retentionDays??90)*86400000))return '超出资料保留期限';
 return body.status==='active'?'有效':'不可使用';
}
function LinkedMemories({group:g}:{group:Group}){
 const [query,setQuery]=useState(''),[status,setStatus]=useState(''),[kind,setKind]=useState('');
 const context=Object.values(g.records).find(r=>r.kind==='context_v2'&&!r.deleted)?.body,now=Date.now();
 const memories=Object.values(g.records).filter(r=>r.kind==='memory_v2'&&!r.deleted).map(r=>({record:r,reason:memoryReason(r.body,context,now)}));
 const shown=memories.filter(({record:r,reason})=>(!query||`${r.body.content} ${memoryNames[r.body.memoryType]??r.body.memoryType}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))&&(!kind||r.body.memoryType===kind)&&(!status||(status==='usable'?reason==='有效':status==='pending'?reason==='待确认':reason!=='有效'&&reason!=='待确认')));
 return <details><summary>同步给手机的长期记忆（{memories.filter(m=>m.reason==='有效').length}条有效）</summary>
 <p>手机按当前话题使用有效记忆；待确认、删除、过期、被替代或来源失效的内容不作为确定事实。有效表示可参与检索，不代表每轮都会采用。</p>
 <label>查找长期记忆<input aria-label="查找长期记忆" value={query} onChange={e=>setQuery(e.target.value)} placeholder="输入记忆关键词"/></label>
 <label>记忆状态<select aria-label="记忆状态" value={status} onChange={e=>setStatus(e.target.value)}><option value="">全部状态</option><option value="usable">有效</option><option value="pending">待确认</option><option value="unusable">暂不使用</option></select></label>
 <label>记忆类型<select aria-label="记忆类型" value={kind} onChange={e=>setKind(e.target.value)}><option value="">全部类型</option>{Object.entries(memoryNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
 <p role="status">匹配 {shown.length} 条 / 共 {memories.length} 条</p>
 {memories.length===0?<p>电脑还没有为此对象整理长期记忆，可在记忆中心查看或确认。</p>:shown.length===0?<p>没有匹配的记忆，可调整关键词、状态或类型。</p>:shown.map(({record:r,reason})=><div className="subcard" key={r.id} data-testid="linked-memory"><h4>{memoryNames[r.body.memoryType]??'记忆'} · {reason}</h4><p>{r.body.content}</p><small>{r.body.evidenceRefs?.length??0} 条聊天来源{r.body.locked?' · 本人已锁定':''}{r.body.validUntil?` · 有效期至 ${new Date(r.body.validUntil).toLocaleString('zh-CN')}`:''}</small>
 {r.body.evidenceType==='user_confirmed'&&!r.body.evidenceRefs?.length?<p>由本人确认，未绑定聊天原文。</p>:<MemoryEvidence key={`${r.id}:${r.version}`} groupId={g.id} recordId={r.id}/>}
 </div>)}
 </details>;
}
function MemoryEvidence({groupId,recordId}:{groupId:string;recordId:string}){
 const [sources,setSources]=useState<EvidenceSource[]|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function load(){setBusy(true);setError('');setSources(null);try{const result=await request<{sources:EvidenceSource[]}>(`/mobile-link/evidence?groupId=${encodeURIComponent(groupId)}&recordId=${encodeURIComponent(recordId)}`);setSources(result.sources);}catch(e){setError(e instanceof ApiError&&e.status===409?'记忆已更新，请刷新联动资料后查看。':'聊天来源暂时无法读取，请重试。');}finally{setBusy(false);}}
 return <div><button disabled={busy} onClick={()=>void load()}>{busy?'正在读取来源…':sources?'刷新聊天来源':'查看聊天来源'}</button>{error&&<p role="alert">{error}</p>}{sources&&sources.length===0&&<p>此记忆没有绑定聊天原文。</p>}{sources?.map(s=><div className="subcard" key={`${s.id}:${s.version}`}><small>来源版本 {s.version} · {s.status==='current'?`${s.origin==='phone'?'手机记录':'电脑记录'} · ${s.timestamp===null?'时间未标注':new Date(s.timestamp!).toLocaleString('zh-CN')}`:s.status==='updated'?'来源已修改':s.status==='deleted'?'来源已删除':'来源不可用'}</small>{s.status==='current'?<p>{s.uncertain?'[不确定] ':''}{s.generated?'[助手生成] ':''}{s.speaker==='ME'?'我':s.speaker==='OTHER'?'对方':'说话人不确定'}：{s.text}</p>:<p>不展示已失效的原文，请在记忆中心核对这条记忆。</p>}</div>)}</div>;
}
function LinkedHistory({group:g,busy,command,revoked}:{group:Group;busy:boolean;revoked:boolean;command:(path:string,body:unknown)=>Promise<any>}){
 const [query,setQuery]=useState(''),[source,setSource]=useState(''),[speaker,setSpeaker]=useState(''),[page,setPage]=useState(0);
 const origin=(r:RecordVersion)=>r.id.startsWith('desktop:')?'desktop':r.id.startsWith('phone:')?'phone':'unknown';
 const messages=Object.values(g.records).filter(r=>r.kind==='message'&&!r.deleted).sort((a,b)=>{
   if(a.body.timestamp===null&&b.body.timestamp!==null)return 1;if(b.body.timestamp===null&&a.body.timestamp!==null)return -1;
   return (b.body.timestamp??0)-(a.body.timestamp??0)||b.seq-a.seq||a.id.localeCompare(b.id);
 });
 const needle=query.trim().toLocaleLowerCase();
 const filtered=messages.filter(r=>(!needle||String(r.body.text).toLocaleLowerCase().includes(needle))&&(!source||origin(r)===source)&&(!speaker||r.body.speaker===speaker));
 const pages=Math.max(1,Math.ceil(filtered.length/50)),current=Math.min(page,pages-1),shown=filtered.slice(current*50,(current+1)*50).reverse();
 useEffect(()=>setPage(p=>Math.min(p,pages-1)),[pages]);
 const dateText=(timestamp:number|null)=>{if(timestamp===null)return '时间未标注';const date=new Date(timestamp);return Number.isNaN(date.getTime())?'时间待核对':date.toLocaleString('zh-CN');};
 return <details><summary>手机可用的历史资料与表达习惯</summary>
 <h4>较早背景 · {g.packet.method==='model'?'模型选取原文':'按当前话题选取原文'} · {g.packet.sourceIds.length} 条来源</h4>
 <pre style={{whiteSpace:'pre-wrap'}}>{g.packet.summary||'较早内容不足，先使用最近聊天。'}</pre>
 <h4>聊天原文</h4><p>共 {messages.length} 条 · 手机记录 {messages.filter(r=>origin(r)==='phone').length} 条 · 电脑记录 {messages.filter(r=>origin(r)==='desktop').length} 条。</p>
 <p>每页 50 条，从最近一页开始；未标注时间的记录按保留顺序展示，不推断日期。这里只展示已同步资料。</p>
 <label>查找聊天原文<input aria-label="查找聊天原文" value={query} placeholder="输入原文关键词" onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label>
 <label>记录来源<select aria-label="记录来源" value={source} onChange={e=>{setSource(e.target.value);setPage(0);}}><option value="">全部来源</option><option value="phone">手机记录</option><option value="desktop">电脑记录</option><option value="unknown">来源未标注</option></select></label>
 <label>说话人<select aria-label="说话人" value={speaker} onChange={e=>{setSpeaker(e.target.value);setPage(0);}}><option value="">全部说话人</option><option value="ME">我</option><option value="OTHER">对方</option><option value="UNKNOWN">说话人不确定</option></select></label>
 <p role="status">匹配 {filtered.length} 条 · 第 {current+1} / {pages} 页</p>
 {!g.historyCorrections&&g.deviceId&&!revoked&&<p>电脑纠错需要手机 0.8.0 或更新版本；安装后同步当前对象即可使用。</p>}
 <div data-testid="link-history">{shown.map(r=><div className="subcard" key={r.id} data-history-record><small>{origin(r)==='desktop'?'电脑记录':origin(r)==='phone'?'手机记录':'来源未标注'} · {dateText(r.body.timestamp)}{r.body.generated?' · 曾由助手生成':''}</small><p>{r.body.uncertain?'[不确定] ':''}{r.body.speaker==='ME'?'我':r.body.speaker==='OTHER'?'对方':'说话人不确定'}：{r.body.text}</p><SourceActions group={g} record={r} busy={busy} command={command} canCorrect={!!g.historyCorrections&&!!g.deviceId&&!revoked&&origin(r)==='phone'}/></div>)}</div>
 {filtered.length===0&&<p>没有匹配的聊天原文，可调整关键词、来源或说话人。</p>}
 <div className="actions"><button disabled={current===0} onClick={()=>setPage(current-1)}>上一页</button><button disabled={current>=pages-1} onClick={()=>setPage(current+1)}>下一页</button></div>
 <h4>表达习惯</h4><pre style={{whiteSpace:'pre-wrap'}}>{g.packet.style||'可靠本人发言不足十条。'}</pre>{g.packet.examples.map((x,i)=><p key={i}>{x}</p>)}
 </details>;
}
function SourceActions({group:g,record:r,busy,command,canCorrect}:{group:Group;record:RecordVersion;busy:boolean;canCorrect:boolean;command:(path:string,body:unknown)=>Promise<any>}){
 const [mode,setMode]=useState(''),[base,setBase]=useState<RecordVersion|null>(null),[text,setText]=useState(''),[speaker,setSpeaker]=useState('OTHER'),[uncertain,setUncertain]=useState(false),[kind,setKind]=useState('fact'),[subject,setSubject]=useState('contact'),[until,setUntil]=useState(''),[saved,setSaved]=useState(false),[key,setKey]=useState('');
 const open=(value:string)=>{setMode(value);setBase(r);setText(r.body.text);setSpeaker(r.body.speaker);setUncertain(r.body.uncertain);setSubject(r.body.speaker==='ME'?'owner':'contact');setKey(requestKey());setSaved(false);};
 const stale=base&&base.version!==r.version;
 return <div>{canCorrect&&<button disabled={busy} onClick={()=>open('correct')}>纠正原文</button>}{g.contactId&&!r.body.uncertain&&!r.body.generated&&r.body.speaker!=='UNKNOWN'&&<button disabled={busy} onClick={()=>open('memory')}>从原文整理记忆</button>}{saved&&<p role="status">已保存，手机下次同步后更新。</p>}
 {mode&&base&&<div>{stale&&<p role="status">原文已更新，编辑内容保留；请取消后重新核对。</p>}<label>{mode==='correct'?'纠正后的原文':'确认的记忆内容'}<textarea aria-label={mode==='correct'?'纠正后的原文':'确认的记忆内容'} value={text} onChange={e=>setText(e.target.value)} maxLength={mode==='correct'?20000:2000}/></label>
 {mode==='correct'?<><label>原文说话人<select aria-label="原文说话人" value={speaker} onChange={e=>{setSpeaker(e.target.value);if(e.target.value==='UNKNOWN')setUncertain(true);}}><option value="ME">我</option><option value="OTHER">对方</option><option value="UNKNOWN">不确定</option></select></label><label><input type="checkbox" checked={uncertain} disabled={speaker==='UNKNOWN'} onChange={e=>setUncertain(e.target.checked)}/>原文仍有不确定内容</label><p>修订保留来源和时间，旧候选及依赖旧原文的记忆需要重新核对。</p></>:<><label>整理记忆类型<select aria-label="整理记忆类型" value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(memoryNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>记忆属于<select aria-label="记忆属于" value={subject} onChange={e=>setSubject(e.target.value)}><option value="contact">对方</option><option value="owner">本人</option></select></label><label>记忆到期时间<input aria-label="记忆到期时间" type="datetime-local" value={until} onChange={e=>setUntil(e.target.value)}/></label><p>保存表示你确认了这条记忆；原文版本会作为证据保留。</p></>}
 <button disabled={busy||!!stale||!text.trim()||kind==='temporary_state'&&mode==='memory'&&!until} onClick={()=>{const body=mode==='correct'?{groupId:g.id,recordId:r.id,expectedVersion:base.version,message:{text,speaker,uncertain}}:{groupId:g.id,recordId:r.id,expectedVersion:base.version,content:text,memoryType:kind,subject,...(until?{validUntil:new Date(until).toISOString()}:{}),idempotencyKey:key};void command(mode==='correct'?'message':'remember',body).then(result=>{if(result){setMode('');setSaved(true);}});}}>{mode==='correct'?'保存原文修订':'确认保存记忆'}</button><button disabled={busy} onClick={()=>setMode('')}>取消整理</button></div>}
 </div>;
}
