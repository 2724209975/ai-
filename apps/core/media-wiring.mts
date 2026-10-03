/** Core only interprets assets already bound by 01/03. It has no platform acquisition capability. */
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { createImageMediaInterpreter, createMediaUnderstandingFromEnv, readMediaEnv, type MediaModelMeasurement } from '../../packages/ai/index.mts';
import { PgPrivateImageReader } from '../../packages/data/media/pg-private-reader.mts';
import type { PgPool } from '../../packages/infrastructure/postgres/transaction.mts';

export function readCoreImageDirectory(env: Record<string, string | undefined>): string | null {
  const media = readMediaEnv(env);
  if (media.voiceEnabled) throw new Error('VOICE_RUNTIME_UNSUPPORTED');
  if (!media.imageEnabled) return null;
  const root = env.MEDIA_PRIVATE_DIR?.trim();
  if (!root || !isAbsolute(root)) throw new Error('INVALID_ENV:MEDIA_PRIVATE_DIR');
  const web = resolve(env.WEB_BUILD_DIR?.trim() || 'apps/web/build'), resolved = resolve(root);
  const inside = relative(web, resolved);
  if (!inside || inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)) throw new Error('INVALID_ENV:MEDIA_PRIVATE_DIR');
  return resolved;
}
export function createCoreImages(env: Record<string, string | undefined>, pool: PgPool, observe?: (measurement: MediaModelMeasurement) => void) {
  const root = readCoreImageDirectory(env);
  if (!root) return undefined;
  const selected = createMediaUnderstandingFromEnv(env)!;
  return { interpret: createImageMediaInterpreter({ source: new PgPrivateImageReader(pool, root), provider: selected.provider,
    timeoutMs: readMediaEnv(env).timeoutMs, observe }) };
}
