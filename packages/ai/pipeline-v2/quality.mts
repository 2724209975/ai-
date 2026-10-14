import { checkFakeReply } from '../checks/reply-check.mts';
import type { ScopedContext,PolicyProjection,ReplyDecision,ReplyAlternativeProposal } from '../types.mts';
import type { QualityResultV2 } from '../../contracts/decision-v2.mts';
import {factContextV2} from './providers.mts';
/** Rendering changes punctuation/emoji only. It never adds facts, questions or promises. */
export function renderStyleV2(context: ScopedContext, alternatives: ReplyAlternativeProposal[]): ReplyAlternativeProposal[] {
  const settings = context.contextPackageV2?.personalStyle?.settings ?? {};
  const statistics=context.contextPackageV2?.personalStyle?.statistics;
  const fewerPeriods=settings.punctuation==='none'||settings.punctuation==='少标点'||settings.punctuation===undefined&&Number(statistics?.sampleSize)>=10&&typeof statistics?.periodEndingRate==='number'&&statistics.periodEndingRate<.2;
  return alternatives.map(a=>({...a,parts:a.parts.map(p=>{
    let content=p.content.trim();if(settings.emoji==='none'||settings.emoji==='不使用')content=content.replace(/\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*(?:\u200D\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*)*/gu,'').trim();if(fewerPeriods)content=content.replace(/。$/u,'');
    return {...p,content};
  })}));
}
export function evaluateQualityV2(context:ScopedContext,policy:PolicyProjection,decision:ReplyDecision,alternatives:ReplyAlternativeProposal[],maxCharacters:number): QualityResultV2[] {
  const incoming=context.messages.filter(m=>context.contextPackageV2?context.contextPackageV2.triggerMessageIds.includes(m.id):m.actor==='contact').map(m=>m.text??'').join('\n');
  const asksAI=/AI|人工智能|机器人|机器回复/iu.test(incoming);
  const styles=['natural','playful','direct'] as const;
  const settings=context.contextPackageV2?.personalStyle?.settings??{};
  return alternatives.map((a,i)=>{
    const checked=checkFakeReply(factContextV2(context),policy,decision,a.parts);
    if(!checked.ok)throw new Error(checked.error.code);
    const text=a.parts.map(p=>p.content).join('\n');const reasons=[...checked.value.factIssues,...checked.value.styleIssues,...checked.value.confirmationReasons];
    let status=checked.value.status;
    const block=(reason:string)=>{status='blocked';reasons.push(reason);};
    if([...text].length>maxCharacters)block('REPLY_TOO_LONG');
    if(asksAI&&/(不是|没有用|没用|不用|哪有).{0,12}(AI|人工智能|机器人)|纯手打|都是我自己写/iu.test(text))block('AI_DENIAL');
    if(/(?:他|她)本人.{0,8}(?:确认|点头|批准)|(?:等|等待|得等|必须|需要|得|须|要).{0,4}本人.{0,6}(?:确认|点头|看|过一眼)|(?:审批|发送权限|自动发送).{0,12}(?:关不了|关不掉|改不了|没法.{0,4}关|不能.{0,4}关|关闭|跳过|开启|启用)|本人.{0,6}(?:确认|点头).{0,8}(?:才能|才会|才可).{0,4}(?:回|答|发)/u.test(text))block('INTERNAL_WORKFLOW_DISCLOSURE');
    if(/(?:不能|没法|无法|不会).{0,4}(?:替|代)(?:他|她|本人).{0,4}(?:发|回)|(?:得|等|需要).{0,4}(?:他|她)本人.{0,5}(?:来|说|发)/u.test(text))block('ASSISTANT_SPEAKER_ROLE');
    if(/(?:我|给你|帮你).{0,12}(?:转账|借你|付[款钱]|打款|身份证|验证码|密码)|(?:我|我们).{0,8}(?:答应|保证|一定|永远).{0,16}(?:见|去|来|结婚|爱|陪|负责)/u.test(text))block('UNCONFIRMED_SENSITIVE_ACTION');
    if(/我.{0,5}(?:住在|地址是|身份证|电话是|银行卡|密码是)/u.test(text))block('PRIVATE_DISCLOSURE');
    const allMemories=[...(context.contextPackageV2?.memories??[]),...(context.contextPackageV2?.personBackground?.memories??[])];
    const ownerSources=[...context.messages.filter(m=>m.actor==='owner'&&!m.isAgentGenerated&&m.mode==='live').map(m=>m.text??''),...allMemories.filter(m=>m.subject==='owner'&&m.status==='active').map(m=>m.content)];
    if(allMemories.some(m=>m.memoryType==='boundary'&&/不要问.*(?:地址|住址)|不透露.*(?:地址|住址)/u.test(m.content))&&/你.*(?:住哪|住在哪里|住哪里|地址|住址)/u.test(text))block('PERSON_BOUNDARY_VIOLATION');
    const claims=text.match(/我(?:的生日(?:是|在)?|今年\d|\d{1,3}岁|在[^，。！？\n]{1,25}工作|毕业于|来自|喜欢(?:吃|喝|玩|打|跑|旅行))[^，。！？\n]{0,50}/gu)??[];
    for(const claim of claims)if(!ownerSources.some(s=>s.replace(/\s/gu,'').includes(claim.replace(/\s/gu,'').replace(/[呀啊哦呢]+$/u,''))))block('UNSUPPORTED_OWNER_FACT');
    const avoided=Array.isArray(settings.avoid)?settings.avoid:[];
    if(avoided.some(s=>typeof s==='string'&&s&&text.includes(s))){reasons.push('EXPLICIT_STYLE_AVOID');if(status==='passed')status='review_required';}
    if((settings.length==='short'||settings.length==='简短')&&[...text].length>80){reasons.push('EXPLICIT_SHORT_STYLE');if(status==='passed')status='review_required';}
    if(/误会|生气|难过|委屈|你根本/u.test(incoming)&&/别矫情|小题大做|活该|你太敏感/u.test(text))block('DISRESPECTFUL_TONE');
    if(decision.riskCategories.length&&status==='passed')status='review_required';
    return {candidateKey:a.clientAlternativeKey,style:styles[i]??'natural',status,reasons:[...new Set(reasons)],evidenceMessageIds:context.contextPackageV2?.triggerMessageIds??[],checkerVersion:'quality-v2.2',needsUserApproval:true};
  });
}
