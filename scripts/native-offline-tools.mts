import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

export function nativeWorkspace(prefix: string) {
  assert.match(prefix, /^[a-z0-9-]+-$/);
  const directory = mkdtempSync(join(tmpdir(), prefix));
  let compiler = process.env.CXX ?? 'c++'; let compilerEnv = process.env;
  function run(command: string, args: string[], options: object = {}, diagnostics = true) {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, ...options });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, diagnostics ? `offline command failed: ${result.stdout}\n${result.stderr}` : 'OFFLINE_TOOLCHAIN_SETUP_FAILED');
    return result.stdout;
  }
  try {
    if (process.platform === 'win32') {
      const locator = join(process.env['ProgramFiles(x86)']!, 'Microsoft Visual Studio/Installer/vswhere.exe');
      const installation = run(locator, ['-latest', '-products', '*', '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']).trim();
      assert.ok(installation && !/["\r\n%]/.test(installation));
      const setup = join(installation, 'VC/Auxiliary/Build/vcvars64.bat');
      const environment = run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `call "${setup}" >nul && set`],
        { windowsVerbatimArguments: true }, false);
      compilerEnv = Object.fromEntries(environment.split(/\r?\n/).filter((line) => line.includes('=') && !line.startsWith('='))
        .map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
      compiler = 'cl.exe';
    }
  } catch (error) { cleanup(); throw error; }
  function cleanup() {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith(prefix));
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    directory, run, cleanup,
    executable(name: string) { assert.match(name, /^[a-zA-Z0-9-]+$/); return join(directory, name) + (process.platform === 'win32' ? '.exe' : ''); },
    compile(source: string, output: string, defines: string[] = []) {
      const args = process.platform === 'win32'
        ? ['/nologo', '/std:c++17', '/EHsc', '/W4', '/WX', ...defines.map((d) => `/D${d}`), source,
          `/Fe${output}`, `/Fo${join(directory, 'harness.obj')}`]
        : ['-std=c++17', '-Wall', '-Wextra', '-Werror', ...defines.map((d) => `-D${d}`), source, '-o', output,
          ...(process.platform === 'linux' ? ['-ldl'] : [])];
      run(compiler, args, { cwd: directory, env: compilerEnv });
    },
  };
}
