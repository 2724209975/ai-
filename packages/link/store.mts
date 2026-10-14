import { emptyLinkState, type LinkStore, type LinkState } from './types.mts';
import { withTransaction, type PgPool } from '../infrastructure/postgres/transaction.mts';
export class PgLinkStore implements LinkStore {
  private pool:PgPool;private ownerId:string;
  constructor(pool:PgPool,ownerId:string){this.pool=pool;this.ownerId=ownerId;}
  async read():Promise<LinkState> { return withTransaction(this.pool,async tx=>{const r=await tx.query<{body:LinkState}>('SELECT body FROM mobile_link_state WHERE owner_id=$1',[this.ownerId]); return r.rows[0]?.body ?? emptyLinkState();}); }
  async change<T>(fn:(s:LinkState)=>T):Promise<T> { return withTransaction(this.pool,async tx=>{
    await tx.query('INSERT INTO mobile_link_state(owner_id,body) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[this.ownerId,JSON.stringify(emptyLinkState())]);
    const r=await tx.query<{body:LinkState}>('SELECT body FROM mobile_link_state WHERE owner_id=$1 FOR UPDATE',[this.ownerId]);
    const state=r.rows[0].body; const result=fn(state);
    await tx.query('UPDATE mobile_link_state SET body=$2::jsonb,updated_at=now() WHERE owner_id=$1',[this.ownerId,JSON.stringify(state)]);return result;
  }); }
}
export class MemoryLinkStore implements LinkStore {
  state=emptyLinkState(); private tail:Promise<unknown>=Promise.resolve();
  async read(){await this.tail;return structuredClone(this.state);}
  change<T>(fn:(s:LinkState)=>T):Promise<T>{const task=this.tail.then(()=>{const s=structuredClone(this.state);const result=fn(s);this.state=s;return result;});this.tail=task.catch(()=>{});return task;}
}
