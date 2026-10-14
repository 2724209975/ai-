import {useEffect,useState} from 'react';
import {request,ApiError} from '../api';
import {requestKey} from '../browser-crypto';
import {formatError} from '../controls';
import {TrialQualityModelPanel} from './TrialQualityModelPanel';
type EngineConfig={mode:'off'|'shadow'|'active';classifierProvider:string;classifierFallbackProvider:string|null;analysisProvider:string;minConfidence:number;contactIds:string[];cohortPercent:number;experimentKey:string};
type Config={decisionProvider:string;economyProvider:string;qualityProvider:string;fallbackProvider:string|null;cloudAllowed:boolean;timeoutMs:number;dailyCallLimit:number;dailyTokenLimit:number;maxReplyCharacters:number;contactOverrides:Record<string,{cloudAllowed:boolean;generationProvider:string|null}>;decisionEngineV21?:EngineConfig};
type Provider={key:string;task:string;modelId:string;cloud:boolean;dataRegion:string;retentionPolicy:string};
type State={version:number;config:Config;providers:Provider[]};
export function ModelPanel({contactId='',readOnly=false}:{contactId?:string;readOnly?:boolean}){
  const [state,setState]=useState<State>(),[config,setConfig]=useState<Config>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [pending,setPending]=useState<{expectedVersion:number;idempotencyKey:string;config:Config}>();
  const [modelRevision,setModelRevision]=useState(0);
  useEffect(()=>{const controller=new AbortController();void request<State>('/model-config',{signal:controller.signal},'v2').then(s=>{setState(s);setConfig(s.config);setError('');}).catch(e=>{if(!controller.signal.aborted)setError(formatError(e));});return()=>controller.abort();},[contactId,modelRevision]);
  async function save(retry=false){if(readOnly||!state||!config||busy)return;const body=retry?pending:{expectedVersion:state.version,idempotencyKey:requestKey(),config};if(!body)return;setBusy(true);setPending(body);setError('');setNotice('');
    try{await request('/model-config',{method:'POST',body:JSON.stringify(body)},'v2');setPending(undefined);const latest=await request<State>('/model-config',undefined,'v2');setState(latest);setConfig(latest.config);setNotice('模型配置已保存，正在生成和待审批的旧候选已过期。');}
    catch(e){const unknown=e instanceof ApiError&&(e.status===0||e.status>=500||e.body.code==='INVALID_RESPONSE');if(!unknown)setPending(undefined);setError(unknown?'保存结果尚未确认，请重试同一请求。':formatError(e));}finally{setBusy(false);}
  }
  if(!state||!config)return <section aria-label="模型配置"><h4>模型配置</h4>{error?<p role="alert" className="error">{error}</p>:<p>正在读取模型配置…</p>}</section>;
  const disabled=readOnly||busy||!!pending;
  const select=(field:'decisionProvider'|'economyProvider'|'qualityProvider'|'fallbackProvider',title:string,task:string)=><label>{title}<select value={config[field]??''} onChange={e=>setConfig({...config,[field]:e.target.value||null})}>{field==='fallbackProvider'&&<option value="">不降级，转人工处理</option>}{state.providers.filter(p=>p.task===task).map(p=><option key={p.key} value={p.key}>{p.modelId} · {p.cloud?'云端':'本地'}</option>)}</select></label>;
  const override=config.contactOverrides[contactId]??{cloudAllowed:true,generationProvider:null};
  const engine:EngineConfig=config.decisionEngineV21??{mode:'off',classifierProvider:config.decisionProvider,classifierFallbackProvider:null,analysisProvider:state.providers.find(p=>p.task==='analysis')?.key??'',minConfidence:0.8,contactIds:[],cohortPercent:100,experimentKey:'decision-v2.1'};
  const updateEngine=(patch:Partial<EngineConfig>)=>setConfig({...config,decisionEngineV21:{...engine,...patch}});
  const engineSelect=(field:'classifierProvider'|'classifierFallbackProvider'|'analysisProvider',label:string,task:string)=><label>{label}<select aria-label={label} value={engine[field]??''} onChange={e=>updateEngine({[field]:e.target.value||null})}><option value="">{field==='classifierFallbackProvider'?'不使用备用分类':'请选择已注册模型'}</option>{state.providers.filter(p=>p.task===task).map(p=><option key={p.key} value={p.key}>{p.modelId}</option>)}</select></label>;
  if(readOnly)return <section className="model-panel" aria-label="模型配置"><div className="model-role-grid"><TrialQualityModelPanel role="economy" onApplied={()=>setModelRevision(v=>v+1)}/><TrialQualityModelPanel onApplied={()=>setModelRevision(v=>v+1)}/></div></section>;
  return <section className="model-panel" aria-label="模型配置"><h4>模型配置</h4><p className="muted">云端密钥由服务端保管。</p><fieldset disabled={disabled}>
    {select('decisionProvider','决策模型','decision')}{select('economyProvider','普通聊天生成模型','generation')}{select('qualityProvider','复杂场景生成模型','generation')}{select('fallbackProvider','失败后的备用模型','generation')}
    <details><summary>四级决策 v2.1</summary><p>先使用 Shadow 观察模式，仅记录结果。启用后 L3 先分析再使用普通生成模型；L4 请本人核对并手动处理。所有候选继续由本人确认。</p>
      <label>运行模式<select aria-label="运行模式" value={engine.mode} onChange={e=>updateEngine({mode:e.target.value as EngineConfig['mode']})}><option value="off">关闭，沿用旧决策</option><option value="shadow">Shadow，仅观察</option><option value="active">启用四级决策</option></select></label>
      {engineSelect('classifierProvider','主分类模型','decision')}{engineSelect('classifierFallbackProvider','备用分类模型','decision')}{engineSelect('analysisProvider','复杂情绪分析模型','analysis')}
      <label>最低分类置信度<input type="number" min={0.5} max={1} step={0.05} value={engine.minConfidence} onChange={e=>updateEngine({minConfidence:Number(e.target.value)})}/></label>
      <label>灰度联系人比例（%）<input type="number" min={0} max={100} value={engine.cohortPercent} onChange={e=>updateEngine({cohortPercent:Number(e.target.value)})}/></label>
      <label>实验分组标识<input maxLength={100} value={engine.experimentKey} onChange={e=>updateEngine({experimentKey:e.target.value})}/></label>
      {contactId&&<label><input type="checkbox" checked={engine.contactIds.length>0} onChange={e=>updateEngine({contactIds:e.target.checked?[contactId]:[]})}/>仅对当前联系人启用</label>}
    </details>
    <label><input type="checkbox" checked={config.cloudAllowed} onChange={e=>setConfig({...config,cloudAllowed:e.target.checked})}/>允许云端模型访问聊天（全局）</label>
    {contactId&&<><label><input type="checkbox" checked={override.cloudAllowed} onChange={e=>setConfig({...config,contactOverrides:{...config.contactOverrides,[contactId]:{...override,cloudAllowed:e.target.checked}}})}/>此联系人允许云端模型</label>
    <label>此联系人生成模型<select value={override.generationProvider??''} onChange={e=>setConfig({...config,contactOverrides:{...config.contactOverrides,[contactId]:{...override,generationProvider:e.target.value||null}}})}><option value="">按场景路由</option>{state.providers.filter(p=>p.task==='generation').map(p=><option key={p.key} value={p.key}>{p.modelId}</option>)}</select></label></>}
    <label>单次最长等待（秒）<input type="number" min={1} max={120} value={config.timeoutMs/1000} onChange={e=>setConfig({...config,timeoutMs:Number(e.target.value)*1000})}/></label>
    <label>每日云端调用上限<input type="number" min={1} max={10000} value={config.dailyCallLimit} onChange={e=>setConfig({...config,dailyCallLimit:Number(e.target.value)})}/></label>
    <label>每日云端 token 上限<input type="number" min={512} value={config.dailyTokenLimit} onChange={e=>setConfig({...config,dailyTokenLimit:Number(e.target.value)})}/></label>
    <label>回复最长字数<input type="number" min={20} max={1000} value={config.maxReplyCharacters} onChange={e=>setConfig({...config,maxReplyCharacters:Number(e.target.value)})}/></label>
    {!readOnly && <button onClick={()=>void save()}>保存模型配置</button>}
  </fieldset>{pending&&!busy&&<button onClick={()=>void save(true)}>重试同一模型配置请求</button>}{error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}

  </section>;
}
