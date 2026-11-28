// Release helper: checks before a release, and the app builds that belong to exactly this commit.
// The steps themselves stay deliberate (docs/OPERATIONS.md, "Release"); nothing here publishes anything.
//   node tools/release.js check      is this commit ready? (version, clean and pushed, CI green, control.json)
//   node tools/release.js android    start the Android build (+ emulator smoke test) for this commit
//   node tools/release.js apk        download the APK built from this commit into app-download/ (then publish-site --new-apk)
//   node tools/release.js ios        start the TestFlight upload for this commit
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const { current } = require('./version');
const root = path.resolve(__dirname, '..');
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gh = (...args) => sh('gh', args);
const head = () => sh('git', ['rev-parse', 'HEAD']);

/** The newest run of a workflow for this commit: { databaseId, status, conclusion } or null. */
function runFor(workflow, sha) {
  // only builds of main: other branches are signed with a throwaway key and would not install over the testers' app
  const runs = JSON.parse(gh('run', 'list', '--workflow', workflow, '--branch', 'main', '--commit', sha, '--limit', '5', '--json', 'databaseId,status,conclusion,createdAt'));
  return runs[0] || null;
}

function check() {
  const problems = [];
  let v = '?';
  try { v = current(); } catch (e) { problems.push(e.message); }
  if (sh('git', ['status', '--porcelain'])) problems.push('uncommitted changes (commit them first)');
  const sha = head();
  try { sh('git', ['fetch', '-q', 'origin']); } catch {}
  let remote = '';
  try { remote = sh('git', ['rev-parse', 'origin/main']); } catch {}
  if (remote !== sha) problems.push('this commit is not what origin/main has (push first)');
  const tests = runFor('test.yml', sha);
  if (!tests) problems.push('no CI test run for this commit yet');
  else if (tests.status !== 'completed') problems.push(`CI tests still ${tests.status}`);
  else if (tests.conclusion !== 'success') problems.push(`CI tests ${tests.conclusion} (run ${tests.databaseId})`);
  const control = JSON.parse(fs.readFileSync(path.join(root, 'install/control.json'), 'utf8'));
  const latest = Object.entries(control.latest || {}).filter(([, x]) => x !== v);
  console.log(`version ${v}, commit ${sha.slice(0, 7)}`);
  if (control.pause) console.log('NOTE: install/control.json has pause: true (clients are not checking)');
  if (latest.length) console.log(`NOTE: install/control.json "latest" is ${latest.map(([p, x]) => `${p} ${x}`).join(', ')}: raise it to ${v} for a channel once its new build is available there`);
  if (problems.length) { console.log('NOT READY:\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('ready');
}

function apk() {
  const sha = head();
  const run = runFor('android.yml', sha);
  if (!run) throw new Error(`no Android build for ${sha.slice(0, 7)}: node tools/release.js android`);
  if (run.status !== 'completed') throw new Error(`the Android build ${run.databaseId} is still ${run.status}`);
  // the smoke test can fail on the emulator's own problems (docs/OPERATIONS.md); the build job itself must have passed
  const jobs = JSON.parse(gh('run', 'view', String(run.databaseId), '--json', 'jobs')).jobs;
  const build = jobs.find((j) => j.name === 'build');
  if (!build || build.conclusion !== 'success') throw new Error(`the Android build job of run ${run.databaseId} did not succeed`);
  const smoke = jobs.find((j) => j.name === 'smoke');
  const out = path.join(root, 'app-download');
  fs.rmSync(out, { recursive: true, force: true });
  gh('run', 'download', String(run.databaseId), '-n', 'Clicker-apk', '-D', out);
  console.log(`app-download/Clicker.apk from run ${run.databaseId} (commit ${sha.slice(0, 7)}, version ${current()}), smoke test: ${smoke ? smoke.conclusion : 'not run'}`);
}

/** App builds are made from main as it is on GitHub: this checkout must be exactly that commit. */
function onMain() {
  try { sh('git', ['fetch', '-q', 'origin']); } catch {}
  if (sh('git', ['rev-parse', 'origin/main']) !== head()) throw new Error('this checkout is not origin/main: push (or pull) first, so the build is of this commit');
}

const cmd = process.argv[2];
try {
  if (cmd === 'check') check();
  else if (cmd === 'android') { onMain(); gh('workflow', 'run', 'android.yml', '--ref', 'main', '-f', 'smoke=true'); console.log('Android build started: gh run list --workflow android.yml'); }
  else if (cmd === 'apk') apk();
  else if (cmd === 'ios') { onMain(); gh('workflow', 'run', 'ios-testflight.yml', '--ref', 'main'); console.log('TestFlight upload started: gh run list --workflow ios-testflight.yml'); }
  else { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 7).join('\n')); process.exit(cmd ? 1 : 0); }
} catch (e) { console.error(e.message); process.exit(1); }
