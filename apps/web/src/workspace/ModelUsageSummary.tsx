import {useEffect,useState} from 'react';
import {request} from '../api';
type Usage={totals?:{calls:number;errors:number};costs?:{currency:string|null;knownCost:string|null;unknownCalls:number}[];models?:{task:string;modelId:string;calls:number;errors:number}[]};
export function ModelUsageSummary({refreshVersion}:{refreshVersion:number}){
  const [usage,setUsage]=useState<Usage>(),[failed,setFailed]=useState(false);
  useEffect(()=>{const controller=new AbortController();setFailed(false);void request<Usage>('/model-usage',{signal:controller.signal},'v2').then(setUsage).catch(()=>{if(!controller.signal.aborted)setFailed(true);});return()=>controller.abort();},[refreshVersion]);
  return <article className="card"><h3>模型用量</h3>{failed?<p role="alert">暂时无法读取用量，请刷新重试。</p>:usage?<>
    <p>近 30 天调用 {usage.totals?.calls??0} 次</p>
    {usage.costs?.map((c,i)=><p key={i}>{c.currency==='CNY'&&c.knownCost!==null?`已知费用约 ${Number(c.knownCost).toFixed(2)} 元`:'费用暂未提供'}{c.unknownCalls>0?' · 部分调用费用未知':''}</p>)}
    <p className="muted"><a href="#link">查看两端额度</a></p>
    <details><summary>查看调用统计</summary><p>调用错误 {usage.totals?.errors??0} 次</p>{usage.models?.map((m,i)=><p key={i}>{m.modelId} · {m.calls} 次调用 · 错误 {m.errors} 次</p>)}</details>
  </>:<p role="status">正在读取用量…</p>}</article>;
}
