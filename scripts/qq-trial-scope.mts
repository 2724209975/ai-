import {timingSafeEqual} from 'node:crypto';

type TrialContact={userId:string;displayName:string};
/** Resume may replace one explicitly named friend while retaining the other trial identities. */
export function qqTrialResumeContactsAllowed(before:readonly TrialContact[],after:readonly TrialContact[],replacement:unknown):boolean {
  // A later restart may retain the prior replacement metadata without changing scope again.
  if(before.length===after.length&&new Set(before.map(c=>c.userId)).size===before.length&&before.every((c,i)=>c.userId===after[i]?.userId&&c.displayName===after[i]?.displayName))return true;
  if(replacement===undefined)return false;
  if(!replacement||typeof replacement!=='object'||Array.isArray(replacement))return false;
  const r=replacement as Record<string,unknown>;
  if(r.ownerAuthorized!==true||typeof r.from!=='string'||typeof r.to!=='string'||r.from===r.to||before.length!==after.length)return false;
  if(new Set(before.map(c=>c.userId)).size!==before.length||new Set(after.map(c=>c.userId)).size!==after.length)return false;
  const removed=before.filter(c=>!after.some(n=>n.userId===c.userId)),added=after.filter(c=>!before.some(p=>p.userId===c.userId));
  return removed.length===1&&added.length===1&&removed[0]!.userId===r.from&&added[0]!.userId===r.to&&before.every(c=>c.userId===r.from||after.some(n=>n.userId===c.userId&&n.displayName===c.displayName));
}

/** Explicit owner opt-in for a receive-only candidate trial; special blocks remain intact. */
export function qqTrialContinuousResumeReasons(enabled:boolean,pauseReasons:readonly string[]):string[] {
  const allowed=['OWNER_ORIGIN','MEDIA_UNCERTAIN'];
  return enabled&&pauseReasons.length>0&&pauseReasons.every(reason=>allowed.includes(reason))?[...new Set(pauseReasons)]:[];
}

/** An exhaustive panel route list: candidate viewing and resuming after a manual reply. */
export function qqTrialPanelRoute(method:string|undefined,path:string,token:string,header:unknown):'page'|'data'|'resume'|'feedback'|'stop'|'refuse' {
  if(method==='GET'&&path==='/'+token)return 'page';
  if(method==='GET'&&path==='/'+token+'/data')return 'data';
  const supplied=Buffer.from(typeof header==='string'?header:''),expected=Buffer.from(token);
  if(method!=='POST'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return 'refuse';
  if(path==='/stop')return 'stop';
  if(path==='/'+token+'/resume')return 'resume';
  if(path==='/'+token+'/feedback')return 'feedback';
  return 'refuse';
}

/** Filter authenticated NapCat events before raw persistence; no platform actions. */
export function selectedQqTrialEvent(event:unknown,selfId:string,selected:ReadonlySet<string>,startedSeconds:number):boolean {
  if(!event||typeof event!=='object'||Array.isArray(event))return false;
  const e=event as Record<string,unknown>;
  if(String(e.self_id)!==selfId||!Number.isSafeInteger(e.time)||Number(e.time)<startedSeconds)return false;
  if(e.post_type==='message'&&e.message_type==='private')return selected.has(String(e.user_id));
  if(e.post_type==='message_sent'&&e.message_type==='private')return selected.has(String(e.target_id));
  return e.post_type==='notice'&&e.notice_type==='friend_recall'&&selected.has(String(e.user_id));
}
