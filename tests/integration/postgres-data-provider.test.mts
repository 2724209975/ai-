/** Include 03's real PostgreSQL provider regression in the shared CI gate. */
import test from 'node:test';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('real PostgreSQL: 03 provider transactions and scoped RLS', {
  skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database',
}, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  await import('../../packages/data/postgres/provider.integration.mts');
});
