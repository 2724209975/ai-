/** Only the explicitly selected review HTML is served on loopback; no model or send port. */
import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
const [file,stateFile,...extra]=process.argv.slice(2);
if(!file||!stateFile||extra.length)throw new Error('REVIEW_SERVER_ARGUMENT_INVALID');
const bytes=await readFile(file);if(bytes.length>5_000_000)throw new Error('REVIEW_PAGE_TOO_LARGE');
const token=randomBytes(24).toString('hex');
const server=createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  const path=new URL(req.url??'/','http://127.0.0.1').pathname;
  if(path==='/healthz'&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({kind:'local-blind-review',ready:true,platformCalls:0}));return;}
  if(path==='/stop'&&req.method==='POST'){const supplied=Buffer.from(req.headers['x-review-token']?.toString()??''),expected=Buffer.from(token);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(403);res.end();return;}res.end();server.close(()=>process.exit(0));return;}
  if(path!=='/'+token||!['GET','HEAD'].includes(req.method??'')){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.method==='HEAD'?undefined:bytes);
});
await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
const address=server.address();if(!address||typeof address==='string')throw new Error('REVIEW_LISTEN_FAILED');
await writeFile(stateFile,JSON.stringify({kind:'local-blind-review',pid:process.pid,url:`http://127.0.0.1:${address.port}/${token}`,port:address.port,token},null,2)+'\n',{flag:'wx',mode:0o600});
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>server.close(()=>process.exit(0)));
