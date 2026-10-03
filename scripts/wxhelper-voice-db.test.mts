import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

// Local development harness; no helper executable, offsets or real database is loaded.
let directory: string;
let executable: string;
let compiler: string;
let compilerEnv = process.env;
function run(command: string, args: string[], options: object = {}, showDiagnostics = true) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, ...options });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, showDiagnostics
    ? `offline command failed: ${result.stdout}\n${result.stderr}` : 'OFFLINE_TOOLCHAIN_SETUP_FAILED');
  return result.stdout;
}
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'voice-db-offline-'));
  executable = join(directory, process.platform === 'win32' ? 'harness.exe' : 'harness');
  if (process.platform === 'win32') {
    const locator = join(process.env['ProgramFiles(x86)']!, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const installation = run(locator, ['-latest', '-products', '*', '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']).trim();
    assert.ok(installation && !/["\r\n%]/.test(installation), 'MSVC installation required');
    const setup = join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
    const environment = run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `call "${setup}" >nul && set`],
      { windowsVerbatimArguments: true }, false);
    compilerEnv = Object.fromEntries(environment.split(/\r?\n/).filter((line) => line.includes('=') && !line.startsWith('='))
      .map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    compiler = 'cl.exe';
  } else compiler = process.env.CXX ?? 'c++';
  compile(resolve('scripts/wxhelper-voice-db/offline_harness.cc'), executable);
});
after(() => {
  if (!directory) return;
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('voice-db-offline-'));
  rmSync(directory, { recursive: true, force: true });
});

function compile(source: string, output: string, defines: string[] = []) {
  const args = process.platform === 'win32'
    ? ['/nologo', '/std:c++17', '/EHsc', '/W4', '/WX', ...defines.map((d) => `/D${d}`), source,
      `/Fe${output}`, `/Fo${join(directory, 'harness.obj')}`]
    : ['-std=c++17', '-Wall', '-Wextra', '-Werror', ...defines.map((d) => `-D${d}`), source, '-o', output,
      ...(process.platform === 'linux' ? ['-ldl'] : [])];
  run(compiler, args, { cwd: directory, env: compilerEnv });
}

for (const name of ['legacy-row-boundary', 'id-validation', 'handles-validation', 'binary-all-values',
  'empty-results', 'prepare-failure', 'step-failure', 'finalize-failure', 'column-boundary',
  'blob-type-boundary', 'blob-length-boundary', 'duplicate-results', 'database-names', 'sqlite-empty', 'sqlite-binary',
  'sqlite-int64', 'sqlite-types', 'sqlite-size', 'sqlite-ambiguous', 'sqlite-error-after-match']) {
  test(`voice DB native offline: ${name}`, () => { assert.equal(run(executable, [name]), process.platform === 'win32' ? 'PASS\r\n' : 'PASS\n'); });
}

test('voice DB offline failure exposes only a fixed error code', () => {
  const result = spawnSync(executable, ['PRIVATE_ID_SQL_ERROR'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, process.platform === 'win32' ? 'OFFLINE_CHECK_FAILED\r\n' : 'OFFLINE_CHECK_FAILED\n');
});

test('voice DB patch applies to the pinned method and compiles disabled and experimental paths', () => {
  const sourceDir = join(directory, 'app', 'wxhelper', 'src');
  mkdirSync(sourceDir, { recursive: true });
  const source = join(sourceDir, 'wechat_db.cc');
  copyFileSync('scripts/wxhelper-voice-db/upstream_voice_method.cc.txt', source);
  run('git', ['apply', '--check', resolve('scripts/wxhelper-voice-db.patch')], { cwd: directory });
  run('git', ['apply', resolve('scripts/wxhelper-voice-db.patch')], { cwd: directory });
  const patched = readFileSync(source, 'utf8');
  const begin = patched.indexOf('std::string WeChatDb::GetVoiceBuffByMsgId(');
  const end = patched.indexOf('\nstd::string WeChatDb::GetPublicMsg', begin);
  assert.ok(begin > 0 && end > begin);
  assert.ok(patched.includes('#define WXHELPER_EXPERIMENTAL_VOICE_DB 0'));
  const method = patched.slice(begin, end);
  const wrapper = join(directory, 'patch_harness.cc');
  copyFileSync('scripts/wxhelper-voice-db/voice_candidate.h', join(directory, 'voice_candidate.h'));
  copyFileSync('scripts/wxhelper-voice-db/offline_harness.cc', join(directory, 'offline_harness.cc'));
  writeFileSync(wrapper, `
#define main original_offline_main
#include "offline_harness.cc"
#undef main
#include <mutex>
#include <unordered_map>
// The existing encoder is unchanged; this spy checks its exact input byte range.
std::string base64_encode(const unsigned char* bytes, size_t length) {
  return "ENCODED:" + std::string(reinterpret_cast<const char*>(bytes), length);
}
#ifndef WXHELPER_EXPERIMENTAL_VOICE_DB
#define WXHELPER_EXPERIMENTAL_VOICE_DB 0
#endif
namespace wechat {
struct Info { uint64_t handle; };
class WeChatDb {
 public:
  std::recursive_mutex m;
  FakeApi func_;
  std::unordered_map<std::wstring, Info> dbmap_;
  std::string GetVoiceBuffByMsgId(uint64_t);
};
${method}
}
int main() {
  try {
    Reset(); wechat::WeChatDb db;
    db.dbmap_[L"MediaMSG0.db"] = {1}; db.dbmap_[L"MSG0.db"] = {2};
#if WXHELPER_EXPERIMENTAL_VOICE_DB
    Check(db.GetVoiceBuffByMsgId(9007199254740993ULL) == "ENCODED:" + fixture.bytes);
    Check(fixture.prepared == 1 && fixture.finalized == 1);
    Reset(); Check(db.GetVoiceBuffByMsgId(18446744073709551615ULL).empty());
    Check(fixture.prepared == 0);
    Reset(); fixture.second = 5; Check(db.GetVoiceBuffByMsgId(1).empty());
    Check(fixture.finalized == 1);
    Reset(); db.dbmap_.clear(); Check(db.GetVoiceBuffByMsgId(1).empty());
    Check(fixture.prepared == 0);
    db.dbmap_[L"MediaMSG0.db.bak"] = {1};
    Check(db.GetVoiceBuffByMsgId(1).empty() && fixture.prepared == 0);
    db.dbmap_.clear();
    for (uint64_t i = 0; i < 65; ++i) db.dbmap_[L"MediaMSG" + std::to_wstring(i) + L".db"] = {i + 1};
    Check(db.GetVoiceBuffByMsgId(1).empty() && fixture.prepared == 0);
    db.dbmap_.clear(); db.dbmap_[L"MediaMSG0.db"] = {1}; db.dbmap_[L"MediaMSG1.db"] = {1};
    Check(db.GetVoiceBuffByMsgId(1).empty() && fixture.prepared == 0);
#else
    Check(db.GetVoiceBuffByMsgId(1).empty()); Check(fixture.prepared == 0);
#endif
    std::cout << "PASS\\n"; return 0;
  } catch (...) { std::cerr << "OFFLINE_CHECK_FAILED\\n"; return 1; }
}
`);
  for (const experimental of [false, true]) {
    const output = join(directory, experimental ? 'experimental' : 'disabled') + (process.platform === 'win32' ? '.exe' : '');
    compile(wrapper, output, experimental ? ['WXHELPER_EXPERIMENTAL_VOICE_DB=1'] : []);
    assert.equal(run(output, []), process.platform === 'win32' ? 'PASS\r\n' : 'PASS\n');
  }
});
