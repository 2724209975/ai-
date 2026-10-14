/** Explicit connected-device acceptance. Synthetic records only; preserves existing model settings. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readLaunchConfig,loadProfiles} from '../.local-workspace-release/scripts/parallel-local-config.mts';
import {PgLinkStore} from '../packages/link/store.mts';
import {LinkService} from '../packages/link/service.mts';
import {Pool} from 'pg';
const serial=process.argv[2];if(!serial)throw new Error('Explicit device serial required');
const root=resolve('.local-workspace-release');const profiles=await loadProfiles(root,await readLaunchConfig(root));const owner=profiles.find(p=>p.platform==='qq')??profiles[0];
const saved=JSON.parse((await readFile(resolve(root,'.local-mobile-link/config.json'),'utf8')).replace(/^\uFEFF/,''));
const pool=new Pool({connectionString:owner.env.DATABASE_URL});
try {
 const service=new LinkService(new PgLinkStore(pool,owner.env.OWNER_ID!));const code=await service.invite();
 const fingerprint=new X509Certificate(await readFile(saved.MOBILE_LINK_CERT)).fingerprint256.replaceAll(':','').toLowerCase();
 const payload=JSON.stringify({protocol:1,endpoint:saved.MOBILE_LINK_ORIGIN,fingerprint,code});
 const adb=resolve(process.env.LOCALAPPDATA!,'Android/Sdk/platform-tools/adb.exe');
 const test=spawnSync(adb,['-s',serial,'shell','am','instrument','-w','-e','class','cn.replyassistant.LinkDeviceTest#connectedDesktopPairingAndSyntheticSync','-e','desktopPairing',`'${payload}'`,'cn.replyassistant.test/androidx.test.runner.AndroidJUnitRunner'],{encoding:'utf8',timeout:60000,windowsHide:true});
 const log=(test.stdout??'')+(test.stderr??'');await writeFile(resolve('output/android/link-redmi-acceptance.log'),log);
 if(test.status!==0||!log.includes('OK (1 test)'))throw new Error('Connected acceptance failed; inspect the acceptance log');
 process.stdout.write('Redmi: certificate pairing, LAN contacts, synthetic context/style sync and replay passed; encrypted connection saved.\n');
}finally {await pool.end();}
