// Checks the built install page: bookmarklet decodes + parses, no raw '#'/newlines, SRI matches the pinned file.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const site = path.resolve(__dirname, '../site');
const h = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
const full = JSON.parse(h.match(/const FULL = (".*?");\r?\n/s)[1]);
const code = decodeURIComponent(full.slice('javascript:'.length));
new Function(code);
const file = JSON.parse(h.match(/const SHORT_FILE = (".*?")/)[1]);
const sri = JSON.parse(h.match(/SHORT_SRI = (".*?")/)[1]);
const actual = 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(path.join(site, file))).digest('base64');
console.log('bookmarklet parses:', true, '| raw #:', full.includes('#'), '| raw newline:', /[\r\n]/.test(full), '| SRI matches pinned file:', sri === actual);

// every app gets the same build, with the relay address from relay/relay-url.txt (if any)
const pinned = fs.readFileSync(path.join(site, file), 'utf8');
const relayFile = path.resolve(__dirname, '../relay/relay-url.txt');
const relayUrl = fs.existsSync(relayFile) ? fs.readFileSync(relayFile, 'utf8').trim() : '';
const copies = ['ios/FastClicker/Resources/fast-clicker.js', 'android/app/src/main/assets/fast-clicker.js', 'site/extension/fast-clicker.js']
  .map((p) => [p, fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')]);
const same = copies.every(([, c]) => c === pinned);
const relayIn = !relayUrl || [pinned, code, ...copies.map(([, c]) => c)].every((c) => c.includes(JSON.stringify(relayUrl)));
console.log('apps and add-on carry the pinned build:', same, '| relay address in every build:', relayIn, relayUrl ? `(${relayUrl})` : '(none configured)');
if (!same || !relayIn) process.exit(1);
