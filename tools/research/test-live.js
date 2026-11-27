// Read-only live smoke test: real eduapp.ethz.ch GETs with the session cookie; any non-GET is refused locally.
const fs = require('fs'), path = require('path'); const { JSDOM } = require('jsdom');
const base = path.resolve(__dirname, '..', '..');
const script = fs.readFileSync(path.join(base, 'fast-clicker/eduapp-fast-clicker.user.js'), 'utf8');
const ck = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).filter((c) => (c.path || '/') === '/').map((c) => `${c.name}=${c.value}`).join('; ');
const log = [];
async function liveFetch(url, opts = {}) {
  const u = new URL(url, 'https://eduapp.ethz.ch');
  if ((opts.method || 'GET') !== 'GET') { log.push(`BLOCKED ${opts.method} ${u.pathname}`); throw new Error('blocked in test'); }
  const t = Date.now();
  const r = await fetch(u, { ...opts, headers: { ...opts.headers, Cookie: ck } });
  log.push(`${r.status} ${u.pathname}${u.search.slice(0, 40)} ${Date.now() - t} ms`);
  return r;
}
(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://eduapp.ethz.ch/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; w.fetch = liveFetch; w.AbortController = AbortController; w.alert = () => {};
  w.eval(script);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !(w.__fastClicker.state.lastPollAt && log.some((l) => l.includes('/web/gw/clickers?')))) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1500));
  const st = w.__fastClicker.state; st.running = false;
  const root = w.document.getElementById('fast-clicker-host').shadowRoot;
  console.log(log.join('\n'));
  console.log('\nstatus:', root.getElementById('stat')?.textContent, '| error:', st.lastError);
  console.log('open clickers shown:', [...root.querySelectorAll('.card h3')].map((h) => h.textContent));
  console.log('lectures today:', st.lectures.map((l) => `${l.code} ${l.start}-${l.end}`).join(', '));
  process.exit(0);
})();
