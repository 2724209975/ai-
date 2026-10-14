/** Offline human review aggregator; never generates or guesses votes. */
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scoreBlindRatings,type blindPack} from '../packages/ai/eval/acceptance-v2.mts';
const [packPath,keyPath,ratingsPath,...extra]=process.argv.slice(2);if(!packPath||!keyPath||!ratingsPath||extra.length)throw new Error('P6_BLIND_ARGUMENT_INVALID');
const load=async(path:string)=>{if((await stat(path)).size>5_000_000)throw new Error('P6_BLIND_FILE_TOO_LARGE');return JSON.parse(await readFile(path,'utf8'));};
const pack=await load(packPath),key:ReturnType<typeof blindPack>['key']=await load(keyPath),ratings=await load(ratingsPath);
if(pack.schemaVersion!==1||key.schemaVersion!==1||!Array.isArray(pack.items)||!Array.isArray(key.items)||!Array.isArray(ratings)||pack.items.length!==key.items.length)throw new Error('INVALID_BLIND_PACK');
for(const item of key.items){const publicItem=pack.items.find((p:{sampleId:string})=>p.sampleId===item.sampleId);if(!publicItem||createHash('sha256').update(JSON.stringify(publicItem)).digest('hex')!==item.itemHash)throw new Error('INVALID_BLIND_PACK');}
console.log(JSON.stringify(scoreBlindRatings(key,ratings),null,2));
