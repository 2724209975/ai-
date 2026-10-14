/** Trial preference evidence; it never approves a plan or attests that a message was sent. */
export type TrialFeedbackTask={taskId:string;taskVersion:number;contactId:string;planId:string;allowedActions:readonly string[];alternatives:readonly {alternativeId:string;parts:readonly {content:string}[]}[]};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A review hint, not proof of hallucination: the owner verifies actual current activities. */
export function qqTrialCurrentStateNeedsReview(text:string):boolean {
  return text.split(/[，。\n]/u).some(clause=>/^[\s]*(?:我)?(?:刚刚?|现在|正在|在|今天|今晚)?(?:忙完|吃了|吃过|吃饭|喝了|睡觉|发呆|上班|下班|加班|回家|到家|看电影|打游戏|开会|洗澡)/u.test(clause)&&!/(?:吗|么|嘛|了没|没有)[呀呢啊]?[？?]?$|[？?]$/u.test(clause.trim()));
}
export function prepareQqTrialFeedback(value:unknown,tasks:readonly TrialFeedbackTask[],selected:ReadonlySet<string>){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('VALIDATION_FAILED');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['taskId','contactId','version','alternativeId','rating','text','idempotencyKey'].includes(k))||
    ['taskId','contactId','alternativeId','idempotencyKey'].some(k=>typeof v[k]!=='string'||!uuid.test(v[k] as string))||
    !Number.isSafeInteger(v.version)||Number(v.version)<1||typeof v.rating!=='string'||!['usable','needs_edit','unsuitable'].includes(v.rating)||
    typeof v.text!=='string'||!v.text.trim()||v.text.length>4000)throw new Error('VALIDATION_FAILED');
  const task=tasks.find(t=>t.taskId===v.taskId&&t.contactId===v.contactId);
  if(!selected.has(String(v.contactId))||!task)throw new Error('FORBIDDEN');
  if(task.taskVersion!==v.version||!task.allowedActions.includes('confirmPlan'))throw new Error('CONFLICT_VERSION');
  const alternative=task.alternatives.find(a=>a.alternativeId===v.alternativeId);
  if(!alternative)throw new Error('VALIDATION_FAILED');
  const originalContent=alternative.parts.map(p=>p.content),original=originalContent.join('\n');
  const action=v.rating==='unsuitable'||v.rating==='needs_edit'&&v.text===original?'rejected':v.text===original?'selected':'edited';
  return {callerContactId:task.contactId,contactId:task.contactId,planId:task.planId,shownAlternativeIds:[alternative.alternativeId],
    action:action as 'selected'|'edited'|'rejected',originalContent,finalContent:action==='rejected'?[]:[v.text],
    reason:String(v.rating),rating:{trialOnly:true,qualityVote:v.rating,taskId:task.taskId,taskVersion:task.taskVersion,deliveryVerified:false,learnStyle:false},
    source:'owner' as const,idempotencyKey:String(v.idempotencyKey)};
}
