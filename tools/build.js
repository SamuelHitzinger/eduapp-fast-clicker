// Builds site/ (install page, pinned script, add-on) from fast-clicker/eduapp-fast-clicker.user.js.
// Run: node tools/build.js
const fs = require('fs'), path = require('path'), crypto = require('crypto'), esbuild = require('esbuild');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const site = path.join(root, 'site');
const srcPath = path.join(root, 'fast-clicker/eduapp-fast-clicker.user.js');
let src = fs.readFileSync(srcPath, 'utf8');
const version = (src.match(/const VERSION = '([^']+)'/) || [])[1];
// The hint relay's address (relay/README.md) is put into every build; without relay/relay-url.txt each client
// simply checks for itself.
const relayFile = path.join(root, 'relay/relay-url.txt');
const relayUrl = fs.existsSync(relayFile) ? fs.readFileSync(relayFile, 'utf8').trim() : '';
if (relayUrl) {
  if (!/^wss:\/\/[a-z0-9.-]+(:\d+)?(\/[\w\/.-]*)?$/i.test(relayUrl)) throw new Error('relay/relay-url.txt must hold one wss:// address');
  const marker = "const RELAY_URL = '';";
  if (!src.includes(marker)) throw new Error('RELAY_URL marker not found in the script');
  src = src.replace(marker, () => `const RELAY_URL = ${JSON.stringify(relayUrl)};`);
}
const min = esbuild.transformSync(src, { minify: true, target: 'es2020', legalComments: 'none' }).code.trim();

// 1) bookmarklet with everything inside (works without this website).
//    javascript: URLs are percent-decoded before they run, and '#' would start a fragment: escape only those.
const MUST_ESCAPE = /[%#\n\r\t]/g;
const pct = (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase();
const full = 'javascript:' + `(()=>{window.__FC_MODE='focus';${min.replace(/;$/, '')}})()`.replace(MUST_ESCAPE, pct);

// 2) pinned, immutable script for the short loader (Subresource Integrity)
const sri = 'sha384-' + crypto.createHash('sha384').update(min).digest('base64');
const shortFile = `fast-clicker.${crypto.createHash('sha256').update(min).digest('hex').slice(0, 10)}.js`;
// pinned files that were ever published are kept by tools/publish-site.js: installed short bookmarks reference them by name + hash
fs.writeFileSync(path.join(site, shortFile), min);
fs.writeFileSync(path.join(site, 'fast-clicker.user.js'), src);
// iPhone and Android apps: the same tested build, injected by the app
fs.writeFileSync(path.join(root, 'ios/FastClicker/Resources/fast-clicker.js'), min);
fs.mkdirSync(path.join(root, 'android/app/src/main/assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'android/app/src/main/assets/fast-clicker.js'), min);
// the Android app's own start-up report (StartReport.kt) goes to the same relay
const reportUrl = relayUrl ? relayUrl.replace(/^wss:/, 'https:').replace(/\/+$/, '') + '/report' : '';
fs.writeFileSync(path.join(root, 'android/app/src/main/assets/report-url.txt'), reportUrl);

// 3) install page (the TestFlight invitation link goes into tools/testflight-url.txt once the beta exists)
const tfFile = path.join(__dirname, 'testflight-url.txt');
const testflight = fs.existsSync(tfFile) ? fs.readFileSync(tfFile, 'utf8').trim() : '';
if (testflight && !/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/.test(testflight)) throw new Error('tools/testflight-url.txt must hold a https://testflight.apple.com/join/... link');
const apkPath = path.join(root, 'app-download', 'Clicker.apk');
const apkSize = fs.existsSync(apkPath) ? (fs.statSync(apkPath).size / 1e6).toFixed(1) + ' MB' : 'about 1 MB';
const html = fs.readFileSync(path.join(site, 'template.html'), 'utf8')
  .replace('__FULL_JSON__', () => JSON.stringify(full).replace(/</g, '\\u003c'))
  .replace('__SHORT_FILE_JSON__', () => JSON.stringify(shortFile))
  .replace('__SHORT_SRI_JSON__', () => JSON.stringify(sri))
  .replace('__VERSION__', version)
  .replace('__TESTFLIGHT_JSON__', () => JSON.stringify(testflight))
  .replace('__APK_SIZE__', apkSize)
  .replace('__DATE__', new Date().toISOString().slice(0, 10));
fs.writeFileSync(path.join(site, 'index.html'), html);
fs.writeFileSync(path.join(site, '.nojekyll'), '');

// 4) browser add-on (Manifest V3; Chrome, Edge, Brave, Firefox 128+)
const ext = path.join(site, 'extension');
fs.writeFileSync(path.join(ext, 'fast-clicker.js'), min);
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'ETH Clicker (unofficial)',
  version,
  description: 'Shows EduApp clicker questions within seconds and gets your answer through even on bad Wi-Fi. Unofficial; not made by ETH Zurich.',
  icons: { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' },
  content_scripts: [{
    matches: ['https://eduapp.ethz.ch/*'],
    exclude_matches: ['https://eduapp.ethz.ch/keycloak/*', 'https://eduapp.ethz.ch/oauth2/*', 'https://eduapp.ethz.ch/mgmt/*'],
    js: ['fast-clicker.js'], run_at: 'document_idle', world: 'MAIN',
  }],
  browser_specific_settings: { gecko: { id: 'clicker-for-eduapp@beta', strict_min_version: '128.0' } },
}, null, 2));
const zip = path.join(site, 'fast-clicker-extension.zip');
execFileSync('python', ['-I', path.join(__dirname, 'zipdir.py'), zip, ext]);

console.log(`relay: ${relayUrl || '(none: every client checks for itself)'}`);
console.log(`v${version}: script ${min.length} B, full bookmarklet ${full.length} chars, pinned ${shortFile}, add-on zip ${fs.statSync(zip).size} B`);
