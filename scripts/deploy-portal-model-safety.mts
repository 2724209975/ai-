/** Upgrade only model admission in the older portal; preserve its advisor features and migration lineage. */
import {readFile,writeFile,copyFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const release=resolve('.local-workspace-release');
const {backup}=JSON.parse(await readFile('output/android/deployment-backup-current.json','utf8'));
await access(join(backup,'backup.json'));
try {await access(join(release,'.local-launch/running.json'));throw new Error('PORTAL_MUST_BE_STOPPED');}
catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const factoryFile=join(release,'packages/ai/generation/deepseek-env.mts');
let factory=await readFile(factoryFile,'utf8');
if(!factory.includes('unifiedMoneyFromEnv')) {
 const original=await readFile(join(backup,'daily-code/packages/ai/generation/deepseek-env.mts'),'utf8');
 if(factory!==original)throw new Error('PORTAL_SOURCE_CHANGED_AFTER_BACKUP');
 const start=factory.indexOf('  // Every composition root gets the same guard:');
 const end=factory.indexOf('\n}',start);
 if(start<0||end<0||!factory.slice(start,end).includes('return withDailyBudget(provider, daily);'))throw new Error('PORTAL_MODEL_FACTORY_UNRECOGNIZED');
 factory=factory.replace("import { withSharedBudget } from './persistent-budget.mts';","import { unifiedMoneyFromEnv } from './unified-budget.mts';");
 const a=factory.indexOf('  // Every composition root gets the same guard:');const b=factory.indexOf('\n}',a);
 factory=factory.slice(0,a)+`  const daily = withDailyBudget(provider, budgetOptionsFromEnv(env, budget.onRefusal));
  const money = unifiedMoneyFromEnv(env);
  return !money ? daily : {...daily, async invoke(input) {
    // Retain the deployed advisor's prompt version and inputs when calculating admission.
    const prompt = buildPrompt(input.context, input.decision, input.policy, provider.promptVersion);
    await money.reserve('generation', config.modelId, Buffer.byteLength(JSON.stringify(prompt), 'utf8') + 4096,
      overrides.maxTokens ?? config.maxTokens, {inputPerMillion: Number(env.DEEPSEEK_INPUT_CNY_PER_MILLION), outputPerMillion: Number(env.DEEPSEEK_OUTPUT_CNY_PER_MILLION)});
    return daily.invoke(input);
  }};`+factory.slice(b);
}
await copyFile('packages/ai/generation/unified-budget.mts',join(release,'packages/ai/generation/unified-budget.mts'));
await writeFile(factoryFile,factory);
for(const file of ['scripts/local-portal-model.mts','scripts/local-portal-model.test.mts'])await copyFile(file,join(release,file));
console.log(JSON.stringify({updated:true,scope:'portal-model-admission-only',sha256:createHash('sha256').update(factory).digest('hex'),privateConfigChanged:false,ordinaryPortalStarted:false,automaticSend:false}));
