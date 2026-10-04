import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
for(const name of ['db-entry-scan','db-entry-structure','db-entry-candidates','db-entry-verify','db-xref-audit',
  'string-xref','sqlite-version','vdbe-opcodes','string-map','column-family']) {
  test(`${name} CLI fails without echoing private paths or emitting partial reports`,()=>{
    const r=spawnSync(process.execPath,[`scripts/wxhelper-${name}.mts`,'PRIVATE_FILE','PRIVATE_VALUE'],
      {encoding:'utf8',windowsHide:true,timeout:5000});
    assert.equal(r.status,1);assert.equal(r.stdout,'');
    assert.equal(r.stderr,'DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n');
  });
}
