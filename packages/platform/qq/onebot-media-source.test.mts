import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createOneBotImageSource } from './onebot-media-source.mts';
import { png } from '../../../tests/fixtures/media-images.mts';

const raw = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 10001, user_id: 20002,
  message_id: 30001, time: 1790064000, message: [{ type: 'image', data: { file: 'bound-image-ref' } }] };
const pointer = { externalAccountRef: '10001', externalContactRef: '20002', platformMessageId: '30001',
  rawEventRef: 'fixture:private-raw', segmentIndex: 0, mediaKind: 'image' as const };

test('get_image is fixed, authenticated and bounded; only private local cache paths are read', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-image-source-'));
  try {
    const cache = join(root,'cache'); await mkdir(cache);
    const path = join(cache,'image.png'); await writeFile(path, png);
    const outside = join(root,'outside.png'); await writeFile(outside,png);
    const large = join(cache,'large.png'); await writeFile(large,Buffer.alloc(1025));
    const external = join(root,'external'); await mkdir(external); await writeFile(join(external,'image.png'),png);
    await symlink(external,join(cache,'escape'),'junction');
    for (const item of [
      { name:'complete cache file', path, ok:true },
      { name:'outside cache', path:outside }, { name:'junction escape',path:join(cache,'escape','image.png') },
      { name:'arbitrary URL',path:'https://example.invalid/private.png' }, { name:'file URL',path:`file://${path}` },
      { name:'relative path',path:'image.png' }, { name:'oversized file',path:large },
    ]) await t.test(item.name,async () => {
      let calls = 0;
      const source = createOneBotImageSource({ baseUrl:'http://127.0.0.1:1234/', accessToken:'fixture-token', selfId:'10001', cacheDir:cache,
        readRaw: async () => Buffer.from(JSON.stringify(raw)), fetchImpl: (async (url,init) => {
          calls++; assert.equal(String(url),'http://127.0.0.1:1234/get_image'); assert.equal(init?.redirect,'manual');
          assert.equal((init?.headers as Record<string,string>).authorization,'Bearer fixture-token');
          assert.deepEqual(JSON.parse(String(init?.body)),{file:'bound-image-ref'});
          return new Response(JSON.stringify({status:'ok',retcode:0,data:{file:item.path}}),{headers:{'content-type':'application/json'}});
        }) as typeof fetch });
      if (item.ok) assert.deepEqual(Buffer.from((await source.read(pointer,1024))!.bytes),png);
      else await assert.rejects(source.read(pointer,1024), /MEDIA_UNCERTAIN/);
      assert.equal(calls,1);
    });
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('pointer mismatch refuses any HTTP request, and the overall deadline includes raw loading', async () => {
  let calls = 0;
  const options = { baseUrl:'http://127.0.0.1:1234/',accessToken:'fixture-token',selfId:'10001',cacheDir:resolve('.local-wechat-spike'),
    readRaw: async () => Buffer.from(JSON.stringify(raw)), fetchImpl: (async () => { calls++; throw new Error('FORBIDDEN_FETCH'); }) as typeof fetch };
  const source = createOneBotImageSource(options);
  for (const patch of [{externalAccountRef:'99999'}, {externalContactRef:'29999'}, {platformMessageId:'39999'}, {segmentIndex:1}, {mediaKind:'voice' as const}])
    await assert.rejects(source.read({...pointer,...patch},1024),/POLICY_BLOCKED/);
  assert.equal(calls,0);
  const stalled = createOneBotImageSource({...options,timeoutMs:20,readRaw:async () => new Promise<Uint8Array>(()=>{})});
  await assert.rejects(stalled.read(pointer,1024),/MEDIA_UNCERTAIN/);
  assert.equal(calls,0);
});

test('redirects, invalid JSON, oversized replies and HTTP timeout expose only a fixed failure code', async () => {
  for (const kind of ['redirect','invalid','large','timeout']) {
    const source = createOneBotImageSource({ baseUrl:'http://127.0.0.1:1234/', accessToken:'fixture-token',selfId:'10001',
      cacheDir:resolve('.local-wechat-spike'), timeoutMs:40, readRaw:async()=>Buffer.from(JSON.stringify(raw)),
      fetchImpl:(async (_url,init) => {
        if(kind==='timeout') return new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('private endpoint')),{once:true}));
        return new Response(kind==='large'?'x'.repeat(70_000):'private invalid JSON', {status:kind==='redirect'?302:200,headers:{'content-type':'application/json'}});
      }) as typeof fetch });
    await assert.rejects(source.read(pointer,1024),{message:'MEDIA_UNCERTAIN'});
  }
});

test('raw image file identifiers cannot request arbitrary URL or filesystem paths from OneBot', async () => {
  let calls=0;
  for(const file of ['https://example.invalid/image.png','file:///private/image.png',resolve('.local-wechat-spike/image.png')]) {
    const source=createOneBotImageSource({baseUrl:'http://127.0.0.1:1234/',accessToken:'fixture-token',selfId:'10001',cacheDir:resolve('.local-wechat-spike'),
      readRaw:async()=>Buffer.from(JSON.stringify({...raw,message:[{type:'image',data:{file}}]})),
      fetchImpl:(async()=>{calls++;throw new Error('NO_REMOTE_PATH_REQUEST');}) as typeof fetch});
    await assert.rejects(source.read(pointer,1024),/MEDIA_UNCERTAIN/);
  }
  assert.equal(calls,0);
});
