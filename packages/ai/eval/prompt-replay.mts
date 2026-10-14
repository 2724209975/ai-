/** No database/platform imports; private candidate export is opt-in and never stdout. */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createFakeIntelligencePort } from '../index.mts';
import { FakeCandidateGateway } from '../generation/fake-provider.mts';
import { buildPrompt } from '../generation/deepseek-provider.mts';
import { createDeepSeekFromEnv } from '../generation/deepseek-env.mts';
import { candidatePromptVersion, CANDIDATE_PROMPTS, type CandidatePromptVersion } from '../generation/prompt-versions.mts';
import { createTextCandidateGateway, type TextModelProvider } from '../generation/text-provider-contract.mts';
import { prepareReplyForOrchestration } from '../strategy/orchestration-handoff.mts';
import { prepareReplaySamples } from './replay-samples.mts';

export type ReplayOptions = { versions: [CandidatePromptVersion, CandidatePromptVersion]; provider: 'fake' | 'deepseek'; allowPaid?: boolean; maxCalls?: number; maxTokens?: number };
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
export function replayOptions(args: string[]) {
  const options = new Map<string, string>(); let allowPaid = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--allow-paid' && !allowPaid) { allowPaid = true; continue; }
    if (!['--samples', '--versions', '--provider', '--max-calls', '--max-tokens', '--private-candidates'].includes(key) || options.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('REPLAY_ARGUMENT_INVALID');
    options.set(key, args[++i]!);
  }
  if (!options.has('--samples')) throw new Error('REPLAY_ARGUMENT_INVALID');
  const versions = (options.get('--versions') ?? CANDIDATE_PROMPTS.slice(-2).join(',')).split(',').map(candidatePromptVersion);
  if (versions.length !== 2 || versions[0] === versions[1]) throw new Error('REPLAY_VERSION_INVALID');
  const provider = options.get('--provider') ?? 'fake';
  if (provider !== 'fake' && provider !== 'deepseek') throw new Error('REPLAY_PROVIDER_INVALID');
  const maxCalls = options.has('--max-calls') ? Number(options.get('--max-calls')) : undefined, maxTokens = options.has('--max-tokens') ? Number(options.get('--max-tokens')) : undefined;
  if ((maxCalls !== undefined && !positive(maxCalls)) || (maxTokens !== undefined && !positive(maxTokens))) throw new Error('REPLAY_BUDGET_INVALID');
  if (provider === 'deepseek' && (!allowPaid || !positive(maxCalls) || !positive(maxTokens))) throw new Error('REPLAY_PAID_AUTH_REQUIRED');
  return { samplesPath: options.get('--samples')!, privatePath: options.get('--private-candidates'), versions: versions as [CandidatePromptVersion, CandidatePromptVersion], provider, allowPaid, maxCalls, maxTokens };
}
export async function replayPrompts(raw: unknown, options: ReplayOptions, realFactory?: (version: CandidatePromptVersion) => TextModelProvider) {
  const prepared = prepareReplaySamples(raw);
  if (!['fake', 'deepseek'].includes(options.provider)) throw new Error('REPLAY_PROVIDER_INVALID');
  if (options.versions.length !== 2 || options.versions[0] === options.versions[1]) throw new Error('REPLAY_VERSION_INVALID');
  options.versions.forEach(candidatePromptVersion);
  const paid = options.provider === 'deepseek';
  if (paid && (!options.allowPaid || !prepared.externalAuthorized || !positive(options.maxCalls) || !positive(options.maxTokens) || !realFactory)) throw new Error('REPLAY_PAID_AUTH_REQUIRED');
  let calls = 0, tokens = 0, reportedTokens = 0, usageComplete = true;
  const privateCandidates: { sample: number; promptVersion: string; alternatives: unknown }[] = [];
  const rows = [];
  for (const [i, sample] of prepared.samples.entries()) {
    const comparisons = [];
    for (const version of options.versions) {
      const model = paid ? realFactory!(version) : {
        providerId: 'fake', modelId: 'deterministic', modelVersion: '1', promptVersion: version, dataRegion: 'local', retentionPolicy: 'memory-only',
        async invoke(input: Parameters<TextModelProvider['invoke']>[0]) {
          buildPrompt(input.context, input.decision, input.policy, version); // Exercise the registered template without a network call.
          return { alternatives: await new FakeCandidateGateway().generate() };
        },
      } satisfies TextModelProvider;
      if (model.promptVersion !== version) throw new Error('REPLAY_VERSION_MISMATCH');
      const guarded: TextModelProvider = { ...model, async invoke(input) {
        if (paid && (calls >= options.maxCalls! || tokens >= options.maxTokens!)) throw new Error('REPLAY_BUDGET_EXHAUSTED');
        calls++;
        try {
          const result = await model.invoke(input);
          if (paid) {
            const usage = result.usage;
            if (usage && Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens) && usage.inputTokens! >= 0 && usage.outputTokens! >= 0) {
              tokens += usage.inputTokens! + usage.outputTokens!; reportedTokens += usage.inputTokens! + usage.outputTokens!;
            } else { tokens = options.maxTokens!; usageComplete = false; }
          }
          return result;
        } catch (error) { if (paid) { tokens = options.maxTokens!; usageComplete = false; } throw error; }
      } };
      const result = await prepareReplyForOrchestration(createFakeIntelligencePort(createTextCandidateGateway(guarded)), structuredClone(sample.context), structuredClone(sample.policy));
      const alternatives = result.ok ? result.value.proposal?.alternatives ?? [] : [];
      privateCandidates.push({ sample: i + 1, promptVersion: version, alternatives });
      comparisons.push({ promptVersion: version, status: result.ok ? alternatives.length ? 'checked_candidates' : 'no_reply' : result.error.code,
        alternativeCount: alternatives.length, partLengths: alternatives.map(a => a.parts.map(p => Array.from(p.content).length)), authorization: 'not_evaluated' });
    }
    rows.push({ sample: i + 1, excludedMessages: sample.excludedMessages, excludedFacts: sample.excludedFacts, comparisons });
  }
  return { report: { mode: 'replay', provider: options.provider, calls, reportedTokens: paid && usageComplete ? reportedTokens : null, budgetAccountedTokens: paid ? tokens : null, rows,
    limitation: paid ? 'Token admission is checked before calls; one response can exceed remaining budget. No sends or quality pass.' : 'Fake checks plumbing and cutoff; identical fake candidates do not prove prompt quality.' }, privateCandidates };
}
async function main() {
  const options = replayOptions(process.argv.slice(2));
  if ((await stat(options.samplesPath)).size > 2_000_000) throw new Error('REPLAY_SAMPLE_TOO_LARGE');
  const raw = JSON.parse(await readFile(options.samplesPath, 'utf8'));
  const result = await replayPrompts(raw, options, options.provider === 'deepseek' ? version => createDeepSeekFromEnv(process.env, { promptVersion: version, maxTokens: 256 }) : undefined);
  if (options.privatePath) await writeFile(options.privatePath, JSON.stringify({ mode: 'replay', ...result.report, candidates: result.privateCandidates }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { process.stderr.write('PROMPT_REPLAY_FAILED: check authorized deidentified samples, versions and explicit provider budget\n'); process.exitCode = 1; });
