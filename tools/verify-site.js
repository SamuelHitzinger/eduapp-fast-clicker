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
