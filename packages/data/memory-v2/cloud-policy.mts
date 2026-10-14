import type {PgClient} from '../../infrastructure/postgres/transaction.mts';
import type {ModelRouteConfigV2} from '../../contracts/decision-v2.mts';
/** Existing separately authorized media/embedding ports keep working until an explicit v2 privacy setting exists. */
export async function cloudAllowedForContact(tx:PgClient,ownerId:string,contactId:string){
  await tx.query("SELECT set_config('app.memory_owner_id',$1,true)",[ownerId]);
  const row=(await tx.query<{config:ModelRouteConfigV2}>('SELECT config FROM ai_model_configs_v2 WHERE owner_id=$1',[ownerId])).rows[0];
  return !row||row.config.cloudAllowed&&(row.config.contactOverrides[contactId]?.cloudAllowed??true);
}
