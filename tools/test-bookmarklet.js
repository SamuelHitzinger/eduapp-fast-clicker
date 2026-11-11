// Runs the BUILT bookmarklet from site/index.html the way a browser does (percent-decode, then execute).
const fs = require('fs'), path = require('path'); const { JSDOM } = require('jsdom');
const { makeServer, until } = require('./harness');
const h = fs.readFileSync(path.resolve(__dirname, '../site/index.html'), 'utf8');
const full = JSON.parse(h.match(/const FULL = (".*?");\r?\n/s)[1]);
const code = decodeURIComponent(full.slice('javascript:'.length));
const results = []; const check = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
(async () => {
  const S = makeServer();
  const dom = new JSDOM('<!doctype html><body><div id="app">EduApp UI</div></body>', { url: 'https://eduapp.ethz.ch/dashboard', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; w.fetch = S.fetch; w.AbortController = AbortController;
  w.eval(code);
  const root = w.document.getElementById('fast-clicker-host').shadowRoot;
  check('K1 built bookmarklet starts focus mode on EduApp', w.document.getElementById('fast-clicker-host').classList.contains('focus') && !w.document.getElementById('app'));
  check('K2 shows the open question', await until(() => root.querySelector('.card[data-id="322454"]')));
  w.eval(code); // tapping the bookmark again
  check('K3 tapping again does not start a second copy', w.document.querySelectorAll('#fast-clicker-host').length === 1);
  w.__fastClicker.state.running = false; w.close();
  const other = new JSDOM('<!doctype html><body>news</body>', { url: 'https://www.example.org/', runScripts: 'outside-only' });
  let asked = '';
  other.window.confirm = (m) => { asked = m; return false; };
  other.window.eval(code);
  check('K4 on another site it offers to open EduApp instead', /Open EduApp/.test(asked) && !other.window.document.getElementById('fast-clicker-host'));
  console.log(results.join('\n')); process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
