/** Isolated proof of the proposed 0003 policy. Does not alter published migrations. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setContactScope } from '../../infrastructure/postgres/transaction.mts';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const { Client } = await import('pg');
const client = new Client({ connectionString: url });
const schema = `rls_proposal_${randomBytes(7).toString('hex')}`;
const role = `rls_role_${randomBytes(7).toString('hex')}`;
const here = dirname(fileURLToPath(import.meta.url));
await client.connect();
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  // Preserve the original 0002 regression fixture even after 0003 is published.
  await client.query(await readFile(resolve(here,'../../../db/migrations/0001_core.sql'),'utf8'));
  await client.query(await readFile(resolve(here,'../../../db/migrations/0002_data.sql'),'utf8'));
  const a = randomUUID(), b = randomUUID();
  for (const [scope, body] of [[a,'A private'],[b,'B private'],['global','shared']] as const)
    await client.query(`INSERT INTO data_facts(id,subject,scope,content,source_category,valid_from,confirmation_status,deletion_status,version,created_at,updated_at)
      VALUES($1,'owner',$2,$3,'owner-confirmed',now(),'confirmed','active',1,now(),now())`,[randomUUID(),scope,body]);
  await client.query(`CREATE ROLE ${role} NOLOGIN`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await client.query(`GRANT SELECT,INSERT ON data_facts TO ${role}`);
  await client.query(`SET ROLE ${role}`);
  await client.query('BEGIN');
  await setContactScope(client,a);
  assert.deepEqual((await client.query('SELECT scope FROM data_facts ORDER BY scope')).rows.map(r => r.scope),[a,'global'].sort());
  await client.query('COMMIT');
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM data_facts`)).rows[0]?.n,1,'published 0002 leak must reproduce in this isolated proof');
  await client.query('RESET ROLE');
  await client.query(await readFile(resolve(here,'0003_data_facts_scope.proposed.sql'),'utf8'));
  await client.query(`SET ROLE ${role}`);
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM data_facts`)).rows[0]?.n,0,'proposed policy must close no-scope read');
  await client.query('BEGIN');
  await setContactScope(client,a);
  assert.deepEqual((await client.query('SELECT scope FROM data_facts ORDER BY scope')).rows.map(r => r.scope),[a,'global'].sort());
  await client.query('COMMIT');
  await client.query('BEGIN');
  await setContactScope(client,b);
  assert.deepEqual((await client.query('SELECT scope FROM data_facts ORDER BY scope')).rows.map(r => r.scope),[b,'global'].sort());
  await client.query('COMMIT');
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM data_facts`)).rows[0]?.n,0);
  await client.query('BEGIN');
  await assert.rejects(client.query(`INSERT INTO data_facts(id,subject,scope,content,source_category,valid_from,confirmation_status,deletion_status,version,created_at,updated_at)
    VALUES($1,'owner','global','forbidden','owner-confirmed',now(),'confirmed','active',1,now(),now())`,[randomUUID()]),/row-level security policy/);
  await client.query('ROLLBACK');
  await client.query('RESET ROLE');
} finally {
  try { await client.query('ROLLBACK'); await client.query('RESET ROLE'); } catch {}
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`DROP ROLE IF EXISTS ${role}`);
  await client.end();
}
