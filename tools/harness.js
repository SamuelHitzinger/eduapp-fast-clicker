// Shared jsdom harness + mock EduApp server for the Fast Clicker tests (no requests to ETH).
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const base = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(base, 'fast-clicker/eduapp-fast-clicker.user.js'), 'utf8');
// Synthetic EduApp data (tools/fixtures/make.js); FC_DATA=data runs the same tests against a local capture instead.
const dataDir = process.env.FC_DATA ? path.resolve(base, process.env.FC_DATA) : path.join(__dirname, 'fixtures');
const load = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
const detail = load('clicker_322454.json');
const feed0 = load('activity_feed.json');
const list = load('clickers_list.json');
const clone = (o) => JSON.parse(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(15); } return !!fn(); }
let actId = 990000;

function makeServer({ lectureNow = true, chaos = null } = {}) {
  const now = Date.now();
  const S = {
    feed: clone(feed0), clickers: new Map([[322454, clone(detail)]]), list: clone(list),
    votes: [], log: [], urls: [], auth: true,
    failVotes: 0, voteDelay: 0, failDetail: new Map(), detailDelay: new Map(), forbid: new Set(),
    feedInFlight: 0, feedMaxInFlight: 0, voteInFlight: new Map(), voteMaxInFlight: 0,
    lectures: lectureNow ? [{ code: '401-0261-00', title: { en: 'Analysis I' }, start: new Date(now - 30 * 60e3).toISOString(), end: new Date(now + 60 * 60e3).toISOString() }] : [],
    chaos,
    push(ev) { S.feed.unshift({ id: ++actId, createdAt: new Date().toISOString(), ...ev }); },
    addClicker(c) { S.clickers.set(c.id, c); },
  };
  const respond = (status, body, headers = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const h = { 'content-type': status === 401 ? 'text/html' : 'application/json', ...headers };
    return { ok: status >= 200 && status < 300, status, type: 'basic', headers: { get: (k) => h[k.toLowerCase()] ?? null }, text: async () => (status === 401 ? '<html>401</html>' : text) };
  };
  const abortable = (signal, ms) => new Promise((res, rej) => {
    const t = ms === Infinity ? null : setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
  });
  S.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'https://eduapp.ethz.ch');
    S.urls.push(u.pathname + u.search);
    (S.reqs = S.reqs || []).push({ t: Date.now(), p: u.pathname });
    u.searchParams.delete('_fc');
    const p = u.pathname.replace('/web/gw/', '') + (u.search || '');
    const method = opts.method || 'GET';
    S.log.push(`${method} ${p}`);
    if (u.pathname === '/oauth2/userinfo') return S.user ? new Response(JSON.stringify({ email: S.user, user: S.user }), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 });
    const isFeed = p.startsWith('dashboard/activity-feed');
    const voteM = p.match(/^clickers\/(\d+)\/vote$/);
    if (isFeed) { S.feedInFlight++; S.feedMaxInFlight = Math.max(S.feedMaxInFlight, S.feedInFlight); }
    const vid = voteM && Number(voteM[1]);
    if (vid) { S.voteInFlight.set(vid, (S.voteInFlight.get(vid) || 0) + 1); S.voteMaxInFlight = Math.max(S.voteMaxInFlight, S.voteInFlight.get(vid)); }
    try {
      const ch = S.chaos;
      if (ch) {
        await abortable(opts.signal, ch.minMs + Math.random() * (ch.maxMs - ch.minMs));
        const r = Math.random();
        if (r < ch.hang) await abortable(opts.signal, Infinity);
        else if (r < ch.hang + ch.reset) throw new TypeError('Failed to fetch');
        else if (r < ch.hang + ch.reset + ch.err503) return respond(503, {}, Math.random() < 0.3 ? { 'retry-after': '0' } : {});
      } else await abortable(opts.signal, isFeed ? 20 : 5);
      if (!S.auth) return respond(401);
      if (p === 'semesters/current') return respond(200, { semkez: '2026W' });
      if (p.startsWith('dashboard/upcoming-lectures')) return respond(200, S.lectures);
      if (isFeed) return respond(200, S.feed.slice(0, Number(u.searchParams.get('maxActivities'))));
      if (p.startsWith('clickers?semkez')) return respond(200, S.list);
      if (voteM && method === 'POST') {
        if (S.voteDelay) await abortable(opts.signal, S.voteDelay);
        if (S.failVotes > 0) { S.failVotes--; return respond(503); }
        const body = JSON.parse(opts.body);
        const c = S.clickers.get(vid);
        if (!c || c.state !== 'OPEN') return respond(409);
        S.votes.push({ id: vid, body, round: c.round || 0, at: Date.now() });
        if (c.type === 'TEXT') c.individualAnswer = body.individualAnswer;
        else c.entries.forEach((e) => { e.selected = body.selectedAnswer.includes(e.id); });
        if (ch && Math.random() < ch.lostReply) throw new TypeError('Failed to fetch'); // applied, but reply lost
        return respond(200);
      }
      const m = p.match(/^clickers\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        const snapshot = S.clickers.has(id) ? clone(S.clickers.get(id)) : null;
        if (S.detailDelay.get(id)) await abortable(opts.signal, S.detailDelay.get(id));
        if (S.failDetail.get(id) > 0) { S.failDetail.set(id, S.failDetail.get(id) - 1); return respond(503); }
        if (S.forbid.has(id)) return respond(403, {});
        return snapshot ? respond(200, snapshot) : respond(404);
      }
      return respond(404);
    } finally {
      if (isFeed) S.feedInFlight--;
      if (vid) S.voteInFlight.set(vid, S.voteInFlight.get(vid) - 1);
    }
  };
  return S;
}

