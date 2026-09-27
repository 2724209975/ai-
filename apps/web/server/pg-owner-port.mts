/** Bind 02/03 persistent Owner methods to the 06 HTTP surface after 07 authenticates the single
 * owner. 02 owns send eligibility and control state; 03 owns facts/media/analyses bodies.
 * Neither the platform adapter nor a raw cross-contact query is available from here.
 */
import type { PgConfirmedService } from '../../../packages/orchestration/postgres/confirmed-service.mts';
import type { PgOwnerDataPort, OwnerScope } from '../../../packages/data/postgres/owner-data-port.mts';
import type { OwnerPort } from './owner-http.mts';

export function createPgOwnerPort(service: PgConfirmedService, data: PgOwnerDataPort, configuredOwnerId: string): OwnerPort {
  if (!configuredOwnerId) throw new Error('OWNER_ID_REQUIRED');
  const owner = (id: string) => { if (id !== configuredOwnerId) throw new Error('FORBIDDEN'); };
  const scope = async (): Promise<OwnerScope> => ({ contactIds: await service.ownerContactIds() });
  return {
    async overview(ownerId) { owner(ownerId); return service.ownerOverview(); },
    async tasks(ownerId) { owner(ownerId); return service.ownerTasks(); },
    async contacts(ownerId) { owner(ownerId); return service.ownerContacts(); },
    async conversations(ownerId) { owner(ownerId); return service.ownerConversations(); },
    async facts(ownerId) { owner(ownerId); return data.listFacts(await scope()); },
    async analyses(ownerId) { owner(ownerId); return data.listAnalyses(await scope()); },
    async media(ownerId) { owner(ownerId); return data.listMedia(await scope()); },
    async audit(ownerId) { owner(ownerId); return data.listAudit(); },
    async confirm(ownerId, taskId, command) { owner(ownerId); return service.confirmTask(taskId, command); },
    async reject(ownerId, taskId, command) { owner(ownerId); return service.rejectTask(taskId, command); },
    async pauseAll(ownerId, command) { owner(ownerId); return service.pauseAll(command); },
    async resumeAll(ownerId, command) { owner(ownerId); return service.resumeAll(command); },
    async pauseContact(ownerId, contactId, command) { owner(ownerId); return service.pauseContact(contactId, command); },
    async resumeContact(ownerId, contactId, command) { owner(ownerId); return service.resumeContact(contactId, command); },
    async acknowledgePausedInbound(ownerId, contactId, command) { owner(ownerId); return service.acknowledgePausedInbound(contactId, command); },
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
