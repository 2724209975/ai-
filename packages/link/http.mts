import type { IncomingMessage,ServerResponse } from 'node:http';
import QRCode from 'qrcode';
import type { OwnerAuthService } from '../infrastructure/auth/owner-auth.mts';
import type { LinkService } from './service.mts';
import type { LinkProfile,LinkGroup,LinkEvidenceSource } from './types.mts';
import type {LinkBudgetPort} from './budget.mts';
export async function readLinkBody(req:IncomingMessage){let size=0;const chunks:Buffer[]=[];for await(const c of req){size+=c.length;if(size>3_000_000)throw new Error('PAYLOAD_TOO_LARGE');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString());}
const send=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
export function linkHttp(service:LinkService,auth:OwnerAuthService,options:{endpoint:string;fingerprint:string;contacts:()=>Promise<{items:any[]}>;refresh?:()=>Promise<void>;budget?:LinkBudgetPort;evidence?:(group:LinkGroup,recordId:string)=>Promise<{memoryId:string;memoryVersion:number;sources:LinkEvidenceSource[]}>;remember?:(group:LinkGroup,input:any)=>Promise<unknown>}){
  const failures=new Map<string,{n:number;until:number}>();
  return async(req:IncomingMessage,res:ServerResponse,owner:boolean)=>{
    const url=new URL(req.url??'/','http://localhost');const path=url.pathname;
    if(!path.startsWith(owner?'/api/v1/mobile-link':'/link/v1/'))return false;
    try {let deviceId='';
      if(owner){const session=await auth.authenticateRequest(req);if(!session)throw new Error('UNAUTHORIZED');if(req.method!=='GET'&&!auth.verifyWrite(req,session))throw new Error('FORBIDDEN');}
      else if(path!=='/link/v1/pair'){const token=req.headers.authorization?.replace(/^Bearer /,'')??'';deviceId=await service.authenticate(token);}
      if(owner&&path==='/api/v1/mobile-link/evidence'&&req.method==='GET'){
        const group=(await service.store.read()).groups.find(g=>g.id===url.searchParams.get('groupId')&&!g.deleted),recordId=url.searchParams.get('recordId')??'';
        if(!group||!options.evidence||!group.records[recordId]||group.records[recordId].deleted||group.records[recordId].kind!=='memory_v2')throw new Error('NOT_FOUND');
        if(!group.contactId||!(await options.contacts()).items.some(c=>c.id===group.contactId))throw new Error('FORBIDDEN');
        send(res,200,await options.evidence(group,recordId));return true;
      }
      if(owner&&path==='/api/v1/mobile-link'&&req.method==='GET'){await options.refresh?.();const s=await service.store.read();const contacts=(await options.contacts()).items.map(x=>({id:x.id,name:x.displayName??x.name??'未命名',platform:x.platform??'电脑会话'}));send(res,200,{enabled:true,budget:await options.budget?.view()??null,devices:s.devices.map(({tokenHash,...d})=>d),groups:s.groups.filter(g=>!g.deleted),contacts});return true;}
      if(!owner&&path==='/link/v1/budget'&&req.method==='GET'){send(res,200,await options.budget?.view(deviceId)??{supported:false});return true;}
      if(!owner&&path==='/link/v1/usage'&&req.method==='POST'){if(!options.budget)throw new Error('BUDGET_UNAVAILABLE');send(res,200,await options.budget.report(deviceId,await readLinkBody(req)));return true;}
      if(owner&&path==='/api/v1/mobile-link/allowance'&&req.method==='POST'){if(!options.budget)throw new Error('BUDGET_UNAVAILABLE');const b=await readLinkBody(req);send(res,200,await options.budget.allocate(b.deviceId,b.limitMicroCny));return true;}
      if(owner&&path==='/api/v1/mobile-link/invite'&&req.method==='POST'){const code=await service.invite();const payload=JSON.stringify({protocol:1,endpoint:options.endpoint,fingerprint:options.fingerprint,code});send(res,200,{qr:await QRCode.toDataURL(payload,{errorCorrectionLevel:'M',width:360}),payload,expiresAt:Date.now()+120000});return true;}
      if(!owner&&path==='/link/v1/pair'&&req.method==='POST'){const address=req.socket.remoteAddress??'unknown';const f=failures.get(address);if(f&&f.n>=10&&f.until>Date.now())throw new Error('RATE_LIMITED');const b=await readLinkBody(req);try{send(res,200,await service.pair(b.code,b.name));failures.delete(address);}catch(e){const x=f&&f.until>Date.now()?f:{n:0,until:Date.now()+120000};x.n++;failures.set(address,x);throw e;}return true;}
      if(!owner&&path==='/link/v1/contacts'&&req.method==='GET'){const c=await options.contacts();send(res,200,{items:c.items.map(x=>({id:x.id,name:x.displayName??x.name??'未命名',platform:x.platform??'电脑会话'}))});return true;}
      if(!owner&&path==='/link/v1/bind'&&req.method==='POST'){const b=await readLinkBody(req);if(b.contactId!==null&&!(await options.contacts()).items.some(c=>c.id===b.contactId))throw new Error('FORBIDDEN');send(res,200,await service.bind(deviceId,b.archiveId,b.profile,b.contactId));return true;}
      const group=/^\/link\/v1\/groups\/([^/]+)\/(sync|unbind|resolve|delete)$/.exec(path);
      if(!owner&&group&&req.method==='POST'){const b=await readLinkBody(req);if(group[2]==='sync'){await service.sync(deviceId,group[1],b.operations,b.after,b.historyCorrections??false,b.resetRevision??0,b.personChannels??false);await options.refresh?.();send(res,200,await service.sync(deviceId,group[1],[],b.after,b.historyCorrections??false,b.resetRevision??0,b.personChannels??false));}else if(group[2]==='delete'){await service.deleteGroup(deviceId,group[1]);await options.refresh?.();send(res,200,{ok:true});}else if(group[2]==='unbind'){await service.unbind(deviceId,group[1]);send(res,200,{ok:true});}else{if(!(await service.store.read()).groups.some(g=>g.id===group[1]&&g.deviceId===deviceId))throw new Error('FORBIDDEN');send(res,200,await service.resolve(group[1],b.recordId,b.side,b.expectedVersion));}return true;}
      if(owner&&['/api/v1/mobile-link/message','/api/v1/mobile-link/remember'].includes(path)&&req.method==='POST'){
        const b=await readLinkBody(req);await options.refresh?.();const g=(await service.store.read()).groups.find(g=>g.id===b.groupId&&!g.deleted);if(!g)throw new Error('NOT_FOUND');
        if(!g.contactId||!(await options.contacts()).items.some(c=>c.id===g.contactId))throw new Error('FORBIDDEN');
        const result=path.endsWith('/message')?await service.correctMessage(g.id,b.recordId,b.expectedVersion,b.message):options.remember?await options.remember(g,b):(()=>{throw new Error('NOT_FOUND');})();
        await options.refresh?.();send(res,200,result);return true;
      }
      if(owner&&req.method==='POST'){const b=await readLinkBody(req);if(path==='/api/v1/mobile-link/revoke'){await service.revoke(b.deviceId);send(res,200,{ok:true});return true;}if(path==='/api/v1/mobile-link/profile'){send(res,200,await service.desktopUpdate(b.groupId,[{id:'profile',kind:'profile',body:b.profile as LinkProfile,expectedVersion:b.expectedVersion,deleted:false}]));return true;}if(path==='/api/v1/mobile-link/resolve'){send(res,200,await service.resolve(b.groupId,b.recordId,b.side,b.expectedVersion));return true;}}
      send(res,404,{code:'NOT_FOUND'});
    }catch(e){const code=e instanceof Error?e.message:'LINK_FAILED';const safe=['UNAUTHORIZED','FORBIDDEN','NOT_FOUND','PAIR_EXPIRED','ALREADY_LINKED','RATE_LIMITED','STALE_VERSION'].includes(code)?code:'INVALID_REQUEST';send(res,safe==='UNAUTHORIZED'?401:safe==='FORBIDDEN'?403:safe==='NOT_FOUND'?404:safe==='RATE_LIMITED'?429:safe==='STALE_VERSION'?409:400,{code:safe,message:safe});}return true;
  };
}
