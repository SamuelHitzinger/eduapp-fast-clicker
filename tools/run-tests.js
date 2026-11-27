// Every test, one after another; exits 1 if any fails. None of them contacts ETH or Cloudflare.
//   node tools/run-tests.js            all (about 3 minutes)
//   node tools/run-tests.js --quick    without the long scenario suites (test-v3, test-chaos)
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const quick = process.argv.includes('--quick');

const SUITES = [
  ['version agrees everywhere', 'tools/version.js'],
  ['built site and app copies', 'tools/verify-site.js'],
  ['bookmarklet', 'tools/test-bookmarklet.js'],
  ['core: functional and regressions', 'tools/test-mock.js'],
  ['core: several tabs', 'tools/test-tabs.js'],
  ['core: v3 scenarios', 'tools/test-v3.js', 'slow'],
  ['core: terrible Wi-Fi', 'tools/test-chaos.js', 'slow'],
  ['relay: unit and integration', 'relay/test/run.js'],
  ['relay: real clients end to end', 'tools/test-relay-e2e.js'],
];

const results = [];
for (const [name, file, slow] of SUITES) {
  if (quick && slow) { results.push([name, 'skipped']); continue; }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, file)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ok = r.status === 0;
  const last = (r.stdout || '').trim().split('\n').pop();
  results.push([name, ok ? 'ok' : 'FAILED', `${((Date.now() - t0) / 1000).toFixed(0)} s`, last]);
  console.log(`${ok ? 'ok    ' : 'FAILED'} ${name} (${file}, ${((Date.now() - t0) / 1000).toFixed(0)} s): ${last}`);
  if (!ok) console.log((r.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).join('\n') + '\n' + (r.stderr || '').slice(-3000));
}
const failed = results.filter((r) => r[1] === 'FAILED');
console.log(failed.length ? `\n${failed.length} suite(s) failed` : '\nall passed');
process.exit(failed.length ? 1 : 0);
