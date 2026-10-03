/** Windows local development only. Builds an isolated DLL; never runs a helper or injector. */
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

export function digest(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export function inventory(root: string, prefix = ''): { path: string; sha256: string; bytes: number }[] {
  const entries: { path: string; sha256: string; bytes: number }[] = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    if (name === '.git') continue;
    const path = join(prefix, name); const state = lstatSync(join(root, path));
    if (state.isSymbolicLink()) throw Error('SOURCE_LINK_REJECTED');
    if (state.isDirectory()) entries.push(...inventory(root, path));
    else if (state.isFile()) {
      const bytes = readFileSync(join(root, path));
      entries.push({ path: path.split(sep).join('/'), sha256: digest(bytes), bytes: bytes.length });
    } else throw Error('SOURCE_TYPE_REJECTED');
  }
  return entries;
}
export function x64Dll(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 64 || buffer.readUInt16LE(0) !== 0x5a4d) return false;
  const offset = buffer.readUInt32LE(60);
  return offset <= buffer.length - 26 && buffer.readUInt32LE(offset) === 0x4550 &&
    buffer.readUInt16LE(offset + 4) === 0x8664 && (buffer.readUInt16LE(offset + 22) & 0x2000) !== 0 &&
    buffer.readUInt16LE(offset + 24) === 0x20b;
}
function command(executable: string, args: string[], cwd: string, log?: string): string {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 600_000,
    maxBuffer: 20 * 1024 * 1024 });
  if (log) writeFileSync(log, result.stdout + result.stderr);
  if (result.error || result.status !== 0) throw Error('OFFLINE_BUILD_COMMAND_FAILED');
  return result.stdout.trim();
}

