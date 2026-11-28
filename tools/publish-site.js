// Publishes the beta install page (site/ + the latest Android app + a QR code) to Cloudflare as static files.
//   node tools/publish-site.js              the page, pins and control.json; the APK that is online stays as it is
//   node tools/publish-site.js --new-apk    the same with app-download/Clicker.apk (from node tools/release.js apk)
// Every pinned script that was ever published stays online (installed short bookmarks load it by name and hash).
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const QRCode = require('qrcode');
const root = path.resolve(__dirname, '..');
const site = path.join(root, 'site');
const out = path.join(root, 'install', 'public');
const URL_FILE = path.join(root, 'install', 'site-url.txt');
const PINS = path.join(root, 'install', 'published-pins.txt');
const pageUrl = fs.readFileSync(URL_FILE, 'utf8').trim();
const newApk = process.argv.includes('--new-apk');
const apk = newApk ? path.join(root, 'app-download', 'Clicker.apk') : path.join(out, '..', 'live-Clicker.apk');

(async () => {
  if (newApk) {
    if (!fs.existsSync(apk)) throw new Error('app-download/Clicker.apk missing: node tools/release.js apk');
    console.log('APK: the new one from app-download/');
  } else {
    // keep the one that is online now (so publishing a page or control.json change never swaps the app by accident)
    const r = await fetch(new URL('Clicker.apk', pageUrl), { cache: 'no-store' });
    if (!r.ok) throw new Error('could not fetch the published APK to keep it: use --new-apk with app-download/Clicker.apk');
    fs.writeFileSync(apk, Buffer.from(await r.arrayBuffer()));
    console.log('APK: kept the published one');
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const current = (html.match(/fast-clicker\.[0-9a-f]{10}\.js/) || [])[0];
  if (!current) throw new Error('index.html has no pinned script: run tools/build.js');
  const pins = new Set((fs.existsSync(PINS) ? fs.readFileSync(PINS, 'utf8') : '').split(/\s+/).filter(Boolean));
  pins.add(current);
  // the remote control (see docs/OPERATIONS.md): checked here, so a typo can't switch it off by accident
  const control = JSON.parse(fs.readFileSync(path.join(root, 'install', 'control.json'), 'utf8'));
  const ver = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (typeof control.pause !== 'boolean' || !(typeof control.slow === 'number' && control.slow >= 1 && control.slow <= 10) || !ver.test(control.min) ||
      !['web', 'addon', 'ios', 'android'].every((p) => ver.test(control.latest && control.latest[p]))) throw new Error('install/control.json is malformed');
  fs.writeFileSync(path.join(out, 'control.json'), JSON.stringify(control) + '\n');
  console.log('control:', JSON.stringify(control));
  for (const f of ['index.html', 'fast-clicker.user.js', 'fast-clicker-extension.zip', 'icon-180.png', 'icon-192.png', 'icon-512.png', current]) {
    fs.copyFileSync(path.join(site, f), path.join(out, f));
  }
  for (const f of pins) {
    const src = path.join(site, f), keep = path.join(root, 'install', 'pins', f);
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    if (fs.existsSync(src)) fs.copyFileSync(src, keep);              // archived so it can be served forever
    if (!fs.existsSync(keep)) throw new Error('published pin missing: ' + f);
    fs.copyFileSync(keep, path.join(out, f));
  }
  fs.writeFileSync(PINS, [...pins].sort().join('\n') + '\n');
  fs.copyFileSync(apk, path.join(out, 'Clicker.apk'));
  // what changes with every publish (not with a build): the APK's size and the date
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(out, 'index.html'), fs.readFileSync(path.join(out, 'index.html'), 'utf8')
    .replace('__APK_SIZE__', (fs.statSync(apk).size / 1e6).toFixed(1) + ' MB').replace('__DATE__', today));
  // privacy page, with the beta's contact (install/contact.txt) and today's date
  const contactFile = path.join(root, 'install', 'contact.txt');
  const contact = fs.existsSync(contactFile) ? fs.readFileSync(contactFile, 'utf8').trim() : '';
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  fs.writeFileSync(path.join(out, 'privacy.html'), fs.readFileSync(path.join(site, 'privacy.html'), 'utf8')
    .replace('__CONTACT__', contact ? `<a href="mailto:${esc(contact)}">${esc(contact)}</a>` : 'the person who gave you the link to this beta')
    .replace('__DATE__', today));
  fs.writeFileSync(path.join(out, 'qr.svg'), await QRCode.toString(pageUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
  fs.writeFileSync(path.join(out, '404.html'), '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found. <a href="/">Clicker beta</a></p>');
  fs.writeFileSync(path.join(out, '_headers'), [
    '/*',
    "  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '/',
    '  Cache-Control: no-cache',
    '/index.html',
    '  Cache-Control: no-cache',
    '/fast-clicker.*.js',
    '  Access-Control-Allow-Origin: *',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/control.json',
    '  Access-Control-Allow-Origin: *',
    '  Cache-Control: public, max-age=60',
    '/Clicker.apk',
    '  Content-Type: application/vnd.android.package-archive',
    '  Content-Disposition: attachment; filename="Clicker.apk"',
    '  Cache-Control: no-cache',
    '',
  ].join('\n'));
  console.log('files:', fs.readdirSync(out).join(' '));
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', 'deploy', '--config', path.join(root, 'install', 'wrangler.toml')], { stdio: 'inherit', cwd: path.join(root, 'install'), shell: process.platform === 'win32' });
  console.log('published:', pageUrl);
})().catch((e) => { console.error(e.message); process.exit(1); });
