/** Shape-only view of one private raw event, for runbook step 5 (owner-source diagnosis).
 *
 * Usage: node scripts/qq-raw-shape.mts <file-or-directory>
 * A directory is read recursively (limited) so the operator can point at the account's raw store.
 * File names are content digests, so they are never printed; entries are labelled by index only.
 * Nothing here logs chat bodies, peer numbers or URLs.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describeRawShape } from '../packages/platform/qq/raw-shape.mts';

const target = process.argv[2]?.trim();
if (!target) throw new Error('MISSING_ARGUMENT:file-or-directory');
const limit = Number(process.env.SHAPE_LIMIT?.trim() || 20);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('INVALID_ENV:SHAPE_LIMIT');

async function collect(path: string, found: string[] = []): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) { found.push(path); return found; }
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length >= limit) break;
    const child = join(path, entry.name);
    if (entry.isDirectory()) await collect(child, found);
    else if (entry.isFile() && entry.name.endsWith('.bin')) found.push(child);
  }
  return found;
}

const files = (await collect(target)).slice(0, limit);
if (!files.length) throw new Error('NO_RAW_EVENTS_FOUND');

const shapes = [];
for (const [index, file] of files.entries()) {
  const bytes = await readFile(file);
  let parsed: unknown;
  let parseError = false;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parseError = true; }
  shapes.push({ entry: index + 1, parseError, shape: parsed === undefined ? null : describeRawShape(parsed, { byteLength: bytes.byteLength }) });
}
process.stdout.write(`${JSON.stringify({ redacted: true, files: files.length, shapes }, null, 2)}\n`);
