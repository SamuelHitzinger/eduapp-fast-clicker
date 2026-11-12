// Only the integration tests, e.g. against `wrangler dev`:
//   RELAY_URL=http://127.0.0.1:8799 node test/integration-only.js
import { runAll } from './lib.js';
import { start, stop } from './integration.test.js';

let failed = 1;
try {
  await start();
  failed = (await runAll(`integration tests (${process.env.RELAY_URL || 'node-server'})`)).fail;
} finally {
  await stop();
}
process.exit(failed ? 1 : 0);
