import {useEffect,useState} from 'react';
import {request,ApiError} from '../api';import {requestKey} from '../browser-crypto';import {formatError} from '../controls';
import type {TrialQualitySettings,TrialQualitySave,TrialQualityApply} from '../../../../packages/contracts/trial-model-settings.mts';
type Form={providerId:string;modelId:string;modelVersion:string;baseUrl:string;apiKey:string;dataRegion:string;retentionPolicy:string;input:string;cached:string;output:string;source:string;effectiveAt:string;thinking:string;thinkingParameter:string};
const blank:Form={providerId:'custom-quality',modelId:'',modelVersion:'',baseUrl:'',apiKey:'',dataRegion:'unknown',retentionPolicy:'provider-default-unverified',input:'',cached:'0',output:'',source:'',effectiveAt:'',thinking:'',thinkingParameter:'thinking'};
function preset(role:'quality'|'economy'):Form{return {...blank,providerId:'qwen',modelId:role==='economy'?'qwen3.7-flash':'qwen3.5-plus',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1/',dataRegion:'cn-beijing',input:role==='economy'?'1.2':'4',cached:role==='economy'?'1.2':'4',output:role==='economy'?'4.8':'24',source:'https://help.aliyun.com/zh/model-studio/model-pricing',effectiveAt:'2026-10-13',thinking:'disabled',thinkingParameter:'enable_thinking'};}
function formFor(s:TrialQualitySettings,role:'quality'|'economy'='quality'):Form{const m=s.model;return m?{...blank,...m,apiKey:'',input:String(m.price.inputPerMillion),cached:String(m.price.cachedInputPerMillion),output:String(m.price.outputPerMillion),source:m.price.source,effectiveAt:m.price.effectiveAt.slice(0,10),thinking:m.thinking??'',thinkingParameter:m.thinkingParameter??'thinking'}:preset(role);}
export function TrialQualityModelPanel({onApplied,role='quality'}:{onApplied?:()=>void;role?:'quality'|'economy'}){
 const title=role==='economy'?'低成本模型':'高档模型',path='/trial-'+role+'-settings';
 const [state,setState]=useState<TrialQualitySettings>(),[form,setForm]=useState<Form>(blank),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[unavailable,setUnavailable]=useState(false),[restarting,setRestarting]=useState(false);
 const [pending,setPending]=useState<{action:'save';body:TrialQualitySave}|{action:'apply';body:TrialQualityApply}>();
 useEffect(()=>{const controller=new AbortController();void request<TrialQualitySettings>(path,{signal:controller.signal},'v2').then(s=>{setState(s);setForm(formFor(s,role));}).catch(e=>{if(controller.signal.aborted)return;if(e instanceof ApiError&&e.status===501)setUnavailable(true);else setError(formatError(e));});return()=>controller.abort();},[path,role]);
 useEffect(()=>{if(!restarting)return;let attempts=0,working=false,completed=false;const controller=new AbortController();const timer=setInterval(()=>{if(working||completed)return;working=true;void request<TrialQualitySettings>(path,{signal:controller.signal},'v2').then(s=>{setState(s);if(s.phase==='active'){completed=true;setRestarting(false);setNotice(title+'配置已启用。接口和效果仍需实际调用验证。');onApplied?.();}}).catch(()=>{}).finally(()=>{working=false;if(!completed&&++attempts>=30){setRestarting(false);setError('尚未确认启用结果，请刷新查看配置状态。');}});},2000);return()=>{controller.abort();clearInterval(timer);};},[restarting,path,title]);
 const change=(key:keyof Form,value:string)=>setForm(f=>({...f,[key]:value}));
 async function submit(action:'save'|'apply',retry=false){
  if(!state||busy||restarting)return;
  const command=retry?pending:action==='apply'?{action:'apply' as const,body:{expectedVersion:state.version,idempotencyKey:requestKey()}}:{action:'save' as const,body:{expectedVersion:state.version,idempotencyKey:requestKey(),model:{providerId:form.providerId.trim(),modelId:form.modelId.trim(),modelVersion:form.modelVersion.trim()||form.modelId.trim(),baseUrl:form.baseUrl.trim(),apiKey:form.apiKey,dataRegion:form.dataRegion.trim(),retentionPolicy:form.retentionPolicy.trim(),price:{currency:'CNY' as const,inputPerMillion:Number(form.input),cachedInputPerMillion:Number(form.cached),outputPerMillion:Number(form.output),source:form.source.trim(),effectiveAt:form.effectiveAt},...(form.thinking?{thinking:form.thinking as 'enabled'|'disabled',thinkingParameter:form.thinkingParameter as 'thinking'|'enable_thinking'}:{})}}};
  if(!command)return;setBusy(true);setPending(command);setError('');setNotice('');
  try{const latest=await request<TrialQualitySettings&{restarting?:boolean}>(path+(command.action==='apply'?'/apply':''),{method:'POST',body:JSON.stringify(command.body)},'v2');setState(latest);setForm(formFor(latest,role));setPending(undefined);setRestarting(!!latest.restarting);setNotice(command.action==='save'?title+'配置已保存，尚未启用。检查后点击“启用已保存配置”。':latest.restarting?'正在应用配置并重启候选服务，请稍候。':'当前配置已经启用。');}
  catch(e){const unknown=e instanceof ApiError&&(e.status===0||e.status>=500);if(!unknown)setPending(undefined);setError(unknown?'结果尚未确认，请重试同一请求。':e instanceof ApiError&&e.body.code==='VALIDATION_FAILED'?'请检查模型、HTTPS 基础地址、密钥及人民币价格是否填写完整。':formatError(e));}finally{setBusy(false);}
 }
 if(unavailable)return <p className="muted">此运行实例尚未开放{title}配置。</p>;
 if(!state)return <section aria-label={title+'配置'}><h4>{title}配置</h4><p>{error||'正在读取模型配置…'}</p></section>;
 const disabled=busy||!!pending||restarting;
 const changed=JSON.stringify(form)!==JSON.stringify(formFor(state,role));
 const retainsKey=state.hasApiKey&&state.model?.providerId===form.providerId&&state.model?.baseUrl===form.baseUrl;
 return <section className="trial-quality-panel" aria-label={title+'配置'}><h4>{title}配置</h4>
  <p>{role==='economy'?'负责决策、日常回复和 QQ 图片理解，请选支持图片的模型。':'负责复杂回复；四级引擎启用后也可用于情绪分析。'}</p>
  <p role="status">状态：{state.phase==='active'?'已启用':state.phase==='saved'?'已保存，尚未启用':'尚未配置'} · 当前{title}：{state.activeModelId??(role==='economy'?'现有 DeepSeek Flash':'沿用低成本模型')}</p>
  <form onSubmit={e=>{e.preventDefault();void submit('save');}}><fieldset disabled={disabled}>
   <button type="button" onClick={()=>setForm(preset(role))}>填入千问省钱配置</button><small>请填写北京地域百炼密钥。</small>
   <label>{title}名称<input required maxLength={300} value={form.modelId} onChange={e=>change('modelId',e.target.value)} placeholder="供应商要求的模型 ID"/></label>
   <label>接口基础地址<input required type="url" maxLength={300} value={form.baseUrl} onChange={e=>change('baseUrl',e.target.value)} placeholder="https://供应商/v1/"/></label>
   <small>使用兼容 Chat Completions 的接口基础地址。</small>
   <label>API 密钥<input type="password" required={!retainsKey} maxLength={4096} autoComplete="new-password" value={form.apiKey} onChange={e=>change('apiKey',e.target.value)} placeholder={retainsKey?'已保存；留空保留原密钥':'填写该供应商的密钥'}/></label>
   <p className="muted">保存后不回显密钥，密钥不保存在浏览器本地存储。</p>
   <details><summary>计费参数</summary><p className="muted">用于额度估算，通常保留预设即可。</p>
   <label>输入价格（元 / 百万 token）<input required type="number" min="0.000001" step="any" value={form.input} onChange={e=>change('input',e.target.value)}/></label>
   <label>输出价格（元 / 百万 token）<input required type="number" min="0.000001" step="any" value={form.output} onChange={e=>change('output',e.target.value)}/></label>
   <label>官方价格说明地址<input required type="url" maxLength={300} value={form.source} onChange={e=>change('source',e.target.value)}/></label>
   <label>价格核对日期<input required type="text" pattern="\d{4}-\d{2}-\d{2}" placeholder="YYYY-MM-DD" value={form.effectiveAt} onChange={e=>change('effectiveAt',e.target.value)}/></label>
   <small>千问预设按最高上下文档位预留和记账，实际短上下文账单通常更低。两档模型共用原有累计额度。</small></details>
   <details><summary>供应商与高级选项</summary>
    <label>供应商标识<input required maxLength={300} value={form.providerId} onChange={e=>change('providerId',e.target.value)}/></label>
    <label>模型版本<input maxLength={300} value={form.modelVersion} onChange={e=>change('modelVersion',e.target.value)} placeholder="留空使用模型名称"/></label>
    <label>缓存输入价格（元 / 百万 token）<input required type="number" min="0" step="any" value={form.cached} onChange={e=>change('cached',e.target.value)}/></label>
    <label>数据处理地区<input required maxLength={300} value={form.dataRegion} onChange={e=>change('dataRegion',e.target.value)}/></label>
    <label>数据保留政策<input required maxLength={300} value={form.retentionPolicy} onChange={e=>change('retentionPolicy',e.target.value)}/></label>
    <label>供应商思考参数<select value={form.thinking} onChange={e=>change('thinking',e.target.value)}><option value="">不附加参数</option><option value="disabled">关闭（仅供应商支持时）</option><option value="enabled">开启（仅供应商支持时）</option></select></label>
    <label>思考参数格式<select value={form.thinkingParameter} onChange={e=>change('thinkingParameter',e.target.value)}><option value="thinking">DeepSeek / thinking.type</option><option value="enable_thinking">千问 / enable_thinking</option></select></label>
   </details>
   <button type="submit">保存{title}配置</button>
   {state.phase==='saved'&&state.canApply&&<><p>已保存的{title}：{state.model?.modelId}</p>{changed&&<small>有未保存的修改，请先保存。</small>}<button type="button" disabled={changed} onClick={()=>void submit('apply')}>启用已保存配置</button></>}
  </fieldset></form>
  {pending&&!busy&&<button onClick={()=>void submit(pending.action,true)}>重试同一配置请求</button>}
  {error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
