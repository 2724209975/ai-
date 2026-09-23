/** 06's real HTTP → 02/03 PostgreSQL → mock adapter browser flow in the shared gate.
 * Its cookie/Origin callbacks are fixture checks, not production login/CSRF. */
import test from 'node:test';

const enabled = !!process.env.TEST_DATABASE_URL && process.env.RUN_BROWSER_E2E === '1';

if (enabled) await import('../../apps/web/server/pg-owner-browser.integration.mts');
else test('real HTTP and worker with PostgreSQL and mock adapter in mobile Chromium', {
  skip: 'requires isolated TEST_DATABASE_URL and RUN_BROWSER_E2E=1',
}, () => {});
