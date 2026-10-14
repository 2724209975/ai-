import pathlib, re, shutil

work = pathlib.Path(__file__).resolve().parents[1]
release = work / '.local-workspace-release'
if (release / '.local-launch' / 'running.json').exists():
    raise SystemExit('Refusing to modify a running release. This is a one-off merge helper, not an update command.')
source = pathlib.Path(r'C:\Users\a4151\.codex\worktrees\adc7\ai代聊')
pattern = re.compile(r'^<<<<<<<[^\n]*\n(.*?)^=======\n(.*?)^>>>>>>>[^\n]*\n', re.M | re.S)

def resolve(name, handler):
    path = release / name
    text = path.read_text(encoding='utf-8')
    index = 0
    def replace(match):
        nonlocal index
        index += 1
        return handler(index, match[1], match[2])
    path.write_text(pattern.sub(replace, text), encoding='utf-8')

for name in ['.gitignore','apps/web/server/owner-http.mts','apps/web/server/owner-http.test.mts','apps/web/src/style.css','docs/decisions.md','docs/development-plan.md','packages/orchestration/postgres/confirmed-service.mts']:
    resolve(name, lambda i,a,b:a+b)
resolve('scripts/local-stack-driver.mts',lambda i,a,b:a)
resolve('tests/integration/postgres-local-stack.test.mts',lambda i,a,b:a.replace(', 13)', ', 15)'))

def api_merge(i,a,b):
    if i == 1:
        return a.replace('policyVersion?: number };','policyVersion?: number; advisor?: AdvisorResult };')
    if i == 2:
        return b.replace('async function request<T>', 'export async function request<T>').replace('} catch {','} catch (cause) {\n    if (cause instanceof DOMException && cause.name === \'AbortError\') throw cause;')
    return a[:a.index('  session:')] + b
resolve('apps/web/src/api.ts',api_merge)

def model_merge(i,a,b):
    if i == 1:
        return a + "import { ADVISOR_JSON_INSTRUCTION, parseAdvisorResult } from '../analysis/advisor-result.mts';\n"
    if i == 2:
        body = a[a.index('    const body ='):a.index('    return `')]
        return b.replace('  const history =', '  const humanlike = isHumanlikePrompt(version);\n  const history =').replace("    const body = message.type === 'text' ? (message.text ?? '').trim() : `[${message.type} 内容未取到可靠文本]`;\n",body)
    return '        const decoded = parseModelJson(content) as {advisor?:unknown};\n' + a.replace('normaliseAlternatives(parseModelJson(content), humanlike)','normaliseAlternatives(decoded, humanlike)') + '        const advisor = inputAdvisor(context, decision, decoded.advisor);\n'
resolve('packages/ai/generation/deepseek-provider.mts',model_merge)

# The workspace shell retains entry points for the deployed account, model and relationship tools.
app = (work / 'apps/web/src/App.tsx').read_text(encoding='utf-8')
app = "import { Accounts, ModelSetup, AddContact } from './Portal';\nimport { Skills } from './Skills';\nimport { ContactHistory } from './ContactHistory';\nimport { ContactAdvisor } from './Advisor';\n" + app
app = app.replace('type Analysis,','type AccountConnection, type ModelSettings, type Contact, type Analysis,')
app = app.replace("type Page = 'chat'", "type Page = 'accounts' | 'model' | 'relationships' | 'chat'")
app = app.replace("const pages: { id: Page; label: string }[] = [", "const pages: { id: Page; label: string }[] = [\n  { id: 'accounts', label: '账号登录' }, { id: 'model', label: '模型与预算' }, { id: 'relationships', label: '联系人与关系工具' },")
app = app.replace('const value = await api[page]();', "const value = await (page === 'relationships' ? api.contacts() : api[page]());")
app = app.replace("['facts','analyses','media','audit'].includes(item.id)", "['accounts','model','relationships','skills','facts','analyses','media','audit'].includes(item.id)")
app = app.replace("    {notice &&", "    {showContent && page === 'accounts' && <Accounts rows={list<AccountConnection>()} refresh={refresh} />}\n    {showContent && page === 'model' && current && <ModelSetup value={current as ModelSettings} refresh={refresh} />}\n    {showContent && page === 'relationships' && <section className=\"stack\"><AddContact scope=\"all\" refresh={refresh} />{list<Contact>().map(row => <article className=\"card\" key={row.id}><h3>{row.name} · {row.platform}</h3><ContactHistory contact={row} scope={row.sourcePlatform ?? 'all'} /><ContactAdvisor contact={row} scope={row.sourcePlatform ?? 'all'} /></article>)}</section>}\n    {notice &&")
start = app.index("    {showContent && page === 'skills'")
end = app.index("    {showContent && page === 'imports'", start)
app = app[:start] + "    {showContent && page === 'skills' && <Skills rows={list<Skill>()} scope=\"all\" refresh={refresh} />}\n" + app[end:]
(release / 'apps/web/src/App.tsx').write_text(app,encoding='utf-8')
print('release merge resolved')
