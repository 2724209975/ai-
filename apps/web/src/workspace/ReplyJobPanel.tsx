import {useCallback,useState} from 'react';
import {request,type ReplyJob} from '../api';
import {requestKey} from '../browser-crypto';
import {formatError} from '../controls';
import {usePolling} from './usePolling';
import type {RunCommand} from './CandidateEditor';
const names:Record<string,string>={RECEIVED:'已接收',BUFFERING:'等待消息合并',CONTEXT_READY:'上下文就绪',DECIDING:'判断回复策略',GENERATING:'生成候选',VALIDATING:'质量检查',PENDING_APPROVAL:'等待本人确认',SEND_QUEUED:'已确认，等待发送',SENDING:'正在提交',SUBMITTED:'平台已受理',SENT:'已送达',UNCERTAIN:'发送结果不确定',FAILED:'处理失败',STALE:'已过期',SKIPPED:'本轮未生成回复',CANCELLED:'已取消'};
const moneyErrors:Record<string,string>={MODEL_BUDGET_EXHAUSTED:'两端共享费用或今日调用额度不足，现有草稿已保留',MODEL_PRICE_REQUIRED:'当前模型未配置人民币价格，未发起收费请求',MODEL_BUDGET_UNAVAILABLE:'共享费用账本暂时无法读取，已阻止新调用，请检查电脑运行状态',MODEL_BUDGET_LIMIT_CHANGED:'费用总上限与已有账本不一致，请核对电脑费用配置',MODEL_BUDGET_POLICY_CHANGED:'各入口每日费用或用量设置不一致，请核对共用配置'};
export function ReplyJobPanel({id,run,blocked}:{id:string;run:RunCommand;blocked:boolean}){
  const fetchJobs=useCallback((signal:AbortSignal)=>request<{pipelineVersion:number;items:ReplyJob[]}>(`/conversations/${encodeURIComponent(id)}/reply-jobs`,{signal},'v2'),[id]);
  const jobs=usePolling(id,fetchJobs,3000,0);const [trace,setTrace]=useState<unknown>(),[error,setError]=useState('');
  const job=jobs.data?.items[0];if(jobs.data?.pipelineVersion!==2)return null;
  const cancellable=job&&['RECEIVED','BUFFERING','CONTEXT_READY','DECIDING','GENERATING','VALIDATING','PENDING_APPROVAL','SEND_QUEUED'].includes(job.status);
  return <section className="reply-job-panel" aria-label="回复任务状态"><div className="card-head"><h3>回复任务</h3><span className="badge">{job?names[job.status]??job.status:'等待下一条来信'}</span></div>
    {job&&<><p>{job.decision?`策略：${job.decision.strategy} · 风险：${({low:'低',medium:'中',high:'高'} as Record<string,string>)[job.decision.risk_level]??job.decision.risk_level}`:job.reasonCode??'正在准备本轮回复'}</p>
      {job.decision?.classification_level&&<p>分类：{job.decision.classification_level} · 置信度 {Math.round((job.decision.classification_confidence??0)*100)}%{job.decision.ambiguity?.detected?' · 有歧义，谨慎处理':''}</p>}
      {job.decision?.classification_level==='L4'&&<p className="warning" role="status">需要本人审核。请核对关系边界、隐私与承诺，手动处理本轮消息；本轮不生成或发送候选。</p>}
      {job.route?.engineV21&&<p>分类模型：{job.route.engineV21.classifierModelId??'不可用'} · {Math.round(job.route.engineV21.classificationElapsedMs)} ms<br/>深度分析：{job.route.engineV21.analysisStatus==='ok'?'已完成':job.route.engineV21.analysisStatus==='failed'?'失败，转本人处理':'无需分析'} · {job.route.engineV21.analysisModelId??'未调用'}{job.route.engineV21.upgradeReasons.length>0&&<><br/>升级原因：{job.route.engineV21.upgradeReasons.join('、')}</>}</p>}
      {job.shadowDecision&&<p>Shadow 观察：{job.shadowDecision.decision?.classification_level??job.shadowDecision.errorCode??'未知'} · 深度分析 {job.shadowDecision.route?.engineV21?.analysisStatus??'未完成'}。仅记录结果。</p>}
      {job.status==='UNCERTAIN'&&<p className="warning">请先核对平台聊天与回执，再处理发送结果。</p>}
      {job.status==='FAILED'&&<p className="warning">{moneyErrors[job.reasonCode??'']??(job.reasonCode==='QUALITY_BLOCKED'?'候选未通过质量检查，请查看诊断或手动回复。':`处理停止：${job.reasonCode??'未知原因'}`)}</p>}
      {cancellable&&<button disabled={blocked} onClick={()=>void run(`/reply-jobs/${encodeURIComponent(job.id)}/cancel`,{expectedVersion:job.version,idempotencyKey:requestKey()},'v2').catch(e=>setError(formatError(e)))}>取消本轮回复</button>}
      {job.decision?.classification_level!=='L4'&&['FAILED','SKIPPED','STALE','CANCELLED'].includes(job.status)&&<button disabled={blocked} onClick={()=>void run(`/reply-jobs/${encodeURIComponent(job.id)}/regenerate`,{expectedVersion:job.version,expectedConversationRevision:job.conversationRevision,idempotencyKey:requestKey()},'v2').catch(e=>setError(formatError(e)))}>重新生成本轮候选</button>}
      <details><summary>本轮生成说明</summary><p>{({COMPLEX_HIGH_QUALITY:'本轮涉及复杂或敏感内容，选择高档回复模型',SIMPLE_ECONOMY:'本轮为日常聊天，选择低成本回复模型',CONTACT_OVERRIDE:'本轮使用为这个联系人指定的模型',PRIVACY_LOCAL_ONLY:'按本机数据设置选择本地模型'} as Record<string,string>)[job.route?.reason??'']??'正在判断本轮使用的模型'}</p><p>决策模型：{job.route?.decisionProvider??'尚未调用'} · 生成模型：{job.route?.generationProvider??'本轮未生成'}</p><p>聊天和有效记忆的选取可在「聊天设置 → 上下文检查」查看；完整记录保留在下方诊断中。</p>
        {job.quality?.map(q=><p key={q.candidateKey}>{({natural:'自然型',playful:'轻松型',direct:'直接型'} as Record<string,string>)[q.style]} · {q.status==='passed'?'质量通过':q.status==='blocked'?'已阻断':'需本人审核'}：{q.reasons.join('、')||'无额外问题'}</p>)}
        <button onClick={()=>void request(`/reply-jobs/${encodeURIComponent(job.id)}/trace`,undefined,'v2').then(setTrace).catch(e=>setError(formatError(e)))}>读取完整诊断链路</button>
        {trace!==undefined&&<details><summary>完整诊断记录</summary><pre>{JSON.stringify(trace,null,2)}</pre></details>}
      </details></>}{error&&<p role="alert" className="error">{error}</p>}
  </section>;
}
