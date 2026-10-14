/** Offline P6 artifacts. This command never opens a database or a network provider. */
import {readFile,stat,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {replayScenariosV2} from '../packages/ai/eval/scenario-replay-v2.mts';
const args=process.argv.slice(2);if(args.length>2)throw new Error('P6_ARGUMENT_INVALID');
const file=resolve(args[0]??'tests/fixtures/p6/chinese-scenarios-v2.json'),out=resolve(args[1]??'output/p6');
if((await stat(file)).size>5_000_000)throw new Error('P6_DATASET_TOO_LARGE');
const result=await replayScenariosV2(JSON.parse(await readFile(file,'utf8')));await mkdir(out,{recursive:true});
await writeFile(resolve(out,'replay.json'),JSON.stringify(result.report,null,2)+'\n');
// Unique packs avoid silently overwriting a previous human review's answer key.
const stamp=Date.now();await writeFile(resolve(out,`blind-pack-${stamp}.json`),JSON.stringify(result.blind.pack,null,2)+'\n',{flag:'wx',mode:0o600});
await writeFile(resolve(out,`blind-key-${stamp}.json`),JSON.stringify(result.blind.key,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({scenarios:result.report.scenarios,passed:result.report.passed,failed:result.report.failed,externalCalls:0,platformCalls:0,report:resolve(out,'replay.json')}));
if(result.report.failed)process.exitCode=1;