export function applyIsolatedPatch(source: string, patches: string[]): void {
  if (existsSync(join(source, '.git'))) throw Error('COPY_GIT_METADATA_REJECTED');
  command('git', ['init', '--quiet'], source);
  for (const patch of patches) {
    command('git', ['apply', '--check', patch], source); command('git', ['apply', patch], source);
  }
}
export function buildReceiveOnly(workspace: string, rollbackPath: string, name = `p45b-${randomBytes(6).toString('hex')}`): string {
  if (process.platform !== 'win32') throw Error('WINDOWS_LOCAL_BUILD_REQUIRED');
  if (!/^p45b-[a-zA-Z0-9-]{1,48}$/.test(name)) throw Error('BUILD_NAME_INVALID');
  const root = resolve(workspace); const base = join(root, '.local-wxhelper');
  const original = join(base, 'wxhelper-src-391125'); const output = join(base, name);
  const rollback = resolve(rollbackPath); const rollbackBytes = readFileSync(rollback);
  if (digest(rollbackBytes).toUpperCase() !== WX_OFFSET_BUILD.helperSha256) throw Error('ROLLBACK_FINGERPRINT_MISMATCH');
  if (existsSync(output) || dirname(output) !== base || lstatSync(base).isSymbolicLink() ||
      lstatSync(original).isSymbolicLink()) throw Error('BUILD_PATH_INVALID');
  const head = command('git', ['rev-parse', 'HEAD'], original);
  if (head !== '36ecd7e349df6954393f75e30e38e89710d399aa') throw Error('SOURCE_HEAD_MISMATCH');
  if (digest(readFileSync(join(original, 'app/wxhelper/src/wechat_db.cc'))).toUpperCase() !==
      '6C2EE55BF73B4B4FAF96004A5A86E69E0BD7B4225DF313D1489FFF5BAAFDD055') throw Error('VOICE_SOURCE_MISMATCH');
  const before = inventory(original);
  mkdirSync(output); const source = join(output, 'source');
  cpSync(original, source, { recursive: true, filter: (path) => basename(path) !== '.git' });
  if (JSON.stringify(before) !== JSON.stringify(inventory(source))) throw Error('SOURCE_COPY_MISMATCH');
  // An ignored directory inside the parent repository otherwise silently skips patch paths.
  const patches = ['wxhelper-voice-db.patch', 'wxhelper-receive-only.patch'];
  applyIsolatedPatch(source, patches.map((name) => join(root, 'scripts', name)));
  const patchFingerprints = patches.map((patch) => {
    const path = join(root, 'scripts', patch);
    return { path: `scripts/${patch}`, sha256: digest(readFileSync(path)) };
  });
  for (const name of ['receive_policy.h', 'receive_endpoint.h', 'receive_endpoint.cc'])
    cpSync(join(root, 'scripts/wxhelper-receive-only', name), join(source, 'app/wxhelper/src', name));
  cpSync(join(root, 'scripts/wxhelper-voice-db/voice_candidate.h'), join(source, 'app/wxhelper/src/voice_candidate.h'));
  const prepared = inventory(source);
  const preparedCmake = readFileSync(join(source, 'app/wxhelper/CMakeLists.txt'), 'utf8');
  if (!preparedCmake.includes('option(WXHELPER_P4_RECEIVE_ONLY') ||
      !readFileSync(join(source, 'app/wxhelper/src/http_server.cc'), 'utf8').includes('p4_receive::Handle(c,'))
    throw Error('RECEIVE_PATCH_NOT_APPLIED');
  const locator = join(process.env['ProgramFiles(x86)']!, 'Microsoft Visual Studio/Installer/vswhere.exe');
  const installation = command(locator, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], root);
  const cmake = join(installation, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe');
  const version = command(cmake, ['--version'], root).split('\n')[0];
  const build = join(output, 'build');
  command(cmake, ['-S', source, '-B', build, '-G', 'Visual Studio 17 2022', '-A', 'x64',
    '-DWXHELPER_P4_RECEIVE_ONLY=ON', '-DUSE_EXTERNAL_JSON=OFF', '-DUSE_EXTERNAL_DETOURS=OFF',
    '-DSPDLOG_BUILD_EXAMPLE=OFF', '-DSPDLOG_BUILD_TESTS=OFF'], root, join(output, 'configure.log'));
  command(cmake, ['--build', build, '--config', 'Release', '--target', 'wxhelper', '--parallel', '2'],
    root, join(output, 'build.log'));
  if (!readFileSync(join(build, 'app/wxhelper/wxhelper.vcxproj'), 'utf8').includes('WXHELPER_P4_RECEIVE_ONLY=1') ||
      !readFileSync(join(build, 'app/wxhelper/3rdparty/mongoose/mongoose.vcxproj'), 'utf8').includes('MG_MAX_RECV_SIZE=4096'))
    throw Error('RECEIVE_BUILD_FLAGS_MISSING');
  const compilerFolder = readdirSync(join(build, 'CMakeFiles')).find((name) =>
    existsSync(join(build, 'CMakeFiles', name, 'CMakeCXXCompiler.cmake')));
  if (!compilerFolder) throw Error('COMPILER_METADATA_MISSING');
  const compilerMetadata = readFileSync(join(build, 'CMakeFiles', compilerFolder, 'CMakeCXXCompiler.cmake'), 'utf8');
  const compilerVersion = compilerMetadata.match(/set\(CMAKE_CXX_COMPILER_VERSION "([0-9.]+)"\)/)?.[1];
  const sdkVersion = readFileSync(join(build, 'app/wxhelper/wxhelper.vcxproj'), 'utf8')
    .match(/<WindowsTargetPlatformVersion>([0-9.]+)<\/WindowsTargetPlatformVersion>/)?.[1];
  if (!compilerVersion || !sdkVersion) throw Error('COMPILER_METADATA_MISSING');
  const artifact = join(build, 'app/wxhelper/lib/Release/wxhelper.dll'); const bytes = readFileSync(artifact);
  if (!x64Dll(bytes)) throw Error('ARTIFACT_ARCHITECTURE_MISMATCH');
  if (JSON.stringify(prepared) !== JSON.stringify(inventory(source))) throw Error('PREPARED_SOURCE_CHANGED');
  if (JSON.stringify(before) !== JSON.stringify(inventory(original))) throw Error('ORIGINAL_SOURCE_CHANGED');
  const bundle = join(output, 'bundle'); mkdirSync(bundle); cpSync(artifact, join(bundle, 'wxhelper.dll'));
  mkdirSync(join(bundle, 'rollback')); cpSync(rollback, join(bundle, 'rollback', 'wxhelper.dll'));
  const metadata = {
    protocol: 'p4-5b-receive-only-v1', builtAt: new Date().toISOString(), sourceHead: head,
    sourceInventorySha256: digest(JSON.stringify(before)), preparedInventorySha256: digest(JSON.stringify(prepared)),
    patches: patchFingerprints, toolchain: { cmake: version, msvc: compilerVersion, windowsSdk: sdkVersion,
      generator: 'Visual Studio 17 2022', architecture: 'x64',
      configuration: 'Release', target: 'wxhelper' },
    artifact: { path: 'wxhelper.dll', sha256: digest(bytes), bytes: bytes.length, architecture: 'x64', receiveOnly: true },
    rollback: { relativePath: relative(root, rollback).split(sep).join('/'), bundledPath: 'rollback/wxhelper.dll',
      sha256: digest(rollbackBytes), bytes: rollbackBytes.length },
    clientSha256: '2058a926258baeaecf92b30668ff200382f4493b0a5323428781d0b993e19c51',
    liveTested: false, voiceDatabaseReady: false, modelCalls: 0,
  };
  writeFileSync(join(output, 'source-inventory.json'), JSON.stringify({ before, prepared }, null, 2));
  writeFileSync(join(output, 'existing-local-changes.patch'), command('git', ['diff', '--', 'app'], original));
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(metadata, null, 2));
  return bundle;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length < 3 || process.argv.length > 4) throw Error('BUILD_ARGUMENTS_INVALID');
    console.log(buildReceiveOnly(process.cwd(), process.argv[2], process.argv[3]));
  } catch { console.error('P4_OFFLINE_BUILD_FAILED: inspect the isolated build logs'); process.exitCode = 1; }
}
