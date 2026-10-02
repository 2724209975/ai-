/** Run with the workspace TypeScript compiler after apps/web dependencies are installed. */
import { resolve, sep } from 'node:path';
import ts from '../../../apps/web/node_modules/typescript/lib/typescript.js';

const root = resolve('packages/ai');
const entry = resolve(root, 'index.mts');
const program = ts.createProgram([entry, resolve(root, 'eval/trial-report.mts'), resolve(root, 'eval/trial-report-postgres.mts'), resolve(root, 'eval/prompt-replay.mts')], {
  noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true,
  module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
});
const own = ts.getPreEmitDiagnostics(program).filter(d => d.file?.fileName.startsWith(`${root}${sep}`));
if (own.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(own, {
    getCanonicalFileName: value => value,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else {
  process.stdout.write('04 source static check passed (strict, ES2023, actual 02 PersistentIntelligence type).\n');
}
