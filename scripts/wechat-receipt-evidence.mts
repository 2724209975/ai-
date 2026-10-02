/** Reads explicitly supplied private samples only. No network, database or writing capability. */
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { analyzeReceiptEvidence } from '../packages/platform/wechat/receipt-evidence.mts';

try {
  if (process.argv.length !== 3) throw new Error('INVALID_ARGUMENTS');
  const manifestPath = resolve(process.argv[2]!);
  async function bounded(path: string, limit: number) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('INVALID_SAMPLE');
    const bytes = await readFile(path); if (bytes.length > limit) throw new Error('INVALID_SAMPLE'); return bytes;
  }
  const manifest = JSON.parse((await bounded(manifestPath, 65_536)).toString('utf8'));
  const fields = ['schemaVersion', 'ownerAuthorized', 'declaredSource', 'selfRef', 'peerRef', 'expectedText', 'startAt', 'endAt', 'baselineFiles', 'observedFiles'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some(key => !fields.includes(key))
    || manifest.schemaVersion !== 1 || manifest.ownerAuthorized !== true || !['system', 'owner', 'control'].includes(manifest.declaredSource)) throw new Error('INVALID_MANIFEST');
  let totalBytes = 0;
  async function samples(paths: unknown) {
    if (!Array.isArray(paths) || paths.length > 500) throw new Error('INVALID_SAMPLES');
    const result: Buffer[] = [];
    for (const file of paths) {
      if (typeof file !== 'string' || !file || file.length > 512) throw new Error('INVALID_SAMPLE_PATH');
      const bytes = await bounded(resolve(dirname(manifestPath), file), 1_048_576); totalBytes += bytes.length;
      if (totalBytes > 16_777_216) throw new Error('SAMPLES_TOO_LARGE'); result.push(bytes);
    }
    return result;
  }
  const baseline = await samples(manifest.baselineFiles), observed = await samples(manifest.observedFiles);
  const result = analyzeReceiptEvidence({ selfRef: manifest.selfRef, peerRef: manifest.peerRef, expectedText: manifest.expectedText,
    startAt: manifest.startAt, endAt: manifest.endAt, baseline, observed });
  process.stdout.write(JSON.stringify({ ...result, declaredSource: manifest.declaredSource, sourceDeclarationVerified: false }) + '\n');
} catch { process.stderr.write('WECHAT_RECEIPT_EVIDENCE_FAILED\n'); process.exitCode = 1; }
