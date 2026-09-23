import { applyMigrations } from '../packages/infrastructure/postgres/migrate.mts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
const imported = await import('pg');
const Client = imported.Client ?? imported.default.Client;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const applied = await applyMigrations(client);
  process.stdout.write(`migrations applied: ${applied.length ? applied.join(', ') : 'none'}\n`);
} finally {
  await client.end();
}
