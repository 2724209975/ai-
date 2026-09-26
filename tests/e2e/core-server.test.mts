/** Gate coverage for the core runtime's own test files.
 *
 * `npm run verify` globs `packages/**` for unit tests and `tests/{contracts,integration,e2e}` for the
 * rest, so files under `apps/core` would never run on their own. This wrapper imports them, the same
 * way `web-server.test.mts` does for `apps/web/server`.
 */
await import('../../apps/core/config.test.mts');
await import('../../apps/core/health.test.mts');
