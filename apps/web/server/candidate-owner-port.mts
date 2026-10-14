/** Selected-contact workbench. Sending is refused at the server, including direct API calls. */
import {qqTrialCurrentStateNeedsReview} from '../../../scripts/qq-trial-feedback.mts';
import type {OwnerPort} from './owner-http.mts';
import type {PgOwnerDataPort} from '../../../packages/data/postgres/owner-data-port.mts';
import type {TrialQualitySave,TrialQualityApply} from '../../../packages/contracts/trial-model-settings.mts';

export function createCandidateOwnerPort(options:{base:OwnerPort;data:PgOwnerDataPort;
  ownerId:string;contacts:readonly {contactId:string;conversationId:string}[];
  jobContact(id:string):Promise<string|null>;runtime():unknown;
  economySettings?:{read():Promise<unknown>;save(input:TrialQualitySave):Promise<unknown>;apply(input:TrialQualityApply):Promise<unknown>};
  qualitySettings?:{read():Promise<unknown>;save(input:TrialQualitySave):Promise<unknown>;apply(input:TrialQualityApply):Promise<unknown>}}) : OwnerPort {
  const {base,data}=options, contacts=new Set(options.contacts.map(c=>c.contactId)), conversations=new Set(options.contacts.map(c=>c.conversationId));
  const owner=(id:string)=>{if(id!==options.ownerId)throw new Error('FORBIDDEN');};
  const contact=(id:string)=>{if(!contacts.has(id))throw new Error('FORBIDDEN');};
  const conversation=(id:string)=>{if(!conversations.has(id))throw new Error('FORBIDDEN');};
  const refused=async()=>{throw new Error('FORBIDDEN');};
  const task=(row:any)=>({...row,candidateOnly:true,alternatives:row.alternatives?.map((a:any)=>({...a,requiresCurrentStateReview:qqTrialCurrentStateNeedsReview(a.parts.map((p:any)=>p.content??'').join('\n'))})),allowedActions:row.allowedActions.filter((a:string)=>a!=='confirmPlan').concat(row.allowedActions.includes('confirmPlan')?['copyCandidate']:[])});
  const selected=(rows:{items:unknown[]})=>({items:rows.items.filter((r:any)=>contacts.has(r.contactId??r.id))});
  const taskScope=async(ownerId:string,id:string)=>{owner(ownerId);const row=(await base.tasks(ownerId)).items.find((r:any)=>r.taskId===id) as any;if(!row)throw new Error('NOT_FOUND');contact(row.contactId);};
  const jobScope=async(ownerId:string,id:string)=>{owner(ownerId);const c=await options.jobContact(id);if(!c)throw new Error('NOT_FOUND');contact(c);};
  const scope={contactIds:[...contacts]};
  return {
    async people(id){owner(id);return base.people!(id);},
    async peopleCommand(id,input){owner(id);return base.peopleCommand!(id,input);},
    async personHistory(id,p,c,before){owner(id);return base.personHistory!(id,p,c,before);},
    async historyPreview(id,input){owner(id);return base.historyPreview!(id,input);},
    async historyCommit(id,input){owner(id);return base.historyCommit!(id,input);},
    async personMemory(id,input){owner(id);return base.personMemory!(id,input);},
    async personMessage(id,input){owner(id);return base.personMessage!(id,input);},
    ...(options.economySettings?{
      async trialEconomySettings(id:string){owner(id);return options.economySettings!.read();},
      async saveTrialEconomySettings(id:string,input:TrialQualitySave){owner(id);return options.economySettings!.save(input);},
      async applyTrialEconomySettings(id:string,input:TrialQualityApply){owner(id);return options.economySettings!.apply(input);}
    }:{}),
    ...(options.qualitySettings?{
      async trialQualitySettings(id:string){owner(id);return options.qualitySettings!.read();},
      async saveTrialQualitySettings(id:string,input:TrialQualitySave){owner(id);return options.qualitySettings!.save(input);},
      async applyTrialQualitySettings(id:string,input:TrialQualityApply){owner(id);return options.qualitySettings!.apply(input);}
    }:{}),
    async overview(id){owner(id);const result=await base.overview(id) as any;const tasks=selected(await base.tasks(id)).items as any[];
      return {...result,pendingCount:tasks.filter(t=>t.allowedActions.includes('confirmPlan')).length,unknownSendCount:0,candidateRuntime:options.runtime()};},
    async tasks(id){owner(id);return {items:selected(await base.tasks(id)).items.map(task)};},
    async contacts(id){owner(id);return selected(await base.contacts(id));},
    async conversations(id){owner(id);return selected(await base.conversations(id));},
    async workspaceList(id,query){owner(id);const offset=Number(query.cursor??'0'),limit=query.limit??50;
      if(!/^\d{1,8}$/.test(query.cursor??'0')||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('VALIDATION_FAILED');
      const items:any[]=[];let cursor:string|null='0';
      do{const page=await base.workspaceList!(id,{...query,limit:100,cursor}) as any;items.push(...page.items.filter((r:any)=>contacts.has(r.contactId)));cursor=page.nextCursor;}while(cursor!==null);
      return {items:items.slice(offset,offset+limit),total:items.length,nextCursor:offset+limit<items.length?String(offset+limit):null,candidateOnly:true,runtime:options.runtime()};},
    async workspaceDetail(id,c,before){owner(id);conversation(c);const result=await base.workspaceDetail!(id,c,before) as any;return {...result,candidateOnly:true,runtime:options.runtime(),tasks:result.tasks.map(task)};},
    async facts(id){owner(id);return data.listFacts(scope);},
    async analyses(id){owner(id);return data.listAnalyses(scope);},
    async media(id){owner(id);return data.listMedia(scope);},
    async audit(id){owner(id);return {items:(await base.audit(id)).items.filter((r:any)=>contacts.has(r.contactId))};},
    async modelConfig(id){owner(id);return base.modelConfig!(id);},
    async modelUsage(id){owner(id);return base.modelUsage!(id);},
    async memories(id,c){owner(id);conversation(c);return base.memories!(id,c);},
    async contextPreview(id,c){owner(id);conversation(c);return base.contextPreview!(id,c);},
    async memoryControls(id,c,input){owner(id);conversation(c);return base.memoryControls!(id,c,input);},
    async memoryCommand(id,c,action,memoryId,input){owner(id);conversation(c);return base.memoryCommand!(id,c,action,memoryId,input);},
    async memoryProfile(id,c,kind,input){owner(id);conversation(c);return base.memoryProfile!(id,c,kind,input);},
    async replyJobs(id,c){owner(id);conversation(c);return base.replyJobs!(id,c);},
    async replyJob(id,job,trace){await jobScope(id,job);return base.replyJob!(id,job,trace);},
    async cancelReplyJob(id,job,input){await jobScope(id,job);return base.cancelReplyJob!(id,job,input);},
    async regenerateReplyJob(id,job,input){await jobScope(id,job);return base.regenerateReplyJob!(id,job,input);},
    async present(id,t,input){await taskScope(id,t);return base.present(id,t,input);},
    async reject(id,t,input){await taskScope(id,t);return base.reject(id,t,input);},
    async regenerate(id,t,input){await taskScope(id,t);return base.regenerate(id,t,input);},
    async pauseContact(id,c,input){owner(id);contact(c);return base.pauseContact(id,c,input);},
    async resumeContact(id,c,input){owner(id);contact(c);return base.resumeContact(id,c,input);},
    async resumeRoutine(id,c,input){owner(id);contact(c);return base.resumeRoutine!(id,c,input);},
    async acknowledgePausedInbound(id,c,input){owner(id);contact(c);return base.acknowledgePausedInbound(id,c,input);},
    async requestPausedReply(id,c,input){owner(id);contact(c);return base.requestPausedReply(id,c,input);},
    async pauseAll(id,input){owner(id);return base.pauseAll(id,input);},
    async resumeAll(id,input){owner(id);return base.resumeAll(id,input);},
    // No approval, send-resolution, provider, pipeline or outbound-asset mutation in this runtime.
    confirm:refused,approveReplyJob:refused,resolveSend:refused,updatePolicy:refused,
    updateModelConfig:refused,setPipelineVersion:refused,changeFact:refused,correctAnalysis:refused,setMediaApproval:refused,
  };
}
