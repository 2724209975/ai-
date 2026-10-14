/** Bind 02/03 persistent Owner methods to the 06 HTTP surface after 07 authenticates the single
 * owner. 02 owns send eligibility and control state; 03 owns facts/media/analyses bodies.
 * Neither the platform adapter nor a raw cross-contact query is available from here.
 */
import type { PgConfirmedService } from '../../../packages/orchestration/postgres/confirmed-service.mts';
import type { PgOwnerDataPort, OwnerScope } from '../../../packages/data/postgres/owner-data-port.mts';
import type { OwnerPort } from './owner-http.mts';
import {PeopleService} from '../../../packages/data/people/service.mts';

export function createPgOwnerPort(service: PgConfirmedService, data: PgOwnerDataPort, configuredOwnerId: string,peopleContacts?:()=>Promise<string[]>): OwnerPort {
  if (!configuredOwnerId) throw new Error('OWNER_ID_REQUIRED');
  const owner = (id: string) => { if (id !== configuredOwnerId) throw new Error('FORBIDDEN'); };
  const scope = async (): Promise<OwnerScope> => ({ contactIds: await service.ownerContactIds() });
  const people=new PeopleService(service.memory.pool,configuredOwnerId,peopleContacts??(()=>service.ownerContactIds()),service.memory.data);
  return {
    async people(id){owner(id);return people.list();},
    async peopleCommand(id,input){owner(id);return people.command(input);},
    async personHistory(id,personId,contactId,before){owner(id);return people.history(personId,contactId,before);},
    async historyPreview(id,input){owner(id);return people.preview(input);},
    async historyCommit(id,input){owner(id);return people.commit(input);},
    async personMemory(id,input){owner(id);return people.remember(input);},
    async personMessage(id,input){owner(id);return people.changeMessage(input);},
    async modelConfig(ownerId){owner(ownerId);return service.pipeline.models.read();},
    async modelUsage(ownerId){owner(ownerId);return service.pipeline.models.usage();},
    async updateModelConfig(ownerId,input){owner(ownerId);return service.pipeline.models.update(input);},
    async memoryControls(ownerId,id,input){owner(ownerId);return service.memory.controls(id,input);},
    async memories(ownerId,id){owner(ownerId);return service.memory.list(id);},
    async contextPreview(ownerId,id){owner(ownerId);return service.memory.preview(id);},
    async memoryCommand(ownerId,id,action,memoryId,input){owner(ownerId);return service.memory.command(id,action,memoryId,input);},
    async memoryProfile(ownerId,id,kind,input){owner(ownerId);return service.memory.profile(id,kind,input);},
    async replyJobs(ownerId, id) { owner(ownerId); return service.ownerReplyJobs(id); },
    async replyJob(ownerId, id, trace) { owner(ownerId); return service.ownerReplyJob(id,trace); },
    async setPipelineVersion(ownerId, id, input) { owner(ownerId); return service.setPipelineVersion(id,input); },
    async approveReplyJob(ownerId, id, input) { owner(ownerId); return service.approveReplyJob(id,input); },
    async cancelReplyJob(ownerId, id, input) { owner(ownerId); return service.cancelReplyJob(id,input); },
    async regenerateReplyJob(ownerId,id,input){owner(ownerId);return service.regenerateReplyJob(id,input);},
    async overview(ownerId) { owner(ownerId); return service.ownerOverview(); },
    async tasks(ownerId) { owner(ownerId); return service.ownerTasks(); },
    async contacts(ownerId) { owner(ownerId); return service.ownerContacts(); },
    async conversations(ownerId) { owner(ownerId); return service.ownerConversations(); },
    async workspaceList(ownerId, query) { owner(ownerId); return service.workspaceList(query); },
    async workspaceDetail(ownerId, id, before) { owner(ownerId); return service.workspaceDetail(id, before); },
    async resumeRoutine(ownerId, id, command) { owner(ownerId); return service.resumeRoutine(id, command); },
    async facts(ownerId) { owner(ownerId); return data.listFacts(await scope()); },
    async analyses(ownerId) { owner(ownerId); return data.listAnalyses(await scope()); },
    async media(ownerId) { owner(ownerId); return data.listMedia(await scope()); },
    async audit(ownerId) { owner(ownerId); return data.listAudit(); },
    async confirm(ownerId, taskId, command) { owner(ownerId); return service.confirmTask(taskId, command); },
    async present(ownerId, taskId, command) { owner(ownerId); return service.recordTaskPresentation(taskId, command); },
    async reject(ownerId, taskId, command) { owner(ownerId); return service.rejectTask(taskId, command); },
    async regenerate(ownerId, taskId, command) { owner(ownerId); return service.regenerateTask(taskId, command); },
    async pauseAll(ownerId, command) { owner(ownerId); return service.pauseAll(command); },
    async resumeAll(ownerId, command) { owner(ownerId); return service.resumeAll(command); },
    async pauseContact(ownerId, contactId, command) { owner(ownerId); return service.pauseContact(contactId, command); },
    async resumeContact(ownerId, contactId, command) { owner(ownerId); return service.resumeContact(contactId, command); },
    async acknowledgePausedInbound(ownerId, contactId, command) { owner(ownerId); return service.acknowledgePausedInbound(contactId, command); },
    async requestPausedReply(ownerId, contactId, command) { owner(ownerId); return service.requestPausedReply(contactId, command); },
    async resolveSend(ownerId, sendTaskId, command) { owner(ownerId); return service.resolveUnknownSend(sendTaskId, command); },
    async updatePolicy(ownerId, contactId, command) { owner(ownerId); return service.updatePolicy(contactId, command); },
    async changeFact(ownerId, factId, command) {
      owner(ownerId);
      return data.changeFact(await scope(), { factId, expectedVersion: command.expectedVersion, action: command.action, content: command.content, effectiveAt: command.effectiveAt });
    },
    async correctAnalysis(ownerId, analysisId, command) {
      owner(ownerId);
      return data.correctAnalysis(await scope(), { analysisId, expectedVersion: command.expectedVersion, correction: command.correction });
    },
    async setMediaApproval(ownerId, mediaId, command) {
      owner(ownerId);
      return data.setMediaApproval(await scope(), { mediaId, expectedVersion: command.expectedVersion, action: command.action, allowedPlatforms: command.allowedPlatforms });
    },
  };
}
