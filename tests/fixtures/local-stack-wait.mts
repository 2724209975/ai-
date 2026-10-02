/** Simulates a startup command that never becomes ready. No I/O, platform or database capability. */
if (process.env.NODE_ENV !== 'test' || process.env.LOCAL_STACK_FIXTURE !== '1') throw new Error('FIXTURE_ONLY');
setInterval(() => {}, 1000);
