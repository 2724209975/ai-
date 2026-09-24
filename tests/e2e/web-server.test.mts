/** Gate coverage for the web server's own test files.
 *
 * `npm run verify` only globs `tests/e2e/*.test.mts` for E2E and `packages/**` for unit tests, so
 * files under `apps/web/server` never ran. This wrapper imports them: the handler tests always,
 * the 320/390px fixtures only when the browser gate is enabled.
 */
import test from 'node:test';

await import('../../apps/web/server/owner-http.test.mts');

if (process.env.RUN_BROWSER_E2E === '1') await import('../../apps/web/server/g2-mobile-browser.test.mts');
else test('06 mobile fixtures: status projection and unavailable queries', {
  skip: 'requires RUN_BROWSER_E2E=1',
}, () => {});
