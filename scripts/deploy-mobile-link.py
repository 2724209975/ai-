"""Add mobile linkage to the existing release without replacing other features."""
from pathlib import Path
import shutil
root = Path(__file__).resolve().parent.parent
release = root / '.local-workspace-release'
def edit(path, before, after):
    text = path.read_text(encoding='utf-8-sig')
    if after in text: return
    if before not in text: raise RuntimeError(f'Patch target changed: {path.name}')
    path.write_text(text.replace(before, after, 1), encoding='utf-8')
shutil.copytree(root/'packages/link', release/'packages/link', dirs_exist_ok=True)
for name in ['enable-mobile-link.ps1','enable-lan-access.ps1']:
    shutil.copy2(root/'scripts'/name, release/'scripts'/name)
shutil.copy2(root/'db/migrations/0014_mobile_link.sql',release/'db/migrations/0016_mobile_link.sql')
shutil.copy2(root/'apps/web/src/MobileLink.tsx',release/'apps/web/src/MobileLink.tsx')
app=release/'apps/web/src/App.tsx'
edit(app,"type Page = 'accounts'", "type Page = 'link' | 'accounts'")
edit(app,"  { id: 'accounts', label:","  { id: 'link', label: '手机联动' },\n  { id: 'accounts', label:")
edit(app,"page === 'more') { setLoading", "page === 'more' || page === 'link') { setLoading")
edit(app,"{page === 'chat' && <Workspace", "{page === 'link' && <MobileLink refreshVersion={reload}/>}\n    {page === 'chat' && <Workspace")
edit(app,"['accounts','model','relationships'", "['link','accounts','model','relationships'")
edit(app,"import { Accounts,", "import { MobileLink } from './MobileLink';\nimport { Accounts,")
edit(app,'<MobileLink />','<MobileLink refreshVersion={reload}/>')
edit(app,"['chat','more','overview'].includes(page)", "['chat','more','overview','link'].includes(page)")
edit(app,"['chat','more','accounts','model'].includes(page)", "['chat','more','accounts','model','link'].includes(page)")
portal=release/'scripts/local-portal.mts'
edit(portal,'  const server = createServer(async (req, res) => {', '  let mobileLink: ((req:any,res:any)=>Promise<boolean>) | undefined;\n  const server = createServer(async (req, res) => {')
edit(portal,"      if (!path.startsWith('/api/v1/'))", "      if (path.startsWith('/api/v1/mobile-link') && mobileLink && await mobileLink(req,res)) return;\n      if (!path.startsWith('/api/v1/'))")
edit(portal,'return { server, get auth() { return auth; } };','return { server, get auth() { return auth; }, setMobileLink(handler:typeof mobileLink){mobileLink=handler;} };')
parallel=release/'scripts/parallel-local.mts'
edit(parallel,"import { createLocalPortal }", "import { createPortalMobileLink } from '../packages/link/portal.mts';\nimport { createLocalPortal }")
edit(parallel,'  let portalServer:', '  let mobileLink: Awaited<ReturnType<typeof createPortalMobileLink>> = null;\n  let linkStarting: Promise<void> | undefined;\n  let portalServer:')
edit(parallel,'    const status: Status =',"    for(const config of configs) config.env.MOBILE_LINK_ENABLED='0';\n    const status: Status =")
target="      if (!controller.signal.aborted && !stopping) status.phase = status.profiles.every(row => row.phase === 'ready') ? 'ready' : 'starting';"
edit(parallel,target,target+"\n      if(status.phase==='ready'&&!linkStarting) linkStarting=(async()=>{mobileLink=await createPortalMobileLink({ownerId:owner.env.OWNER_ID!,auth:portal.auth,configs,pools:platformPools});if(mobileLink){await mobileLink.start();portal.setMobileLink(mobileLink.owner);}})();\n      if(linkStarting) await linkStarting;")
edit(parallel,'    if (portalServer) { portalServer.closeAllConnections();', '    await linkStarting?.catch(()=>{});\n    await mobileLink?.stop();\n    if (portalServer) { portalServer.closeAllConnections();')
print('Mobile linkage merged; existing release features and private settings retained.')
