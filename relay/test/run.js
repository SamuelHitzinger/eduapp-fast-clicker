// Runs all relay tests: `node test/run.js`. Exits non-zero on any failure.
import { runAll } from './lib.js';

let failed = 0;

await import('./hub.test.js');
failed += (await runAll('hub unit tests')).fail;

const integration = await import('./integration.test.js');
try {
  await integration.start();
  failed += (await runAll('integration tests')).fail;
} catch (e) {
  console.log('integration setup failed:', e.message);
  failed++;
} finally {
  await integration.stop();
}

console.log(failed ? `FAILED (${failed})` : 'ALL PASSED');
// let closing sockets finish first: exiting mid-close crashes Node on Windows (libuv assertion)
await new Promise((r) => setTimeout(r, 300));
process.exit(failed ? 1 : 0);
