"""One-off merge preparation; manual conflict resolution and verification are required."""
import pathlib, subprocess, shutil, json

source = pathlib.Path(r'C:\Users\a4151\.codex\worktrees\adc7\ai代聊')
work = pathlib.Path(__file__).resolve().parents[1]
release = work / '.local-workspace-release'
if (release / '.local-launch' / 'running.json').exists():
    raise SystemExit('Refusing to overwrite a running release. Stop it and prepare a new deployment copy.')
release.mkdir(exist_ok=True)

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])

files = git(source, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')
for name in filter(None, files):
    src = source / name
    if src.is_file():
        dst = release / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

changed = git(work, 'diff', '--name-only', '-z', 'HEAD').decode().split('\0')
untracked = git(work, 'ls-files', '-z', '--others', '--exclude-standard').decode().split('\0')
conflicts = []
scratch = work / 'test-results' / 'release-merge'
scratch.mkdir(parents=True, exist_ok=True)
for name in filter(None, changed + untracked):
    if name.startswith(('output/', '_cleanup/', 'test-results/', '.local-workspace-release/')) or name.endswith('.lnk') or name == 'scripts/prepare-workspace-release.py':
        continue
    ours = work / name
    if not ours.is_file():
        continue
    dst = release / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        base = subprocess.run(['git', '-C', str(work), 'show', 'HEAD:' + name], capture_output=True, check=True).stdout
    except subprocess.CalledProcessError:
        base = None
    if not dst.exists() or base is None or dst.read_bytes() == base:
        shutil.copy2(ours, dst)
    elif ours.read_bytes() != base and ours.read_bytes() != dst.read_bytes():
        (scratch / 'base').write_bytes(base.replace(b'\r\n', b'\n'))
        (scratch / 'ours').write_bytes(ours.read_bytes().replace(b'\r\n', b'\n'))
        (scratch / 'theirs').write_bytes(dst.read_bytes().replace(b'\r\n', b'\n'))
        result = subprocess.run(['git', 'merge-file', '-p', str(scratch / 'ours'), str(scratch / 'base'), str(scratch / 'theirs')], capture_output=True)
        if result.returncode:
            conflicts.append(name)
        dst.write_bytes(result.stdout)

# Keep the deployed database's already-applied 0013 and 0014 migrations immutable.
migration = release / 'db/migrations/0013_platform_accounts.sql'
if migration.exists():
    migration.replace(release / 'db/migrations/0015_platform_accounts.sql')

# Private launch configuration and password remain private and use the same profiles.
private = release / '.local-launch'
private.mkdir(exist_ok=True)
for name in ['profiles.json', 'model.json', 'owner.json', 'wechat-attach.json']:
    src = source / '.local-launch' / name
    if src.exists():
        shutil.copy2(src, private / name)
print(json.dumps({'release': str(release), 'conflicts': conflicts}, ensure_ascii=False))