// A Cache Storage stand-in that survives from one boot to the next (the app being closed and opened again).
function fakeCaches() {
  const store = new Map();
  return { store, delete: async () => { const had = store.size > 0; store.clear(); return had; }, open: async () => ({
    put: async (k, r) => { store.set(String(k), await r.text()); },
    match: async (k) => (store.has(String(k)) ? { json: async () => JSON.parse(store.get(String(k))) } : undefined),
    delete: async (k) => store.delete(String(k)),
  }) };
}

function boot(S, { settings = {}, hooks = {}, mode, url = 'https://eduapp.ethz.ch/clickers', locks, BroadcastChannel, caches, preset = {} } = {}) {
  const dom = new JSDOM('<!doctype html><head></head><body><div id="app"></div></body>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = S.fetch; w.alert = () => {}; w.confirm = () => false;
  w.AbortController = AbortController;
  if (locks) Object.defineProperty(w.navigator, 'locks', { value: locks, configurable: true });
  if (BroadcastChannel) w.BroadcastChannel = BroadcastChannel;
  if (caches) { w.caches = caches; w.Response = Response; }
  w.localStorage.setItem('fast-clicker-settings', JSON.stringify({ cadenceMs: 120, hiddenCadenceMs: 120, idleCadenceMs: 120, maxBackoffMs: 300, authCadenceMs: 150, loginCadenceMs: 150, silentEveryMs: 300, soloMinMs: 120, ...settings }));
  for (const [k, v] of Object.entries(preset)) w.localStorage.setItem(k, v);
  w.__FC_HOOKS = hooks;
  if (mode) w.__FC_MODE = mode;
  w.eval(script);
  const root = w.document.getElementById('fast-clicker-host').shadowRoot;
  // stop the client first; close its window a little later, so a request that is still under way can finish
  // stop the client and cut it off from the mock server; close its window a little later, so nothing still under way
  // runs into a closed document
  return { w, root, fc: w.__fastClicker, stop: () => {
    try { w.__fastClicker.state.running = false; w.__fastClicker.state.leader = false; } catch {}
    w.fetch = () => Promise.reject(new TypeError('test client stopped'));
    setTimeout(() => w.close(), 3000).unref();
  } };
}
const mcsa = (id, title = 'Q') => ({ id, type: 'MCSA', state: 'OPEN', title, question: '<p>2+2?</p>', answerState: 'UNANSWERED', entries: [{ id: 1, answer: '3', selected: false }, { id: 2, answer: '4', selected: false }, { id: 3, answer: '5', selected: false }], showResults: false, preview: false });
const st = (root, id) => root.querySelector(`.card[data-id="${id}"] .st`)?.textContent || '';

module.exports = { makeServer, boot, fakeCaches, mcsa, st, until, wait, clone, detail, script };
