// One version for every way the clicker ships (core script, iPhone app, Android app, add-on, install page).
//   node tools/version.js            print the version and check that every place agrees (exit 1 if not)
//   node tools/version.js 3.6.0      set it everywhere (then: node tools/build.js)
// Native build numbers are not kept here: CI derives them from its run number, so they only ever grow.
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');

const PLACES = [
  { file: 'version.json', re: /("version":\s*")(\d+\.\d+\.\d+)(")/ },
  { file: 'fast-clicker/eduapp-fast-clicker.user.js', re: /(const VERSION = ')(\d+\.\d+\.\d+)(')/ },
  { file: 'fast-clicker/eduapp-fast-clicker.user.js', re: /(\/\/ @version +)(\d+\.\d+\.\d+)()/ },
  { file: 'ios/project.yml', re: /(MARKETING_VERSION: ")(\d+\.\d+\.\d+)(")/ },
  { file: 'android/app/build.gradle.kts', re: /(versionName = ")(\d+\.\d+\.\d+)(")/ },
];

function read() {
  return PLACES.map((p) => {
    const text = fs.readFileSync(path.join(root, p.file), 'utf8');
    const m = text.match(p.re);
    if (!m) throw new Error(`no version found in ${p.file}`);
    return { ...p, text, version: m[2] };
  });
}

/** The version, or an exception naming the places that disagree. */
function current() {
  const found = read();
  const want = found[0].version;
  const off = found.filter((f) => f.version !== want);
  if (off.length) throw new Error(`version mismatch: version.json says ${want}, but ` + off.map((f) => `${f.file} says ${f.version}`).join(', ') + ' (fix with: node tools/version.js <x.y.z>)');
  return want;
}

function set(v) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) throw new Error('version must look like 3.6.0');
  for (const f of read()) fs.writeFileSync(path.join(root, f.file), f.text.replace(f.re, `$1${v}$3`));
  return current();
}

module.exports = { current };

if (require.main === module) {
  try {
    const v = process.argv[2] ? set(process.argv[2]) : current();
    console.log(v);
  } catch (e) { console.error(e.message); process.exit(1); }
}
