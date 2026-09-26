/** Offline only. Inputs are private; stdout contains only aggregate counts. */
import { readdir, readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createWxOriginAudit } from '../packages/platform/wechat/origin-audit.mts';

try {
  const root = process.argv[2];
  if (!root) throw new Error('MISSING_ROOT');
  const audit = createWxOriginAudit({ selfRef: process.env.WECHAT_SELF_REF ?? '',
    peerRef: process.env.WECHAT_SPIKE_PEER ?? '', marker: process.env.WECHAT_AUDIT_MARKER ?? '' });
  let skipped = 0;
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) { skipped++; return; }
    if (stat.isDirectory()) {
      for (const item of await readdir(path)) await visit(join(path, item));
    } else if (stat.isFile() && path.endsWith('.bin')) {
      if (stat.size > 1_048_576) { skipped++; return; }
      audit.add(await readFile(path));
    }
  }
  await visit(resolve(root));
  process.stdout.write(JSON.stringify({ ...audit.summary(), skipped }) + '\n');
} catch {
  // Filesystem and parser errors may include private filenames or content.
  process.stderr.write('WECHAT_ORIGIN_AUDIT_FAILED\n'); process.exitCode = 1;
}
