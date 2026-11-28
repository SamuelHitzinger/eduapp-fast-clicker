// ==UserScript==
// @name         ETH Clicker (unofficial)
// @namespace    https://eduapp.ethz.ch/
// @version      3.6.0
// @description  Shows opened ETH EduApp clicker questions within seconds and gets your answer through even on bad Wi-Fi.
// @match        https://eduapp.ethz.ch/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
//
// How the stock EduApp web client works (reverse engineered from eduapp.ethz.ch, Nov 2026):
//   * REST under /web/gw/, same origin, HTTP/2, auth = oauth2-proxy cookie + Keycloak at /keycloak (same
//     origin). Sessions expire after a few hours; then every API call gets a plain nginx 401.
//   * No push (Firebase disabled in /config.json), no WebSocket/SSE, no refetchInterval: a newly opened clicker
//     only appears when you navigate or re-focus. Each refresh of the clicker page downloads the whole
//     semester (GET clickers?semkez: 2.6 MB / 1.1 MB gzip, ~1 s). The dashboard re-fetches ~25 clicker
//     details (~1 MB) on every focus; a 224 KB service-worker update check runs every 5 min.
//   * GET clickers/{id} ~25 ms server time, ~40 KB.  POST clickers/{id}/vote {"selectedAnswer":[ids]} |
//     {"individualAnswer":"text"}; re-voting overwrites. Stock client: retry=false, 401 ⇒ full-page redirect.
//   * GET dashboard/activity-feed?semkez&maxActivities=N: ~1.2 s server time, ~0.3 KB/event, newest first,
//     clicker events (CLICKER_OPEN, *_ROUND, CLICKER_CLOSE) carry the clicker id. Cheapest change signal.
//   * A Workbox service worker answers GET /web/gw/* NetworkFirst and falls back to Cache Storage; requests
//     here carry a unique "_fc" query parameter (ignored by the server) so the fallback can never match.
//
// What this script does:
//   * polls the small activity feed: one request at a time, ~every 4 s around your lectures, slower otherwise,
//     backing off when the network or server struggles; only one browser tab polls, others get its updates,
//   * fetches just the affected clicker and alerts you (sound, vibration, notification),
//   * sends an answer once at a time per question, keeps retrying until it gets through (or the round changes),
//     reports "accepted" immediately and verifies in the background, repairing if the server disagrees,
//   * renews an expired login silently when ETH single sign-on is still valid, otherwise with one tap,
//   * focus mode (bookmarklet): stops the EduApp page's own background traffic and keeps the screen awake,
//   * looks like EduApp's own clicker section (list by date / by lecture, question page, results), cached and live,
//   * optional shared discovery: with a relay configured, the students of one lecture take turns checking the
//     feed and tell each other "clicker N changed"; everyone still reads questions and votes directly at ETH.
//     The relay never sees logins, questions or answers (relay/README.md).
(() => {
  'use strict';
  const VERSION = '3.6.0';
  const RELAY_URL = '';     // wss://… of the hint relay; empty = every client checks the feed itself (set by tools/build.js)
  const CONTROL_URL = '';   // https://…/control.json on the install site; empty = no remote control (set by tools/build.js)
  const MODE = window.__FC_MODE === 'focus' ? 'focus' : 'panel';
  if (window.__fastClicker) { window.__fastClicker.show(MODE); return; }
  if (location.hostname !== 'eduapp.ethz.ch') {
    if (confirm('ETH Clicker works inside EduApp.\n\nOpen EduApp now? Once it has loaded, tap the Clicker bookmark again.')) {
      location.href = 'https://eduapp.ethz.ch/';
    }
    return;
  }

  const TIMER_WATERMARK = setTimeout(() => {}, 0); // timer ids up to here belong to the EduApp page
  const API = '/web/gw/';
  const SW_CACHE = 'api-requests';
  const LS_KEY = 'fast-clicker-settings';
  // Settings saved before v3.2 (when the drawer had switches) are reduced to what can still be changed, so a
  // switch nobody can see any more (e.g. "Always check fast", "1-tap send") cannot stay on; the old timing
  // recording is deleted from the device.
  function loadCfg() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch {}
    if ('record' in saved) {
      saved = { groupBy: saved.groupBy, theme: saved.theme, expanded: saved.expanded };
      for (const k in saved) if (saved[k] === undefined) delete saved[k];
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(saved));
        localStorage.removeItem('fast-clicker-rec'); localStorage.removeItem('fast-clicker-rec-default');
      } catch {}
    }
    return saved;
  }
  const CFG = Object.assign({
    cadenceMs: 4000,         // start-to-start feed poll interval around lectures (feed takes ~1.2 s itself)
    hiddenCadenceMs: 15000,  // same, while the tab is in the background
    idleCadenceMs: 50000,    // outside lectures (stays below the server's ~75 s keep-alive, so the line stays warm)
    maxBackoffMs: 30000, lectureBackoffMs: 10000,   // after failures: wait at most this long between tries (around lectures: shorter)
    authCadenceMs: 15000, loginCadenceMs: 5000, silentEveryMs: 60000,
    leadMin: 10, tailMin: 15, // "around a lecture" = 10 min before start … 15 min after end
    openFastMin: 30,          // an open clicker keeps fast polling for at most this long after its last event
    voteDeadlineMs: 120000,   // keep trying to deliver an answer this long
    feedSmall: 8, feedLarge: 60,
    catchUpMax: 25,           // at start, read at most this many questions that closed while the app was off
    onScreenFastMs: 20 * 60e3, // open on screen outside lectures: fast checks for 20 min after the last touch
    diag: true, diagEveryMin: 10, // anonymous beta diagnostics (see "anonymous beta diagnostics"); only with a relay configured
    diagHideMinMs: 120000,    // leaving the app sends the period report early, but not more often than this
    diagJitterMs: 30000,      // a question report waits up to this long, so a hall's reports don't arrive at once
    diagRoomSample: 20,       // in a room of more students, only about this many report each question (D1 write budget)
    catchUpRecentH: 12,       // …and with no saved list yet, only those of the last 12 hours
    scanIfFeedSpanH: 6,       // skip the 1.1 MB list at start-up if the 25 newest events reach back this far
    oneTap: false, turbo: false, sound: true, keepAwake: true,
    groupBy: 'date', theme: 'auto', expanded: {}, autoOpen: true,
    shareMinMs: 500, shareMaxMs: 180000,  // sharing: a client's own check is never further apart than shareMaxMs
    soloStepMs: 1000, soloMaxMs: 30000,   // relay unreachable: check alone every (students last seen sharing) x step, at most max
    soloMinMs: 8000, soloPerMemberMs: 15,  // …and at least every 8 s, 15 ms per student last seen in the room (a hall of 2000: 30 s)
    standbyPerMemberMs: 300, standbyMinMs: 60000, standbyMaxMs: 300000,   // sharing but not a scout: own safety check every members x 300 ms (1-5 min)
  }, loadCfg());
  // only the list layout and the theme are the student's to change (v3.2 has no settings drawer)
  const saveCfg = () => { try { localStorage.setItem(LS_KEY, JSON.stringify({ groupBy: CFG.groupBy, theme: CFG.theme, expanded: CFG.expanded })); } catch {} };
  const hooks = window.__FC_HOOKS || {}; // test seams and the native app's bridge
  const TS = hooks.timeScale || 1;

  class AuthError extends Error {}
  class HttpError extends Error { constructor(status, msg, retryAfterMs) { super(msg); this.status = status; this.retryAfterMs = retryAfterMs; } }
  class NetError extends Error {}
  const isTransient = (e) => e instanceof NetError || (e instanceof HttpError && (e.status >= 500 || e.status === 429 || e.status === 408));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms, f = 0.15) => Math.round(ms * (1 - f + Math.random() * 2 * f));
  // run fn over items with at most `n` at a time (start-up catch-up must not burst ETH with dozens of requests)
  async function pool(items, n, fn) {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
  }

  // ---------------------------------------------------------------- anonymous beta diagnostics
  // Numbers only, so the beta can be watched (how fast questions arrive, whether answers get through, how hard EduApp is
  // being asked): request counts, timings and error classes, question delays, vote outcomes, relay state. No names,
  // logins, course names, question texts or answers; a random id per installation (not linked to the ETH account).
  // Sent to the relay's /v1/report every 10 minutes and when a question opens; nothing if no relay is configured.
  const diag = { since: Date.now(), req: {}, vote: { n: 0, ok: 0, fail: 0, att: 0, ms: 0 }, hints: 0, hintReads: 0, samples: 0, open: 0, fast: 0, screen: 0, sent: 0 };
  function diagReq(kind, ms, outcome) {
    const k = kind === 'feed' || kind === 'detail' || kind === 'vote' || kind === 'list' ? kind : 'other';
    const d = diag.req[k] || (diag.req[k] = { n: 0, ok: 0, e5: 0, e429: 0, e4: 0, net: 0, to: 0, auth: 0, ms: 0, max: 0 });
    d.n++; d[outcome]++;
    if (outcome === 'ok') { d.ms += ms; d.max = Math.max(d.max, ms); }
  }

  // ---------------------------------------------------------------- network
  const lat = { feed: 1300, detail: 500, vote: 500, other: 400, list: 3000 }; // EWMA of observed latency (ms), raised after a timeout: sets time limits
  const latOk = { feed: 1300 };    // the feed's latency from answers that arrived (timeouts excluded): sets the pause between checks
  const minTimeout = { feed: 7000, detail: 7000, vote: 8000, other: 6000, list: 60000 };
  const timeoutFor = (kind) => Math.round(TS * Math.min(kind === 'list' ? 120000 : 30000, Math.max(minTimeout[kind], Math.round(3 * lat[kind] + 2500))));
  let reqCounter = 0;

  async function req(path, { method = 'GET', body, kind = 'other', priority = 'high' } = {}) {
    if (hooks.offline || navigator.onLine === false) throw new NetError('offline');
    const timeoutMs = timeoutFor(kind);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = performance.now();
    const url = API + path + (method === 'GET' ? `${path.includes('?') ? '&' : '?'}_fc=${Date.now().toString(36)}${(++reqCounter).toString(36)}` : '');
    let r;
    try {
      r = await fetch(url, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual',            // an expired session must not silently follow the login redirect
        priority,                      // fetch priority hint (ignored where unsupported)
        keepalive: method === 'POST',  // a small vote survives the tab being closed/backgrounded
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') lat[kind] = Math.max(lat[kind], 2 * timeoutMs / TS);   // next time wait (much) longer, up to the cap
      diagReq(kind, 0, e && e.name === 'AbortError' ? 'to' : 'net');
      throw new NetError(e && e.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'network error');
    }
    const serverDate = Date.parse(r.headers.get('date') || '');
    if (serverDate) state.serverOffset = serverDate + 500 - Date.now();   // the header has whole seconds
    try {
      if (r.status === 401 || r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) { diagReq(kind, 0, 'auth'); throw new AuthError('signed out'); }
      if (!r.ok) {
        diagReq(kind, 0, r.status === 429 ? 'e429' : r.status >= 500 ? 'e5' : 'e4');
        const raw = r.headers.get('retry-after');
        let ra = Number(raw);
        if (raw && !Number.isFinite(ra)) { const d = Date.parse(raw); ra = d ? (d - Date.now()) / 1000 : NaN; }   // an HTTP date
        const raMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : undefined;
        if (raMs) state.notBefore = Math.max(state.notBefore, Date.now() + raMs);   // ETH asked for a pause: no feed checks or hint reads before then
        throw new HttpError(r.status, `HTTP ${r.status}`, raMs);
      }
      const text = await r.text();
      const ct = r.headers.get('content-type') || '';
      if (text && !ct.includes('json')) throw new AuthError('signed out (got a web page instead of data)');
      const ms = performance.now() - t0;
      diagReq(kind, ms, 'ok');
      lat[kind] = Math.round(lat[kind] * 0.7 + ms * 0.3);
      if (kind === 'feed') latOk.feed = Math.round(latOk.feed * 0.7 + ms * 0.3);
      state.lastLatency = Math.round(ms);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (e && e.name === 'AbortError') { lat[kind] = Math.max(lat[kind], 2 * timeoutMs / TS); throw new NetError(`no answer within ${Math.round(timeoutMs / 1000)} s`); }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sweepSwCache() {
    try {
      if (!window.caches) return;
      const c = await caches.open(SW_CACHE);
      for (const k of await c.keys()) if (k.url.includes('_fc=')) await c.delete(k);
    } catch {}
  }

  // ---------------------------------------------------------------- state
  const state = {
    semkez: null,
    lectures: [], lecturesFetchedAt: 0,
    seenActivities: new Set(),   // processed (acknowledged) activity ids
    receivedActivities: new Set(), // every activity id any feed response contained (for gap detection)
    gapCount: 0,
    roundApplied: new Set(),     // activity ids whose round change was already applied (retries must not re-apply)
    pendingRefresh: new Map(),
    clickers: new Map(),         // id -> detail + {courseTitle, gen, roundStopped, lastEventAt, fetchedAt}
    seq: new Map(),              // id -> {issued, applied, floor}
    inflight: new Map(),         // id -> {promise, my} coalesced detail fetches
    dismissed: new Set(),
    draft: new Map(), draftVer: 0,
    sending: new Set(), resend: new Set(),
    sentGen: new Map(),          // id -> the round (gen) whose answer the server accepted: "vote again" until it matches
    stamp: new Map(),            // id -> stamp of the newest send in ANY tab (time-based, broadcast to other tabs)
    unverified: new Map(),       // id -> {ans, gen, ver, stamp, took, repair, rechecks}: accepted, not yet re-read
    status: new Map(),
    scanDone: false, feedSpanOk: false, feedPrimed: false, lastOwnPollAt: 0,
    lastPollAt: 0, lastLatency: null, lastError: null, errorStreak: 0, retryAfterMs: 0,
    authLost: false, loginNeeded: false,
    running: true, timer: null, polling: false,
    leader: false,
    evTurn: new Map(), evBusy: new Set(),       // per question: which feed event is the newest / is being handled
    hold: new Map(),                            // id -> {until, at}: answer retries wait for the feed's word on a possible new round
    lastFeedStartAt: 0, serverOffset: 0, notBefore: 0, dueAt: 0,
    list: { byDate: [], byCourse: [], fetchedAt: 0, partial: true }, listIndex: new Map(), listRev: 0, listError: null,   // partial = only what was seen live
  };

  // ---------------------------------------------------------------- tabs: one poller, others follow
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('fast-clicker') : null;
  const strip = (c) => { const o = {}; for (const k in c) o[k] = c[k]; return o; };
  function broadcast(msg) { try { bc && bc.postMessage(msg); } catch {} }
  if (bc) bc.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.t === 'clicker' && m.c) {
      const local = state.clickers.get(m.c.id);
      if (local && local.fetchedAt > m.c.fetchedAt) return;
      if (local && m.c.gen > (local.gen || 0)) resetRound(m.c.id);
      state.clickers.set(m.c.id, m.c);
      patchList(m.c, true);
      if (m.alert) { state.dismissed.delete(m.c.id); if (!document.hidden) notify(m.c, false); }
      render();
    } else if (m.t === 'send' && m.id) {                // another tab sent an answer for this question
      if (m.stamp > (state.stamp.get(m.id) || 0)) {
        state.stamp.set(m.id, m.stamp);
        state.unverified.delete(m.id);
        state.draft.delete(m.id);
        state.status.set(m.id, { kind: 'pending', text: 'Answer being sent from another tab…' });
        render();
      }
    } else if (m.t === 'status') {
      if (state.leader) return;                          // the polling tab owns this state
      Object.assign(state, { lastPollAt: m.lastPollAt, lastError: m.lastError, authLost: m.authLost, loginNeeded: !!m.loginNeeded, lectures: m.lectures || state.lectures });
      if (!state.lecturesFetchedAt && m.lectures) state.lecturesFetchedAt = Date.now();
      render();
    } else if (m.t === 'hello' && state.leader) {
      for (const c of state.clickers.values()) if (c.state === 'OPEN') broadcast({ t: 'clicker', c: strip(c) });
      broadcastStatus();
    }
  };
  window.addEventListener('pagehide', (e) => { if (!e.persisted && bc) bc.close(); });
  const broadcastStatus = () => { if (state.leader) broadcast({ t: 'status', lastPollAt: state.lastPollAt, lastError: state.lastError, authLost: state.authLost, loginNeeded: state.loginNeeded, lectures: state.lectures }); };

  function becomeLeader() {
    state.leader = true;
    render();
    schedule(0);
  }
  let releaseLeader = null;
  function electLeader() {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('fast-clicker-poller', () => new Promise((release) => {
        if (!state.running || control.old) { release(); return; }   // stopped (or too old) while queued: pass leadership on
        releaseLeader = release;
        becomeLeader();
      })).catch(() => becomeLeader());
      broadcast({ t: 'hello' });
    } else becomeLeader();
  }
  function resignLeader() {
    state.leader = false;
    clearTimeout(state.timer); state.dueAt = 0;
    if (releaseLeader) { const r = releaseLeader; releaseLeader = null; r(); }
  }

  // ---------------------------------------------------------------- timetable / mode
  const nowIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  async function loadLectures() {
    try {
      state.lectures = await req(`dashboard/upcoming-lectures?start=${encodeURIComponent(nowIso(-4 * 3600e3))}&days=1`, { priority: 'low' }) || [];
      state.lecturesFetchedAt = Date.now();
    } catch (e) { if (e instanceof AuthError) throw e; }
  }
  const currentLectures = () => {
    const t = Date.now();
    return state.lectures.filter((l) => t >= Date.parse(l.start) - CFG.leadMin * 60e3 && t <= Date.parse(l.end) + CFG.tailMin * 60e3);
  };
  const currentLecture = () => currentLectures()[0];
  const isLive = (c) => c.state === 'OPEN' && !state.dismissed.has(c.id);
  const hasFreshOpen = () => [...state.clickers.values()].some((c) => isLive(c) && !c.roundStopped && Date.now() - c.lastEventAt < CFG.openFastMin * 60e3);
  // fast checking: around your lectures (timetable), while a question is open, and whenever the clicker is open full
  // screen and on screen (the iPhone app, focus mode), e.g. in an exercise class that is not in the timetable
  // (an app left lying open outside lectures falls back to the slow pace after 20 minutes without a touch)
  let lastUseAt = Date.now();
  for (const evName of ['pointerdown', 'keydown', 'touchstart', 'wheel']) window.addEventListener(evName, () => { lastUseAt = Date.now(); }, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) lastUseAt = Date.now(); });
  const onScreen = () => mode === 'focus' && !document.hidden && Date.now() - lastUseAt < CFG.onScreenFastMs;
  const fastMode = () => CFG.turbo || onScreen() || hasFreshOpen() || !!currentLecture() || !state.lecturesFetchedAt;

  // ---------------------------------------------------------------- clicker details
  function fetchClicker(id) {
    const s = state.seq.get(id) || { issued: 0, applied: 0, floor: 0 };
    state.seq.set(id, s);
    const inf = state.inflight.get(id);
    if (inf && inf.my >= s.floor) return inf.promise;    // coalesce: one download per clicker at a time
    const my = ++s.issued;
    const promise = (async () => {
      try {
        const c = await req(`clickers/${id}`, { kind: 'detail' });
        if (my < s.floor || my < s.applied) return { detail: state.clickers.get(id), applied: false, fresh: c };
        s.applied = my;
        const prev = state.clickers.get(id);
        Object.assign(c, {
          courseTitle: prev ? prev.courseTitle : null,
          gen: prev ? prev.gen : 0,
          roundStopped: prev ? prev.roundStopped : false,
          lastEventAt: prev ? prev.lastEventAt : 0,
          hintOpenAt: prev ? prev.hintOpenAt || 0 : 0,
          fetchedAt: Date.now(),
        });
        state.clickers.set(id, c);
        patchList(c, false);
        if (my >= s.floor) checkVerification(id, c);   // any post-vote download can complete a verification
        return { detail: c, applied: true, fresh: c };
      } finally {
        if (state.inflight.get(id) && state.inflight.get(id).my === my) state.inflight.delete(id);
      }
    })();
    state.inflight.set(id, { promise, my });
    return promise;
  }
  function fence(id) {                // responses to requests issued before now must not be applied
    const s = state.seq.get(id) || { issued: 0, applied: 0, floor: 0 };
    s.floor = s.issued + 1; state.seq.set(id, s);
  }
  const ROUND_KEEP = new Set(['CLICKER_CLOSE', 'CLICKER_STOP_ROUND']);
  function publish(c, alert) { c.fetchedAt = Date.now(); broadcast({ t: 'clicker', c: strip(c), alert }); }

  const serverNow = () => Date.now() + state.serverOffset;
  async function processClickerEvent(id, meta, initial) {
    const prev = state.clickers.get(id);
    const turn = (state.evTurn.get(id) || 0) + 1;
    state.evTurn.set(id, turn);
    state.evBusy.add(id);
    try {
      if (!initial) fence(id);
      // A relay hint may already have made this client read this question right after it opened (hintRefresh). A feed
      // event dated no later than that read describes the same opening, not a new round after it.
      // Only a lone "opened" event qualifies: a restarted round (or a close + reopen) is always a new round.
      const sameOpening = !initial && !!prev && meta.type === 'CLICKER_OPEN' && meta.single === true && prev.hintOpenAt > 0
        && (Date.parse(meta.createdAt) || Infinity) <= prev.hintOpenAt + 1500;
      // a (possible) new round: invalidate drafts and in-flight sends now, once per event, before downloading
      if (!initial && prev && !sameOpening && !ROUND_KEEP.has(meta.type) && !state.roundApplied.has(meta.activityId)) {
        prev.gen = (prev.gen || 0) + 1; state.roundApplied.add(meta.activityId); resetRound(id);
        if (meta.type === 'GAP') state.status.set(id, { kind: 'warn', text: 'Connection gap: a new round may have started. Check your answer and send again.' });
      }
      const { detail: c } = await fetchClicker(id);
      if (state.evTurn.get(id) !== turn) return;                 // a newer event for this question took over meanwhile
      if (meta.type !== 'GAP') c.hintOpenAt = 0;                 // handled: from now on the feed alone speaks for this question
      if (meta.courseTitle) c.courseTitle = meta.courseTitle;
      if (meta.courseCode) c.courseCode = meta.courseCode;
      if (meta.type !== 'GAP') c.lastEventAt = meta.createdAt ? Math.min(Date.now(), Date.parse(meta.createdAt) || Date.now()) : Date.now();
      if ((meta.type === 'CLICKER_OPEN' || meta.type === 'CLICKER_START_ROUND') && Date.parse(meta.createdAt)) { c.openedAtSrv = Date.parse(meta.createdAt); c.openedVia = 'feed'; }
      if (meta.type === 'CLICKER_STOP_ROUND') c.roundStopped = true;
      else if (meta.type !== 'CLICKER_CLOSE' && meta.type !== 'GAP') c.roundStopped = false;
      const alert = !sameOpening && meta.type !== 'GAP' && c.state === 'OPEN' && !c.roundStopped && (!initial || Date.now() - c.lastEventAt < 3 * 3600e3);
      patchList(c, true);
      if (alert) { state.dismissed.delete(id); notify(c, true); }
      publish(c, alert);
    } finally {
      if (state.evTurn.get(id) === turn) state.evBusy.delete(id);
    }
  }
  function resetRound(id) {           // answers of a previous round must be chosen again explicitly
    state.draft.delete(id); state.status.delete(id); state.resend.delete(id); state.unverified.delete(id);
  }

  async function pollFeed(initial) {
    const gapSuspicious = !initial && Date.now() - state.lastOwnPollAt > 3 * CFG.hiddenCadenceMs;
    let n = initial || gapSuspicious || state.widenNext ? CFG.feedLarge : CFG.feedSmall;
    state.lastFeedStartAt = Date.now();
    relay.confirmDue = 0;
    let feed = await req(`dashboard/activity-feed?semkez=${state.semkez}&maxActivities=${n}`, { kind: 'feed' }) || [];
    if (state.cacheP) { const p = state.cacheP; state.cacheP = null; await p; }
    const burst = state.burstIds || null;                         // what the narrow check of a burst already took in
    const allNew = (f) => f.length >= n && f.every((a) => !state.receivedActivities.has(a.id) || (burst && burst.has(a.id)));
    // burst (everything new): the next check, at the normal spacing, asks for the wider window (never two at once)
    if (!initial && n < CFG.feedLarge && allNew(feed)) { state.widenNext = true; state.burstIds = new Set(feed.map((a) => a.id)); }
    else if (n >= CFG.feedLarge) { state.widenNext = false; state.burstIds = null; }
    const gap = !initial && n >= CFG.feedLarge && allNew(feed);
    if (gap) { state.scanDone = false; state.gapCount++; }           // still a gap: reconcile with the list
    for (const a of feed) state.receivedActivities.add(a.id);
    if (initial) {
      const oldest = feed.length ? Date.parse(feed[feed.length - 1].createdAt) : 0;
      state.feedSpanOk = feed.length < n || (oldest && Date.now() - oldest > CFG.scanIfFeedSpanH * 3600e3);
      if (state.feedSpanOk) state.scanDone = true;                   // the feed already covers everything recent
      state.feedReachAt = feed.length >= n && oldest ? oldest : 0;   // the feed only reaches back to here (0 = everything)
    }
    const byClicker = new Map();
    const fresh = [];
    for (const a of feed) {
      if (state.seenActivities.has(a.id)) continue;
      if (a.objectType !== 'CLICKER' || !a.objectId) { state.seenActivities.add(a.id); continue; }
      let g = byClicker.get(a.objectId);
      if (!g) {
        byClicker.set(a.objectId, g = { latest: { activityId: a.id, type: a.type, createdAt: a.createdAt, courseTitle: a.courseTitle && (a.courseTitle.de || a.courseTitle.en) }, ids: [] });
        if (!initial && Number.isSafeInteger(a.id) && Number.isSafeInteger(a.objectId)) fresh.push({ k: a.objectId, e: a.type, a: a.id, c: a.createdAt, titles: a.courseTitle });
      }
      g.ids.push(a.id);
    }
    for (const g of byClicker.values()) g.latest.single = g.ids.length === 1;
    sendHints(fresh);
    for (const [id, p] of state.pendingRefresh) if (!byClicker.has(id)) byClicker.set(id, p);
    if (gap) for (const c of state.clickers.values()) {
      if (c.state === 'OPEN' && !byClicker.has(c.id)) byClicker.set(c.id, { latest: { type: 'GAP', activityId: `gap-${state.gapCount}-${c.id}` }, ids: [] });
    }
    let authErr = null;
    // Catch-up at start: questions that opened and closed while the app was not running are read once (small requests)
    // and filed in the list, unless the saved list already has them as closed. Beyond the cap the list download does it.
    let catchUp = 0;
    const listClosed = (id) => !state.list.partial && (state.listIndex.get(id) || []).some((h) => h.item.state === 'CLOSED');
    await pool([...byClicker], 3, async ([id, g]) => {
      const ack = () => g.ids.forEach((x) => state.seenActivities.add(x));
      if (initial && g.latest.type === 'CLICKER_CLOSE' && !state.clickers.has(id)) {
        if (listClosed(id)) { ack(); return; }
        // No saved list yet: outside lectures the list download right after this covers everything in one go; during a
        // lecture only today's questions are read one by one, the rest comes with the list after the lecture.
        const recent = Date.now() - (Date.parse(g.latest.createdAt) || 0) < CFG.catchUpRecentH * 3600e3;
        if ((state.list.partial && (!fastMode() || !recent)) || ++catchUp > CFG.catchUpMax) { ack(); state.scanDone = false; return; }
      }
      try {
        await processClickerEvent(id, g.latest, initial);
        ack();                                                  // acknowledge only after success
        state.pendingRefresh.delete(id);
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 403)) {   // deleted / not visible: drop
          ack();
          state.pendingRefresh.delete(id);
          if (state.clickers.has(id)) { state.clickers.get(id).state = 'CLOSED'; }
          return;
        }
        state.pendingRefresh.set(id, g);                        // retried next poll
        if (e instanceof AuthError) authErr = e; else state.lastError = `question ${id}: ${e.message}`;
      }
    });
    if (authErr) throw authErr;
    if (state.seenActivities.size > 5000) state.seenActivities = new Set([...state.seenActivities].slice(-1000));
    if (state.receivedActivities.size > 5000) state.receivedActivities = new Set([...state.receivedActivities].slice(-1000));
  }

  async function fullScan() {
    if (!state.semkez) state.semkez = (await req('semesters/current')).semkez;   // a tab that is not the polling one
    const asked = Date.now();
    const list = await req(`clickers?semkez=${state.semkez}`, { kind: 'list', priority: 'low' });
    const todo = [];
    for (const course of (list && list.byCourse) || []) {
      const courseTitle = (course.title && (course.title.de || course.title.en)) || course.code;
      for (const c of course.clickers || []) {
        const known = state.clickers.get(c.id);
        if ((c.state === 'OPEN' && !known) || (known && known.state !== c.state)) todo.push([c.id, courseTitle, known]);
      }
    }
    setList({ byDate: (list && list.byDate) || [], byCourse: (list && list.byCourse) || [], fetchedAt: asked }, true, asked);
    await pool(todo, 3, async ([id, courseTitle, known]) => {
      const reopened = known && known.state !== 'OPEN';
      const { detail } = await fetchClicker(id);
      detail.courseTitle = detail.courseTitle || courseTitle;
      let alert = false;
      if (detail.state === 'OPEN' && (!known || reopened)) {
        if (reopened) { detail.roundStopped = false; detail.gen = (detail.gen || 0) + 1; resetRound(id); }
        detail.lastEventAt = Date.now();
        state.dismissed.delete(id);
        patchList(detail, true);
        notify(detail, true); alert = true;
      }
      publish(detail, alert);
    });
    state.scanDone = true;
  }

  // ---------------------------------------------------------------- history list (what EduApp's clicker page shows)
  // EduApp downloads the whole semester (about 1.4 MB compressed) every time its clicker page is opened. Here it is
  // downloaded at most once in a while, never automatically during a lecture, kept on the device, and patched
  // whenever a question is read.
  const LIST_CACHE = 'fast-clicker-data';
  // The saved list holds this student's own answer marks and results, so it belongs to one ETH account: it is filed
  // under a code made from the logged-in account (never sent anywhere), and a different account on the same device
  // starts with nothing saved. If the account cannot be told (no userinfo), a fresh manual login also clears it.
  const ACCOUNT_KEY = 'fast-clicker-account';
  const listCacheKey = () => '/__fast-clicker/list-' + state.semkez + (state.account ? '-' + state.account : '');
  async function wipeAccountData(full) {   // full: another person is known to be logged in now
    try { if (window.caches) { if (caches.delete) await caches.delete(LIST_CACHE); else { const c = await caches.open(LIST_CACHE); if (c.delete) await c.delete(listCacheKey()); } } } catch {}
    state.list = { byDate: [], byCourse: [], fetchedAt: 0, partial: true }; state.listIndex = new Map(); state.listRev++;
    state.scanDone = false; listCacheTried = false;
    if (!full) return;
    for (const id of [...state.draft.keys()]) state.draft.delete(id);   // an answer chosen by the previous person is never sent for the next one
    state.resend.clear(); state.unverified.clear();
  }
  async function checkAccount() {
    let id = null;
    try {
      const r = await fetch('/oauth2/userinfo?_fc=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), { credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
      if (r.ok) { const j = await r.json(); id = j && (j.email || j.preferredUsername || j.user) || null; }
    } catch {}
    if (!id) return;                                            // unknown: keep what we have
    const acct = hash32('acct|' + String(id).toLowerCase()).slice(0, 16);
    let last = null;
    try { last = localStorage.getItem(ACCOUNT_KEY); } catch {}
    if (last && last !== acct) await wipeAccountData(true);      // someone else logged in on this device
    try { localStorage.setItem(ACCOUNT_KEY, acct); } catch {}
    state.account = acct;
  }
  let listSaveTimer = null;
  function indexList() {
    state.listIndex = new Map();
    const add = (x, course) => { let a = state.listIndex.get(x.id); if (!a) state.listIndex.set(x.id, a = []); a.push({ item: x, course }); };
    for (const d of state.list.byDate || []) for (const co of d.courses || []) for (const x of co.clickers || []) add(x, co);
    for (const co of state.list.byCourse || []) for (const x of co.clickers || []) add(x, co);
  }
  function setList(list, save, since) {
    state.list = list;
    indexList();
    state.listRev++;
    for (const c of [...state.clickers.values()]) {
      if (c.state === 'OPEN' || (c.fetchedAt || 0) >= since) patchList(c, !!c.lastEventAt);   // read after the list: at least as fresh
      else if (c.id !== ui.id) state.clickers.delete(c.id);     // an older copy of a closed question: the list knows better
    }
    if (save) saveListCache();
  }
  function saveListCache() {
    clearTimeout(listSaveTimer);
    listSaveTimer = setTimeout(() => {
      try {
        if (!window.caches || state.list.partial || !state.semkez) return;
        caches.open(LIST_CACHE).then((c) => c.put(listCacheKey(), new Response(JSON.stringify(state.list), { headers: { 'content-type': 'application/json' } }))).catch(() => {});
      } catch {}
    }, 3000);
  }
  async function loadListCache() {
    try {
      if (!window.caches || !state.list.partial || !state.semkez) return;
      const r = await (await caches.open(LIST_CACHE)).match(listCacheKey());
      const j = r && await r.json();
      if (j && Array.isArray(j.byDate) && Array.isArray(j.byCourse) && state.list.partial) { j.partial = false; setList(j, false, j.fetchedAt || 0); render(); }
    } catch {}
  }
  let listCacheTried = false;
  async function autoLoadList() {                               // after a successful feed check
    if (!listCacheTried) { listCacheTried = true; await checkAccount(); await loadListCache(); }
    const stale = !state.scanDone || state.list.partial || Date.now() - (state.list.fetchedAt || 0) > 12 * 3600e3
      || (state.list.fetchedAt || 0) < (state.feedReachAt || 0);   // the saved list is older than what the feed still shows
    // never during a lecture (1.4 MB); after a failure not again for 5 minutes
    if (stale && !fastMode() && !state.scanning && Date.now() - (state.listErrorAt || 0) > 5 * 60e3) startScan();
  }
  const sameTitle = (t, s) => !!t && !!s && (t === s || t.de === s || t.en === s);
  function patchList(c, insert) {
    if (!c) return;
    const hits = state.listIndex.get(c.id);
    const fields = { type: c.type, state: c.state, answerState: c.answerState, title: c.title, question: c.question, preview: c.preview };
    if (hits) {
      let changed = false;
      for (const h of hits) for (const k in fields) if (fields[k] !== undefined && h.item[k] !== fields[k]) { h.item[k] = fields[k]; changed = true; }
      if (changed) { state.listRev++; saveListCache(); }
      return;
    }
    if (!insert) return;
    // a question that was not in the list yet (opened since the list was downloaded): file it under today and its course
    const lec = state.lectures.find((l) => sameTitle(l.title, c.courseTitle)) || (c.courseTitle ? null : currentLecture());
    const title = lec ? lec.title : { de: c.courseTitle || 'Clicker', en: c.courseTitle || 'Clicker' };
    const mk = () => ({ code: lec ? lec.code : '', type: lec ? lec.type : '', title, clickers: [] });
    const match = (co) => lec ? co.code === lec.code && (co.type || '') === (lec.type || '') : sameTitle(co.title, c.courseTitle || 'Clicker');
    const d = new Date(c.lastEventAt || Date.now());
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let day = state.list.byDate.find((x) => String(x.date).slice(0, 10) === date);
    if (!day) { day = { date, courses: [] }; state.list.byDate.unshift(day); state.list.byDate.sort((a, b) => String(b.date).localeCompare(String(a.date))); }
    let co = day.courses.find(match);
    if (!co) day.courses.push(co = mk());
    co.clickers.push(Object.assign({ id: c.id }, fields));
    let cc = state.list.byCourse.find(match);
    if (!cc) state.list.byCourse.push(cc = mk());
    cc.clickers.push(Object.assign({ id: c.id }, fields));
    indexList();
    state.listRev++;
    saveListCache();
  }

  // ---------------------------------------------------------------- shared discovery (optional relay)
  // Only the polling tab talks to the relay, and only around lectures. It joins one room per current course (the
  // room name is a hash of semester + course number), gets a slot for its feed checks, tells the room about clicker
  // events it sees and receives the others' hints. A hint only makes this client read that question from ETH.
  const relayUrl = hooks.relayUrl !== undefined ? hooks.relayUrl : RELAY_URL;
  const WS = hooks.WebSocket || window.WebSocket;
  // One connection per room (a room is one course's lecture; on Cloudflare each room is its own small server that
  // sleeps between messages). At most two rooms at once: the lecture now and the next one at a changeover.
  const MAX_ROOM_SOCKETS = 2;
  const relay = { conns: new Map(), rooms: new Map(), want: new Map(), offset: 0, hintAt: new Map(), hints: [], queue: [], draining: false, quietUntil: 0, confirms: [], confirmDue: 0, lastN: 1, lastM: 1, badIds: new Set(),
    get open() { for (const c of this.conns.values()) if (c.open) return true; return false; } };
  try { relay.lastN = Math.max(1, Number(localStorage.getItem('fast-clicker-relay-n')) || 1); relay.lastM = Math.max(1, Number(localStorage.getItem('fast-clicker-relay-m')) || 1); } catch {}
  // Hints are not trusted: each costs at most one small read of that question from ETH, a few a minute at most, and an
  // id that ETH refused (not this student's question, or no such question) is never read again because of a hint.
  const HINT_READS_PER_MIN = 4;
  const hash32 = (str) => {                                     // 128-bit string hash as 32 hex digits (not a secret)
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0, k; i < str.length; i++) {
      k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067); h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213); h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067); h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213); h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  };
  function wantedRooms() {
    const m = new Map();
    if (!state.semkez) return m;
    const now = Date.now();
    const running = (l) => Date.parse(l.start) <= now && now <= Date.parse(l.end);
    // the lecture under way first, then the one starting next
    const lects = currentLectures().slice().sort((a, b) => (running(b) - running(a)) || (Date.parse(a.start) - Date.parse(b.start)));
    for (const l of lects) {
      if (!l.code) continue;
      const room = hash32(`fc1|${state.semkez}|${l.code}`);
      if (!m.has(room) && m.size >= MAX_ROOM_SOCKETS) break;
      const info = m.get(room) || { code: l.code, titles: new Set(), title: null };
      if (l.title) { for (const k of ['de', 'en']) if (l.title[k]) info.titles.add(l.title[k]); info.title = info.title || l.title.de || l.title.en; }
      m.set(room, info);
    }
    return m;
  }
  const roomUrl = (room) => `${relayUrl.replace(/\/+$/, '')}/room/${room}`;
  const relaySend = (conn, msg) => { try { if (conn && conn.open) conn.ws.send(JSON.stringify(msg)); } catch {} };
  function relayJoin(conn) {
    const scout = !document.hidden;
    const sig = String(scout);
    if (sig === conn.joined) return;
    conn.joined = sig;
    relaySend(conn, { t: 'join', rooms: [conn.room], scout });
  }
  function dropSocket(conn) {                                  // forget the socket, keep the retry state
    const ws = conn.ws;
    conn.ws = null; conn.open = false; conn.joined = '';
    relay.rooms.delete(conn.room);
    try { if (ws) { ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null; ws.close(); } } catch {}
  }
  function relayClose(conn) {                                   // this room is not wanted any more
    clearTimeout(conn.timer);
    dropSocket(conn);
    relay.conns.delete(conn.room);
  }
  function relayRetry(conn) {
    clearTimeout(conn.timer);
    conn.retry++;
    const wait = TS * jitter(Math.min(60000, 1000 * 2 ** Math.min(conn.retry, 6)), 0.3);
    conn.retryAt = Date.now() + wait;
    conn.timer = setTimeout(relaySync, wait + 5);
  }
  function relayConnect(conn) {
    let ws;
    try { ws = new WS(roomUrl(conn.room)); } catch { relayRetry(conn); return; }
    conn.ws = ws; conn.open = false; conn.joined = ''; conn.lastMsgAt = Date.now();
    ws.onopen = () => {
      if (conn.ws !== ws) return;
      conn.open = true; conn.retry = 0; conn.lastMsgAt = Date.now();
      relayJoin(conn);
    };
    ws.onmessage = (ev) => { if (conn.ws === ws) relayMessage(conn, ev.data); };
    ws.onclose = ws.onerror = () => {
      if (conn.ws !== ws) return;
      dropSocket(conn);
      relayRetry(conn);
      if (state.leader && !state.polling) schedule();              // back to checking alone
    };
  }
  function relaySync() {
    if (!relayUrl || !WS) return;
    relay.want = state.leader && state.running && !state.authLost && !halted() && fastMode() ? wantedRooms() : new Map();
    for (const conn of [...relay.conns.values()]) if (!relay.want.has(conn.room)) relayClose(conn);
    for (const room of relay.want.keys()) {
      let conn = relay.conns.get(room);
      if (!conn) { conn = { room, ws: null, open: false, joined: '', retry: 0, retryAt: 0, timer: null, lastMsgAt: 0 }; relay.conns.set(room, conn); }
      if (!conn.ws) { if (Date.now() >= conn.retryAt) relayConnect(conn); }
      else if (conn.open) relayJoin(conn);
    }
  }
  function relayKeepAlive() {                                   // every 40 s
    for (const conn of relay.conns.values()) {
      if (!conn.ws) continue;
      if (Date.now() - conn.lastMsgAt > TS * 100000) {            // silent for too long: start over
        dropSocket(conn); relayRetry(conn);
        if (state.leader && !state.polling) schedule();
        continue;
      }
      relaySend(conn, { t: 'ping' });
    }
  }
  function sharedPlan() {                                       // the busiest joined room decides the rhythm
    let best = null;
    for (const [room, r] of relay.rooms) {
      const conn = relay.conns.get(room);
      if (conn && conn.open && relay.want.has(room) && r.n > 0 && (!best || r.n > best.n)) best = r;
    }
    return best;
  }
  function relayMessage(conn, text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    conn.lastMsgAt = Date.now();
    // the relay's clock (for the slots): a replayed hint carries the time it was first accepted, so not from that
    if (typeof m.now === 'number' && !m.replay && Math.abs(m.now - Date.now()) < 86400e3) relay.offset = m.now - Date.now();
    if (m.room !== conn.room) return;                            // each connection speaks for its own room only
    if (m.t === 'roster' && relay.want.has(m.room)) {
      const n = Math.max(0, Math.min(5000, m.n | 0));
      relay.rooms.set(m.room, { n, slot: Math.max(-1, Math.min(n - 1, m.slot | 0)), m: Math.max(0, Math.min(5000, m.m | 0)), every: Math.max(CFG.shareMinMs, Math.min(5000, Number(m.every) || 1000)) });
      const busiest = sharedPlan();                              // remembered for checking alone if the relay goes away
      if (busiest && (busiest.n !== relay.lastN || busiest.m !== relay.lastM)) {
        relay.lastN = busiest.n; relay.lastM = Math.max(1, busiest.m);
        try { localStorage.setItem('fast-clicker-relay-n', String(relay.lastN)); localStorage.setItem('fast-clicker-relay-m', String(relay.lastM)); } catch {}
      }
      if (state.leader && !state.polling && sharedPlan()) schedule();   // move to the (new) slot
      render();
    } else if (m.t === 'hint') onHint(m);
  }
  function sendHints(events) {
    if (!events.length) return;
    for (const ev of events) {
      let room = null;
      for (const [r, info] of relay.want) if (ev.titles && (info.titles.has(ev.titles.de) || info.titles.has(ev.titles.en))) { room = r; break; }
      const conn = room && relay.conns.get(room);
      if (!conn || !conn.open || !relay.rooms.has(room)) continue;   // only into the room of the course the event belongs to
      relaySend(conn, { t: 'hint', room, k: ev.k, e: ev.e, a: ev.a, c: String(ev.c || '').slice(0, 32) });
    }
  }
  // ---------------------------------------------------------------- anonymous beta diagnostics: sending
  const reportUrl = relayUrl ? relayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/report' : '';
  let installId = '';
  try {
    installId = localStorage.getItem('fast-clicker-install') || '';
    if (!/^[0-9a-f]{16}$/.test(installId)) {
      installId = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('fast-clicker-install', installId);
    }
  } catch {}
  const platform = hooks.platform || (hooks.nativeAlerts ? (/Android/.test(navigator.userAgent) ? 'android' : 'ios') : 'web');
  function sendReport(kind, data) {
    if (!installId || CFG.diag === false) return;
    const msg = { install: installId, platform, version: VERSION, kind, data };
    if (hooks.onReport) { try { hooks.onReport(msg); } catch {} return; }
    if (!reportUrl) return;
    const body = JSON.stringify(msg);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(reportUrl, new Blob([body], { type: 'text/plain' }))) return;
      fetch(reportUrl, { method: 'POST', body, keepalive: true, mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
    } catch {}
  }
  function diagSample() {                                       // once a minute: what state the app is in
    diag.samples++;
    if (relay.open) diag.open++;
    if (fastMode()) diag.fast++;
    if (onScreen()) diag.screen++;
  }
  function diagQuestion(c) {
    if (!c.openedAtSrv) return;
    const sp = sharedPlan();
    const p = sp && sp.m > CFG.diagRoomSample ? CFG.diagRoomSample / sp.m : 1;   // a full hall: ~20 reports per question, not hundreds
    if (Math.random() >= p) return;
    const data = {
      delay: Math.max(0, Math.min(3600e3, serverNow() - c.openedAtSrv)),   // from "question opened" (ETH's clock) to on screen here
      hint: c.openedVia === 'hint', round: (c.gen || 0) > 0, hidden: !!document.hidden,
      relay: relay.open, n: sp ? sp.n : 0, m: sp ? sp.m : 0, scout: !!(sp && sp.slot >= 0), feedMs: Math.round(latOk.feed),
      p: Math.round(p * 1000) / 1000,
    };
    setTimeout(() => sendReport('question', data), Math.random() * CFG.diagJitterMs);
  }
  function diagFlush(force) {
    const mins = (Date.now() - diag.since) / 60e3;
    const any = Object.keys(diag.req).length || diag.vote.n;
    if (!any || (!force && mins < CFG.diagEveryMin)) return;
    const req = {};
    for (const [k, d] of Object.entries(diag.req)) req[k] = { ...d, ms: d.ok ? Math.round(d.ms / d.ok) : 0, max: Math.round(d.max) };
    const sp = sharedPlan();
    sendReport('period', {
      mins: Math.round(mins * 10) / 10, ...req,
      vote: { ...diag.vote, ms: diag.vote.ok ? Math.round(diag.vote.ms / diag.vote.ok) : 0 },
      relay: { open: diag.samples ? diag.open / diag.samples : 0, n: sp ? sp.n : 0, m: sp ? sp.m : 0, scout: !!(sp && sp.slot >= 0), hints: diag.hints, reads: diag.hintReads },
      share: { fast: diag.samples ? diag.fast / diag.samples : 0, screen: diag.samples ? diag.screen / diag.samples : 0 },
      ctl: { pause: control.pause, old: control.old, slow: control.slow, update: control.update },
    });
    diag.since = Date.now(); diag.req = {}; diag.vote = { n: 0, ok: 0, fail: 0, att: 0, ms: 0 };
    diag.hints = 0; diag.hintReads = 0; diag.samples = 0; diag.open = 0; diag.fast = 0; diag.screen = 0;
  }
  // leaving the app (switching away): send early, but at most every 2 min, so flipping between apps isn't a report each time
  document.addEventListener('visibilitychange', () => { if (document.hidden && Date.now() - diag.since >= CFG.diagHideMinMs) diagFlush(true); });
  window.addEventListener('pagehide', () => diagFlush(true));

  // ---------------------------------------------------------------- remote control (safety with many users)
  // A small file on the install site (control.json, see docs/OPERATIONS.md) can only make clients do less:
  //   pause: true      no automatic checks of ETH, no relay, no hint reads (an incident, or ETH asks us to stop)
  //   min: "x.y.z"     versions below it stop checking and ask to be updated (a bug in an old version)
  //   slow: 1…10       every automatic check is that many times further apart (ETH overloaded)
  //   latest: {platform: "x.y.z"}   newer than this: a small "update available" note
  // It carries no text, links or code, and nothing in it can make a client send more. The student's own actions
  // (opening a question, sending an answer) always work. Unreachable or malformed: ignored, and the last good copy
  // counts for a day (so a pause also holds on a phone that can't reach the site).
  const controlUrl = hooks.controlUrl !== undefined ? hooks.controlUrl : CONTROL_URL;
  const updateUrl = controlUrl ? controlUrl.replace(/[^/]*$/, '') : '';
  const CONTROL_KEY = 'fast-clicker-control';
  const verNum = (v) => (typeof v === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? v.split('.').reduce((a, x) => a * 1000 + Number(x), 0) : null);
  const control = { pause: false, old: false, slow: 1, update: false, at: 0, timer: null };
  const halted = () => control.pause || control.old;
  // The whole document must be well-formed, or nothing changes (a typo must never lift a pause).
  function validControl(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    if ('pause' in c && typeof c.pause !== 'boolean') return false;
    if ('slow' in c && !(typeof c.slow === 'number' && c.slow >= 1 && c.slow <= 10)) return false;
    if ('min' in c && verNum(c.min) === null) return false;
    if ('latest' in c && (!c.latest || typeof c.latest !== 'object' || Array.isArray(c.latest) || Object.values(c.latest).some((v) => verNum(v) === null))) return false;
    return true;
  }
  function applyControl(c, at) {
    if (!validControl(c)) return false;
    const me = verNum(VERSION);
    control.pause = c.pause === true;
    control.old = 'min' in c && me < verNum(c.min);
    control.slow = c.slow > 1 ? c.slow : 1;
    control.update = !!c.latest && platform in c.latest && me < verNum(c.latest[platform]);
    control.at = at;
    return true;
  }
  try { const saved = JSON.parse(localStorage.getItem(CONTROL_KEY) || 'null'); if (saved && Date.now() - saved.at < 86400e3) applyControl(saved.c, saved.at); } catch {}
  async function fetchControl() {
    clearTimeout(control.timer);
    if (!controlUrl) return;
    const before = halted();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10000);
    try {
      const r = await fetch(controlUrl + '?' + Date.now().toString(36), { cache: 'no-store', credentials: 'omit', mode: 'cors', signal: ac.signal });
      const text = r.ok ? await r.text() : '';
      const c = text && text.length < 4000 ? JSON.parse(text) : null;
      if (applyControl(c, Date.now())) { try { localStorage.setItem(CONTROL_KEY, JSON.stringify({ c, at: control.at })); } catch {} }
    } catch {} finally { clearTimeout(t); }
    // again in 6 hours, or every 10 minutes while paused (so the pause ends soon after it is lifted)
    control.timer = setTimeout(fetchControl, TS * (halted() ? 10 * 60e3 : 6 * 3600e3));
    controlChanged(before);
  }
  // another tab of this browser fetched a new control file: apply it here too, right away
  window.addEventListener('storage', (e) => {
    if (e.key !== CONTROL_KEY || !e.newValue) return;
    const before = halted();
    try { const saved = JSON.parse(e.newValue); if (saved && applyControl(saved.c, saved.at)) controlChanged(before); } catch {}
  });
  function controlChanged(before) {
    if (before !== halted()) {
      if (halted()) relay.queue.length = 0;                     // hints accepted before the pause are not read
      relaySync();
      if (!halted()) pokeNow();
    }
    if (control.old && state.leader) resignLeader();             // an up-to-date tab may take over the checking
    else if (!control.old && !state.leader && state.running && !releaseLeader) electLeader();
    render();
  }

  // A hint is only a wake-up call. The relay and the students behind it are not trusted: a hint never marks a feed
  // event as handled, never starts a new round, never changes an answer. It makes this client read that one
  // question from ETH, and what ETH says decides:
  //   * the question is open and was not before  -> show it and alert (this is the fast path for a new question);
  //   * it was open and still is                 -> perhaps a round was stopped or restarted, which only the feed can
  //     tell: check the feed soon (spread out over the hall), and let answer retries wait for that check.
  function onHint(m) {
    const info = relay.want.get(m.room);
    if (!info || !state.leader || !state.running || state.authLost || halted()) return;
    if (!Number.isSafeInteger(m.k) || m.k <= 0 || typeof m.e !== 'string' || !/^CLICKER_[A-Z_]{1,24}$/.test(m.e)) return;
    const now = Date.now();
    if (now < Math.max(relay.quietUntil, state.notBefore)) return;   // ETH asked for a pause
    relay.hints = relay.hints.filter((t) => now - t < 60000);
    if (relay.badIds.has(m.k)) return;
    if (relay.hints.length >= HINT_READS_PER_MIN || relay.queue.length >= 2 || now - (relay.hintAt.get(m.k) || 0) < TS * 1500) return;   // flood guard
    relay.hintAt.set(m.k, now);
    if (relay.hintAt.size > 200) relay.hintAt.clear();
    const room = relay.rooms.get(m.room);
    const members = (room && room.m) || 0;
    // a full hall does not hit ETH in the same moment: the bigger the room, the wider the spread (2,000 students:
    // 2.5 s, i.e. about 800 question reads a second at most, each ~25 ms of ETH's time)
    diag.hints++;
    relay.queue.push({ id: m.k, type: m.e, title: info.title, members, c: typeof m.c === 'string' ? m.c : '', at: now + Math.random() * TS * Math.min(2500, Math.max(300, 1.25 * members)) });
    drainHints();
  }
  async function drainHints() {                                 // one question at a time
    if (relay.draining) return;
    relay.draining = true;
    try {
      while (relay.queue.length) {
        const h = relay.queue.shift();
        if (h.at > Date.now()) await sleep(h.at - Date.now());
        for (let attempt = 0; attempt < 1; attempt++) {       // one read per hint: if it fails, the own feed check finds it
          if (!state.leader || !state.running || state.authLost) break;
          if (halted()) { relay.queue.length = 0; break; }      // remote control: no hint reads
          const now = Date.now();
          if (now < Math.max(relay.quietUntil, state.notBefore)) { relay.queue.length = 0; break; }
          relay.hints = relay.hints.filter((t) => now - t < 60000);
          if (relay.hints.length >= HINT_READS_PER_MIN) { relay.queue.length = 0; break; }   // budget: a few question reads a minute for hints
          relay.hints.push(now);
          diag.hintReads++;
          try { await hintRefresh(h); break; } catch (e) {
            if (e instanceof AuthError) { state.authLost = true; relay.queue.length = 0; tryRelogin(); render(); break; }
            if (!isTransient(e)) { relay.badIds.add(h.id); if (relay.badIds.size > 500) relay.badIds.delete(relay.badIds.values().next().value); break; }   // not this student's question: never again
            if (e.retryAfterMs) { relay.quietUntil = Date.now() + e.retryAfterMs; relay.queue.length = 0; break; }
          }
        }
      }
    } finally { relay.draining = false; }
  }
  async function hintRefresh(h) {
    const id = h.id;
    if (state.evBusy.has(id)) return;                            // the feed is handling an event for it right now
    const before = state.clickers.get(id);
    const wasOpen = !!before && before.state === 'OPEN';
    const res = await fetchClicker(id);
    if (!res.applied || state.evBusy.has(id)) return;            // something newer took over
    const c = res.detail;
    if (c.state === 'OPEN' && !wasOpen) {
      if (before) { c.gen = (c.gen || 0) + 1; resetRound(id); }  // closed before, open now: it starts clean
      if (!c.courseTitle) c.courseTitle = h.title;
      c.lastEventAt = Date.now(); c.roundStopped = false; c.hintOpenAt = serverNow();
      if (Date.parse(h.c)) { c.openedAtSrv = Date.parse(h.c); c.openedVia = 'hint'; }
      state.dismissed.delete(id);
      patchList(c, true);
      notify(c, true);
      publish(c, true);
    } else {
      publish(c, false);
      // a possible round change: automatic re-sends of this question wait until a feed check has spoken (the hold).
      // The feed is asked soon only by the clients that take turns checking (at most 60 per room) and by those with
      // an answer on its way; the others wait for their own next check, so a big room never sends its whole hall to
      // the feed at once (a held re-send asks for the check itself, see sendVote)
      const sp = sharedPlan();
      const answering = state.sending.has(id) || state.resend.has(id) || state.unverified.has(id);
      if (c.state === 'OPEN' && h.type !== 'CLICKER_OPEN') holdForRound(id, (sp && sp.slot >= 0) || answering ? h.members : -1);
    }
    render();
  }
  function holdForRound(id, members) {                          // members < 0: hold only, no early feed check
    state.hold.set(id, { at: Date.now() });
    if (members >= 0) confirmSoon(members);
  }
  function confirmSoon(members) {
    const now = Date.now();
    relay.confirms = relay.confirms.filter((t) => now - t < 300000);
    if (relay.confirmDue || relay.confirms.length >= 6) return;  // one at a time, at most 6 in 5 minutes
    relay.confirms.push(now);
    relay.confirmDue = now + Math.random() * TS * Math.min(8000, 25 * members);
    if (state.leader && !state.polling) schedule();
  }

  // ---------------------------------------------------------------- the semester, remembered between runs
  const SEM_KEY = 'fast-clicker-semkez';
  let semChecked = false, semChecking = false;
  function savedSemkez() {
    try {
      const s = JSON.parse(localStorage.getItem(SEM_KEY) || 'null');
      return s && typeof s.k === 'string' && /^\d{4}[A-Z]$/.test(s.k) && Date.now() - s.at < 30 * 86400e3 ? s.k : null;
    } catch { return null; }
  }
  function saveSemkez() { try { localStorage.setItem(SEM_KEY, JSON.stringify({ k: state.semkez, at: Date.now() })); } catch {} }
  async function checkSemester() {
    if (semChecking) return;
    semChecking = true;
    try {
      const s = await req('semesters/current', { priority: 'low' });
      semChecked = true;
      if (!s || !s.semkez) return;
      if (s.semkez !== state.semkez) {                          // a new semester began since the last run: start over with it
        state.semkez = s.semkez;
        state.list = { byDate: [], byCourse: [], fetchedAt: 0, partial: true }; indexList(); state.listRev++;
        state.scanDone = false; state.feedPrimed = false; listCacheTried = false;
        render(); pokeNow();
      }
      saveSemkez();
    } catch {} finally { semChecking = false; }
  }

  // ---------------------------------------------------------------- poll loop (leader only)
  async function tick() {
    if (!state.running || state.polling || !state.leader || halted()) return;
    state.polling = true;
    state.dueAt = 0;
    const started = Date.now();
    try {
      if (state.authLost) { await tryRelogin(); if (state.authLost) return; }
      // Start-up on a weak connection: every request can take seconds, so the first feed check waits for nothing it
      // does not need. The semester comes from the last run (checked again afterwards), the timetable loads alongside.
      if (!state.semkez) {
        state.semkez = savedSemkez();
        if (!state.semkez) { state.semkez = (await req('semesters/current')).semkez; saveSemkez(); semChecked = true; }
      }
      const lecP = Date.now() - state.lecturesFetchedAt > 10 * 60e3 ? loadLectures().catch(() => {}) : null;   // a login problem shows in the feed check too
      // the saved list (after checking whose it is) loads alongside the first feed check; the feed's answer waits for
      // it before catch-up, so catch-up knows what is saved, and the feed request itself is never held up
      if (!listCacheTried) { listCacheTried = true; state.cacheP = sleep(0).then(checkAccount).then(loadListCache).catch(() => {}); }
      state.lastError = null;
      try {
        await pollFeed(!state.feedPrimed);         // first own poll (also after taking over from another tab)
      } finally {
        if (lecP) await lecP;
      }
      state.feedPrimed = true;
      if (!semChecked) checkSemester();            // the remembered semester: confirm it, not awaited
      state.lastPollAt = state.lastOwnPollAt = Date.now();
      state.errorStreak = 0; state.retryAfterMs = 0;
      for (const [id, h] of state.hold) if (h.at < started) state.hold.delete(id);   // the feed has spoken
      autoLoadList();                                           // low priority, not awaited
    } catch (e) {
      state.errorStreak++;
      state.retryAfterMs = e.retryAfterMs || 0;
      if (e instanceof AuthError) { state.authLost = true; state.lastError = null; tryRelogin(); }
      else state.lastError = e.message;
    } finally {
      state.polling = false;
      broadcastStatus();
      render();
      updateWakeLock();
      relaySync();
      schedule(undefined, started);
    }
  }
  function startScan() {
    if (state.scanning) return;
    state.scanning = true; state.listError = null;
    render();
    fullScan().catch((e) => { state.listErrorAt = Date.now(); if (e instanceof AuthError) state.authLost = true; else state.listError = e.message; }).finally(() => { state.scanning = false; render(); });
  }
  function schedule(ms, startedAt = Date.now()) {
    clearTimeout(state.timer);
    if (!state.running || !state.leader) return;
    if (halted()) { state.dueAt = 0; return; }                   // remote control: no automatic checks (see fetchControl)
    if (ms === undefined) {
      const fast = fastMode();
      const sp = fast && !state.authLost ? sharedPlan() : null;
      if (sp) {
        // Shared discovery: the relay gave every checking client of this lecture a slot; together they ask the feed
        // about once per `every` ms, each one only every n-th time. Hints from the others arrive through the relay.
        const period = control.slow * Math.min(Math.max(CFG.shareMaxMs, CFG.cadenceMs), Math.max(CFG.cadenceMs, sp.n * sp.every));   // slow: every slot further apart
        if (sp.slot >= 0 && !document.hidden) {
          const now = Date.now() + relay.offset;
          let wait = (Math.round(sp.slot * period / sp.n) - (now % period) + 2 * period) % period;
          const gap = state.lastFeedStartAt + CFG.cadenceMs - Date.now();        // never sooner than the normal rhythm after the last check…
          if (wait < gap) wait += period * Math.ceil((gap - wait) / period);
          const late = state.lastFeedStartAt + 1.5 * period - Date.now();          // …and whatever the relay says, never much later than one round
          ms = state.lastFeedStartAt ? Math.min(wait, Math.max(0, late)) : wait;
        } else {
          // not checking for others (standing by, or in the background): a rare safety check of its own. The bigger
          // the room, the rarer, so all of them together stay at about 3 feed requests a second (once a minute in a
          // room of 200, every 5 minutes from 1,000 students on)
          const safety = Math.min(CFG.standbyMaxMs, Math.max(CFG.standbyMinMs, (sp.m || 0) * CFG.standbyPerMemberMs));
          ms = jitter(control.slow * Math.max(CFG.hiddenCadenceMs, safety));
        }
        if (state.errorStreak) ms = Math.max(ms, Math.min(CFG.maxBackoffMs, CFG.lectureBackoffMs, 2000 * 2 ** (state.errorStreak - 1)), state.retryAfterMs);
      } else {
        let cadence = control.slow * (!fast ? CFG.idleCadenceMs : document.hidden ? CFG.hiddenCadenceMs : CFG.cadenceMs);
        // relay configured but unreachable: check alone, but the more students were sharing, the slower (ETH load)
        const solo = fast && relayUrl && relay.want.size && !sharedPlan() ? Math.min(CFG.soloMaxMs, Math.max(CFG.soloMinMs, relay.lastN * CFG.soloStepMs, relay.lastM * CFG.soloPerMemberMs)) : 0;
        cadence = Math.max(cadence, solo);                         // (also while ETH answers with errors: never faster than this)
        // server slower than usual: back off (start to start), but less during a lecture, when finding the question matters
        if (latOk.feed > 2500) cadence = Math.max(cadence, Math.round(Math.min(latOk.feed, 30000) * (fast ? 1.5 : 3)));
        const maxBackoff = fast ? Math.min(CFG.maxBackoffMs, CFG.lectureBackoffMs) : CFG.maxBackoffMs;
        if (state.authLost) cadence = state.loginNeeded ? CFG.loginCadenceMs : CFG.authCadenceMs;
        else if (state.errorStreak) cadence = Math.max(state.retryAfterMs, Math.min(maxBackoff, 2000 * 2 ** (state.errorStreak - 1)), Math.min(cadence, 8000), solo);
        ms = Math.max(0, jitter(cadence) - (Date.now() - startedAt));
      }
      const now = Date.now();
      if (state.dueAt) ms = Math.min(ms, state.dueAt - now);       // messages from the relay can bring a check forward, never push it back
      if (relay.confirmDue) ms = Math.min(ms, relay.confirmDue - now);   // a hint asked for the feed's word on a round change
      // floors that nothing overrides: the normal rhythm after the last feed check, and any pause ETH asked for
      if (state.lastFeedStartAt && fastMode()) ms = Math.max(ms, state.lastFeedStartAt + CFG.cadenceMs - now);
    }
    // also for "check now" and coming back to the app: never two feed checks within 4 s, and any pause ETH asked for
    const now = Date.now();
    if (state.lastFeedStartAt) ms = Math.max(ms, state.lastFeedStartAt + Math.min(CFG.cadenceMs, 4000) - now);
    ms = Math.max(0, ms, state.notBefore - now);
    state.dueAt = Date.now() + ms;
    state.timer = setTimeout(tick, ms);
  }
  const pokeNow = () => { if (state.leader && !state.polling) schedule(0); };
  // the refresh button, and pulling down in the iPhone app: check right away, without restarting anything
  function checkNow() { ui.spinUntil = Date.now() + 900; setTimeout(render, 950); render(); pokeNow(); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pokeNow(); updateWakeLock(); relaySync(); });
  window.addEventListener('online', pokeNow);
  if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', pokeNow);

  // ---------------------------------------------------------------- login renewal
  let lastSilentTry = 0, loginWin = null;
  async function checkSession() {
    try { await req('semesters/current'); return true; } catch (e) { return !(e instanceof AuthError) && null; }
  }
  // Follow the login redirect chain (/oauth2/start → Keycloak → /oauth2/callback → rd) with a plain same-origin
  // request: while ETH single sign-on is still valid it ends at the API with fresh session cookies and no UI.
  // (A hidden iframe doesn't work: the login chain refuses to be framed.) If a login form is needed, the chain
  // ends on an HTML page or leaves the origin, and we return false.
  async function silentRelogin() {
    if (hooks.relogin) return hooks.relogin();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch('/oauth2/start?rd=' + encodeURIComponent('/web/gw/semesters/current?_fc=login' + Date.now()),
        { credentials: 'same-origin', redirect: 'follow', cache: 'no-store', signal: ac.signal });
      const u = new URL(r.url, location.href);
      return r.ok && u.origin === location.origin && u.pathname.startsWith('/web/gw/') && (r.headers.get('content-type') || '').includes('json');
    } catch { return false; } finally { clearTimeout(t); }
  }
  async function tryRelogin() {
    if (Date.now() - lastSilentTry > CFG.silentEveryMs) {
      lastSilentTry = Date.now();
      setBanner('Login expired. Renewing…');
      if (await silentRelogin() && await checkSession()) return loggedIn();
    }
    if (await checkSession()) return loggedIn();      // e.g. the user logged in in another tab (or in the app's login window)
    state.loginNeeded = true;
    render();
  }
  function loggedIn(manual) {
    if (manual) {
      const before = state.account;
      // a known different account was wiped in checkAccount; if the account cannot be told, only the saved list goes
      checkAccount().then(async () => { if (!state.account) await wipeAccountData(false); if (state.account !== before) render(); });
    }
    state.authLost = false; state.loginNeeded = false; state.lastError = null;
    if (loginWin && !loginWin.closed) { try { loginWin.close(); } catch {} }
    loginWin = null;
    broadcastStatus(); render(); pokeNow();
    recheckUnverified();
  }
  function openLogin() {                              // needs a tap (popup blockers)
    loginWin = window.open('/oauth2/start?rd=' + encodeURIComponent('/web/gw/semesters/current'), 'fast-clicker-login');
    const iv = setInterval(async () => {
      if (!state.authLost) { clearInterval(iv); return; }
      let back = false;
      try { back = !loginWin || loginWin.closed || loginWin.location.pathname.startsWith('/web/gw/'); } catch {}
      if (back && await checkSession()) { clearInterval(iv); loggedIn(true); }   // a login on ETH's page: maybe another person
    }, 2000);
  }
  async function waitForSession(deadline) {
    while (state.authLost && Date.now() < deadline) await sleep(Math.max(50, 1000 * TS));
    return !state.authLost;
  }

  // ---------------------------------------------------------------- voting
  const answerOf = (c) => c.type === 'TEXT' ? (c.individualAnswer || '') : c.entries.filter((e) => e.selected).map((e) => e.id);
  const currentAnswer = (c) => { const d = state.draft.get(c.id); return d && d.gen === c.gen ? d.value : answerOf(c); };
  const sameAnswer = (a, b) => typeof a === 'string' ? a.trim() === String(b).trim()
    : Array.isArray(b) && a.length === b.length && [...a].sort().join() === [...b].sort().join();
  function setDraft(c, value) { state.draft.set(c.id, { value, ver: ++state.draftVer, gen: c.gen }); }
  const backoff = (n, ra) => TS * Math.max(ra || 0, jitter(Math.min(4000, 400 * 2 ** (n - 1)), 0.3));
  async function waitOnlineOr(ms) {
    if (navigator.onLine !== false && !hooks.offline) return sleep(ms);
    await new Promise((r) => { const done = () => { window.removeEventListener('online', done); r(); }; window.addEventListener('online', done); setTimeout(done, Math.max(ms, 3000)); });
  }

  const fmtMs = (ms) => ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s';
  let stampCounter = 0;
  const newStamp = () => Date.now() * 1000 + (++stampCounter % 1000);
  const withVoteLock = (id, fn) => navigator.locks && navigator.locks.request
    ? navigator.locks.request('fast-clicker-vote-' + id, fn)   // one vote request per question across ALL tabs
    : fn();

  async function sendVote(id, { repair = 0 } = {}) {
    const c = state.clickers.get(id);
    if (!c) return;
    if (state.sending.has(id)) { state.resend.add(id); return; } // one request per question at a time
    const d = state.draft.get(id);
    const ans = d && d.gen === c.gen ? d.value : answerOf(c);
    const ver = d ? d.ver : 0;
    const gen = c.gen;
    if (typeof ans === 'string' ? !ans.trim() : !ans.length) return;
    state.sending.add(id);
    const stamp = newStamp();
    state.stamp.set(id, stamp);
    state.unverified.delete(id);
    broadcast({ t: 'send', id, stamp });                         // older sends in other tabs stop retrying
    const body = typeof ans === 'string' ? { individualAnswer: ans.trim() } : { selectedAnswer: [...ans] };
    const t0 = performance.now();
    const deadline = Date.now() + CFG.voteDeadlineMs;
    setStatus(id, 'pending', 'Sending…');
    let attempt = 0, delivered = false;
    try {
      await withVoteLock(id, async () => {
        for (;;) {
          const cur = state.clickers.get(id);
          if (state.stamp.get(id) !== stamp) { if (state.status.get(id)?.text === 'Sending…') state.status.delete(id); return; } // superseded
          if (cur.gen !== gen) { setStatus(id, 'warn', 'A new round started. Choose and send again.'); return; }
          if (cur.state !== 'OPEN') { setStatus(id, 'err', 'The question was closed before your answer got through.'); return; }
          if (state.authLost) {
            setStatus(id, 'warn', 'Login expired. Your answer is kept and will be sent right after login.');
            tryRelogin();
            if (!await waitForSession(deadline)) return;
            continue;
          }
          // Checking is halted (remote control): nothing would notice a new round, so no automatic re-send. The choice
          // stays; one tap sends it again.
          if ((attempt > 0 || repair > 0) && halted()) { setStatus(id, 'warn', 'Not sent yet: checking is paused, so a new round can\'t be ruled out. Tap Send to try again.'); attempt = -1; return; }
          // An automatic send (a retry, or a repair after verification) waits while a hint has raised the possibility of a
          // new round, until a feed check has actually succeeded. Only the student's own tap sends without waiting.
          if ((attempt > 0 || repair > 0) && state.hold.has(id)) {
            if (!relay.confirmDue) confirmSoon(0);             // a standby client asks the feed itself, now that it matters
            if (Date.now() > deadline) { setStatus(id, 'err', 'Could not check whether a new round started. Check your answer and tap Send again.'); attempt = -1; return; }
            if (state.status.get(id)?.text !== 'Checking whether a new round started…') setStatus(id, 'pending', 'Checking whether a new round started…');
            await sleep(Math.max(40, TS * 250));
            continue;
          }
          if (attempt > 0 && Date.now() < state.notBefore) { await waitOnlineOr(state.notBefore - Date.now()); continue; }   // ETH asked for a pause
          attempt++;
          try {
            await req(`clickers/${id}/vote`, { method: 'POST', body, kind: 'vote' });
            delivered = true;
            diag.vote.ok++; diag.vote.att += attempt; diag.vote.ms += performance.now() - t0;
            return;
          } catch (e) {
            if (e instanceof AuthError) { state.authLost = true; continue; }
            if (!isTransient(e)) {
              setStatus(id, 'err', e.status >= 400 && e.status < 500 ? `Not accepted (HTTP ${e.status}). Is the round still running?` : `Failed: ${e.message}`);
              attempt = -1; return;
            }
            if (Date.now() > deadline) return;
            setStatus(id, 'pending', `${e.message === 'offline' ? 'Offline' : 'Weak connection'}, still trying… (attempt ${attempt + 1})`);
            await waitOnlineOr(Math.max(backoff(attempt, e.retryAfterMs), state.notBefore - Date.now()));
          }
        }
      });
      diag.vote.n++;
      if (!delivered) {
        diag.vote.fail++;
        if (attempt >= 0 && state.stamp.get(id) === stamp && state.clickers.get(id).gen === gen && state.clickers.get(id).state === 'OPEN') {
          setStatus(id, 'err', 'Could not reach EduApp for 2 minutes. Tap Send to try again.');
        }
        return;
      }
      fence(id);                                                 // only re-reads issued after the vote count
      if (state.clickers.get(id).gen === gen) state.sentGen.set(id, gen);   // this round has an answer from this device
      const took = fmtMs(Math.round(performance.now() - t0)) + (attempt > 1 ? `, attempt ${attempt}` : '');
      if (state.stamp.get(id) === stamp) {
        setStatus(id, 'ok', `Sent ✓ accepted by the server (${took}). Verifying…`);
        state.unverified.set(id, { ans, gen, ver, stamp, took, repair, rechecks: 0 });
        verifyVote(id, stamp);                                   // in the background
      }
    } finally {
      state.sending.delete(id);
      render();
      if (state.resend.delete(id)) {
        const cur = state.draft.get(id);
        if (cur && cur.ver !== ver && cur.gen === state.clickers.get(id).gen) sendVote(id);
      }
    }
  }
  async function verifyVote(id, stamp) {
    for (let i = 0; i < 5; i++) {
      const u = state.unverified.get(id);
      if (!u || u.stamp !== stamp) return;                      // resolved, or superseded by a newer send
      try { await fetchClicker(id); return; }                   // fetchClicker → checkVerification
      catch { await sleep(TS * 1000 * (i + 1)); }
    }
    const u = state.unverified.get(id);
    if (u && u.stamp === stamp) { u.waiting = true; setStatus(id, 'ok', `Sent ✓ accepted by the server (${u.took}). Will double-check when the connection allows.`); }
  }
  // Called whenever a fresh (post-vote) detail of a question is applied, from any code path.
  function checkVerification(id, c) {
    const u = state.unverified.get(id);
    if (!u) return;
    if (u.gen !== c.gen || state.stamp.get(id) !== u.stamp || state.sending.has(id)) return;
    state.unverified.delete(id);
    publish(c, false);                                          // other tabs see the server's answer too
    if (sameAnswer(u.ans, answerOf(c))) {
      const cur = state.draft.get(id);
      if (cur && cur.ver === u.ver) state.draft.delete(id);
      setStatus(id, 'ok', `✓ Confirmed by the server (${u.took})`);
      return;
    }
    const cur = state.draft.get(id);
    const newer = cur && cur.ver !== u.ver;
    if (c.state === 'OPEN' && !newer && u.repair < 2 && !halted()) {   // e.g. an older request landed late
      setStatus(id, 'pending', 'The server shows a different answer. Re-sending yours…');
      if (!cur) setDraft(c, typeof u.ans === 'string' ? u.ans : [...u.ans]);
      setTimeout(() => sendVote(id, { repair: u.repair + 1 }), 0);
    } else if (!newer) {
      setStatus(id, 'warn', `The server shows a different answer${c.state !== 'OPEN' ? ' (question closed)' : ''}. Check and send again.`);
    }
  }
  function setStatus(id, kind, text) { state.status.set(id, { kind, text }); render(); }

  // ---------------------------------------------------------------- alerts
  let audioCtx = null;
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  }
  // a later round of a question (the lecturer stopped and restarted voting): answers of the earlier round do not count
  const newRound = (c) => (c.gen || 0) > 0;
  const voteAgain = (c) => c.state === 'OPEN' && !c.roundStopped && newRound(c) && state.sentGen.get(c.id) !== c.gen;
  function notify(c, desktop) {
    diagQuestion(c);
    if (hooks.onAlert) {                 // native app shell: it plays sound, vibrates and notifies
      try { hooks.onAlert({ id: c.id, title: c.title || '', course: c.courseTitle || '', round: newRound(c) }); } catch {}
      autoShow(c.id);
      return;
    }
    try { navigator.vibrate && navigator.vibrate([150, 80, 150]); } catch {}
    if (CFG.sound && audioCtx && audioCtx.state === 'running') {
      try {
        for (const [f, t] of [[880, 0], [1320, 0.16]]) {
          const o = audioCtx.createOscillator(), g = audioCtx.createGain();
          o.frequency.value = f; g.gain.value = 0.18; o.connect(g); g.connect(audioCtx.destination);
          o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.14);
        }
      } catch {}
    }
    if (desktop && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification((newRound(c) ? 'New round, vote again: ' : 'Clicker open: ') + (c.title || ''), { body: c.courseTitle || 'EduApp', tag: 'fast-clicker-' + c.id }); } catch {}
    }
    autoShow(c.id);
  }
  let wakeLock = null;
  async function updateWakeLock() {
    const want = mode === 'focus' && CFG.keepAwake && !document.hidden && state.running && (fastMode() || [...state.clickers.values()].some(isLive));
    try {
      if (want && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
    } catch { wakeLock = null; }
  }

  // ---------------------------------------------------------------- focus mode: silence the EduApp page itself
  function quietEduApp() {
    const appEl = document.getElementById('app');
    const app = appEl && appEl.__vue_app__;
    if (app) {
      try {
        const provides = (app._context && app._context.provides) || {};
        let qc = provides.VUE_QUERY_CLIENT;
        if (!qc) for (const k in provides) { const v = provides[k]; if (v && typeof v.cancelQueries === 'function') { qc = v; break; } }
        if (qc) { qc.cancelQueries(); if (qc.unmount) qc.unmount(); }
      } catch {}
      try { app.unmount(); } catch {}
    }
    // stop the page's own timers (dashboard refreshes, 5-min service-worker update check, …), never ours
    for (let i = 1; i <= TIMER_WATERMARK; i++) { clearTimeout(i); clearInterval(i); }
    document.body.replaceChildren(host);
    document.title = 'ETH Clicker';
    if (!document.querySelector('meta[name=viewport]')) {
      const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width,initial-scale=1,viewport-fit=cover'; document.head.appendChild(m);
    }
    document.documentElement.style.cssText = `background:${window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? '#1d1f23' : '#fff'}`;
    document.body.style.cssText = 'margin:0';
  }
  const myTimers = { stat: null, sweep: null, recheck: null, relay: null, diag: null };
  // accepted-but-unverified answers (verification failed, e.g. during a login expiry) are re-read later
  function recheckUnverified() {
    if (state.authLost || hooks.offline) return;
    for (const [id, u] of state.unverified) {
      const c = state.clickers.get(id);
      if (!c || c.state !== 'OPEN' || state.stamp.get(id) !== u.stamp) { state.unverified.delete(id); continue; }
      if (!u.waiting) continue;
      if (++u.rechecks > 12) {                                   // ~2 min: stop downloading, say so
        state.unverified.delete(id);
        setStatus(id, 'ok', `Sent ✓ accepted by the server (${u.took}). Couldn't double-check on this connection.`);
        continue;
      }
      fetchClicker(id).then(render).catch(() => {});
    }
  }
  function startTimers() {
    for (const k in myTimers) clearInterval(myTimers[k]);
    myTimers.stat = setInterval(updateStat, 1000);
    myTimers.sweep = setInterval(sweepSwCache, 60e3);
    myTimers.recheck = setInterval(recheckUnverified, Math.max(200, 10000 * TS));
    myTimers.relay = setInterval(relayKeepAlive, Math.max(100, 40000 * TS));
    myTimers.diag = setInterval(() => { diagSample(); diagFlush(false); }, Math.max(100, 60000 * TS));
  }

  // ---------------------------------------------------------------- UI (shadow DOM, isolated from the app's CSS)
  // Looks and reads like EduApp's own clicker section (list by date / by lecture, question page with results),
  // with the things EduApp lacks: it updates by itself, shows when an answer really arrived, and keeps the list.
  const LANG = /^de/i.test(navigator.language || '') ? 'de' : 'en';
  const L = {
    en: {
      byDate: 'By Date', byLecture: 'By Lecture', open: 'open', closed: 'closed', paused: 'paused', send: 'Send', sendAgain: 'Send Again',
      total: '{n} Clicker', unanswered: '{n} unanswered', votes: 'votes', you: 'YOU',
      CORRECT: 'Your answer is correct.', PARTLY_CORRECT: 'Your answer is partly correct.', WRONG: 'Your answer is wrong.', UNANSWERED: "You didn't answer.", ANSWERED: 'Thank you for answering.',
      pleaseAnswer: 'Please answer.', answered: 'You have already answered.',
      noneTitle: 'No Clicker Questions available', noneText: 'Clicker questions are prepared by lecturers, activated in the lecture and answered by students anonymously using this app.',
      back: 'Navigate to clicker list', prev: 'Navigate to previous clicker', next: 'Navigate to next clicker', showSection: 'Show section', hideSection: 'Hide section',
      one: 'one answer', many: 'multiple answers possible', text: 'text answer', yourAnswer: 'Your answer',
      optRight: 'This answer option is correct', optWrong: 'This answer option is wrong', youRight: 'Your choice is correct.', youWrong: 'Your choice is wrong.',
    },
    de: {
      byDate: 'Datum', byLecture: 'Veranstaltung', open: 'offen', closed: 'geschlossen', paused: 'pausiert', send: 'Senden', sendAgain: 'Erneut Senden',
      total: '{n} Clicker', unanswered: '{n} unbeantwortet', votes: 'Stimmen', you: 'SIE',
      CORRECT: 'Ihre Antwort ist korrekt.', PARTLY_CORRECT: 'Ihre Antwort ist teilweise korrekt.', WRONG: 'Ihre Antwort ist falsch.', UNANSWERED: 'Sie haben nicht geantwortet.', ANSWERED: 'Vielen Dank für Ihre Antwort.',
      pleaseAnswer: 'Bitte beantworten.', answered: 'Sie haben bereits geantwortet.',
      noneTitle: 'Keine Clickerfragen verfügbar', noneText: 'Clickerfragen werden von Dozierenden erstellt, meist in der Veranstaltung aktiviert und von den Studierenden mit dieser App anonym beantwortet.',
      back: 'Zur Clicker-Liste springen', prev: 'Zum vorhergehenden Clicker springen', next: 'Zum nächsten Clicker springen', showSection: 'Abschnitt anzeigen', hideSection: 'Abschnitt ausblenden',
      one: 'eine Antwort', many: 'mehrere Antworten möglich', text: 'Textantwort', yourAnswer: 'Ihre Antwort',
      optRight: 'Diese Antwortoption ist korrekt', optWrong: 'Diese Antwortoption ist falsch', youRight: 'Ihre Auswahl ist richtig.', youWrong: 'Ihre Auswahl ist falsch.',
    },
  }[LANG];
  const tr = (o) => typeof o === 'string' ? o : o ? (o[LANG] || o.de || o.en || '') : '';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // Question and answer text comes from ETH as HTML (formatting, MathJax formulas as SVG/MathML, pictures as data:
  // URLs). It is shown inside a logged-in EduApp page, so it is cleaned first: only formatting, formula and picture
  // elements survive; scripts, frames, forms, event handlers, javascript: links, external pictures and style sheets
  // never do. (EduApp shows the same text itself; this is defence in depth, e.g. against a hijacked lecturer account.)
  const NS_HTML = 'http://www.w3.org/1999/xhtml', NS_SVG = 'http://www.w3.org/2000/svg', NS_MATH = 'http://www.w3.org/1998/Math/MathML';
  // allowed elements per namespace (an SVG or MathML name in the HTML namespace, or the other way round, is not the same thing)
  const SAFE = {
    [NS_HTML]: new Set(('a abbr b bdi bdo blockquote br caption center cite code col colgroup dd del dfn div dl dt em figcaption figure '
      + 'font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strike strong sub sup table tbody td tfoot th thead tr tt u ul var wbr').split(' ')),
    [NS_SVG]: new Set('svg g path use defs symbol rect line circle ellipse polygon polyline text tspan clippath lineargradient radialgradient stop mask pattern marker'.split(' ')),
    [NS_MATH]: new Set(('math mi mn mo ms mtext mspace mrow mfrac msqrt mroot mstyle merror mpadded mphantom mfenced menclose msub msup msubsup '
      + 'munder mover munderover mmultiscripts mprescripts none mtable mtr mtd mlabeledtr semantics').split(' ')),
  };
  // gone with everything inside: active content, and elements whose text the HTML parser treats specially (the classic
  // way to make cleaned markup change meaning when it is parsed again)
  const DROP_TAGS = /^(script|style|iframe|frame|frameset|object|embed|applet|link|meta|base|form|input|button|textarea|select|option|noscript|template|foreignobject|audio|video|source|track|portal|animate|animatemotion|animatetransform|set|image|feimage|annotation|annotation-xml|title|desc|xmp|noembed|noframes|plaintext|listing|mglyph|malignmark|maligngroup|mjx-assistive-mml|svg:style)$/;
  const SAFE_IMG = /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml)[;,]/i;   // pictures in questions are embedded (data:) only
  const FRAG = /^\s*url\(\s*['"]?#[\w.-]+['"]?\s*\)\s*$/i;                // url(#gradient) inside a formula
  function cleanOnce(html) {
    const t = document.createElement('template');               // inert: nothing in it runs or loads while it is cleaned
    t.innerHTML = html;
    const walk = (parent) => {
      for (const el of [...parent.children]) {
        const tag = el.localName.toLowerCase(), ns = el.namespaceURI;
        if (DROP_TAGS.test(tag)) { el.remove(); continue; }
        const ok = (SAFE[ns] && SAFE[ns].has(tag)) || (ns === NS_HTML && tag.startsWith('mjx-'));
        if (!ok) { walk(el); el.replaceWith(...el.childNodes); continue; }
        for (const { name } of [...el.attributes]) {
          const n = name.toLowerCase(), v = el.getAttribute(name) || '';
          const bad = n.startsWith('on') || n.startsWith('data-') || n.includes(':') && n !== 'xlink:href' && n !== 'xml:space'
            || ['srcset', 'formaction', 'action', 'background', 'ping', 'name', 'form', 'tabindex', 'autofocus', 'contenteditable', 'is', 'slot', 'part', 'target', 'download', 'usemap', 'lowsrc', 'dynsrc'].includes(n)
            || (n === 'id' && (ns !== NS_SVG || !/^[\w.-]+$/.test(v)))   // ids only inside formulas (MathJax links its glyphs by id)
            || /[\\]|\/\*|&#|expression\s*\(|@import|behavior\s*:|-moz-binding/i.test(v) && n !== 'd' && n !== 'alt' && n !== 'title'   // CSS escapes/comments/tricks
            || (/url\s*\(/i.test(v) && !FRAG.test(v))                        // nothing loads from elsewhere through CSS
            || (n === 'style' && /position\s*:\s*(fixed|sticky)/i.test(v))  // no overlays over the app's own buttons
            || (/(javascript|vbscript|data)\s*:/i.test(v.replace(/[\u0000- ]/g, '')) && !(tag === 'img' && n === 'src' && SAFE_IMG.test(v)))
            || ((n === 'href' || n === 'xlink:href') && (tag === 'use' ? !v.startsWith('#') : tag !== 'a' || ns !== NS_HTML || !/^(https?:\/\/|mailto:)/i.test(v.trim())))
            || (n === 'src' && (tag !== 'img' || !SAFE_IMG.test(v)));
          if (bad) el.removeAttribute(name);
        }
        if (tag === 'img' && !el.hasAttribute('src')) { el.remove(); continue; }
        if (tag === 'a' && ns === NS_HTML) el.setAttribute('rel', 'noopener noreferrer');
        walk(el);
      }
    };
    walk(t.content);
    return t.innerHTML;
  }
  const cleanCache = new Map();
  function clean(html) {
    html = String(html ?? '');
    if (!html) return '';
    let out = cleanCache.get(html);
    if (out !== undefined) return out;
    try {
      out = cleanOnce(html);
      // the cleaned markup must read the same when it is parsed again; if not, someone is playing parser games:
      // show the text only
      if (cleanOnce(out) !== out) out = esc(t2s(out));
    } catch { out = esc(t2s(html)); }
    if (cleanCache.size > 400) cleanCache.clear();
    cleanCache.set(html, out);
    return out;
  }
  function t2s(html) { const t = document.createElement('template'); t.innerHTML = html; return (t.content.textContent || '').replace(/\s+/g, ' ').trim(); }

  // icons: the Material Design glyphs EduApp uses for the same things
  const HAND = 'M10.185 8.826a.778.79 0 0 1 .778-.789.778.79 0 0 1 .777.79v3.528l.941.102 3.841 1.729c.412.19.661.607.661 1.065v3.442a1.216 1.216 0 0 1-1.166 1.183h-5.054c-.296 0-.576-.118-.778-.339l-3.81-3.315.575-.608a.77.77 0 0 1 .576-.252h.17l2.489 1.357zm-.778 2.716V8.826a1.555 1.579 0 0 1 1.556-1.578 1.555 1.579 0 0 1 1.555 1.578v2.716a3.15 3.15 0 0 0 1.555-2.716 3.11 3.157 0 0 0-3.11-3.157 3.11 3.157 0 0 0-3.11 3.157c0 1.16.63 2.171 1.554 2.716';
  const ICON = {
    check: '<path d="m8.795 15.875-4.17-4.17-1.42 1.41 5.59 5.59 12-12-1.41-1.41z"/>',
    close: '<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
    full: '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2m0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8m4.59-12.42L10 14.17l-2.59-2.58L6 13l4 4 8-8z"/>',
    half: '<path d="M13 2.03v2.02c4.39.54 7.5 4.53 6.96 8.92-.46 3.64-3.32 6.53-6.96 6.96v2c5.5-.55 9.5-5.43 8.95-10.93-.45-4.75-4.22-8.5-8.95-8.97m-2 .03c-1.95.19-3.81.94-5.33 2.2L7.1 5.74c1.12-.9 2.47-1.48 3.9-1.68zM4.26 5.67A9.9 9.9 0 0 0 2.05 11h2c.19-1.42.75-2.77 1.64-3.9zM15.5 8.5l-4.88 4.88-2.12-2.12-1.06 1.06 3.18 3.18 5.94-5.94zM2.06 13c.2 1.96.97 3.81 2.21 5.33l1.42-1.43A8 8 0 0 1 4.06 13zm5.04 5.37-1.43 1.37A10 10 0 0 0 11 22v-2a8 8 0 0 1-3.9-1.63"/>',
    tap: `<path d="${HAND}"/>`,
    tapoff: `<path d="${HAND}"/><path class="strike" d="M-5.384 19.371h21.241v1.531H-5.384z" transform="matrix(.62245 -.78266 .441 .8975 0 0)"/>`,
    chevron: '<path d="M7.41 8.58 12 13.17l4.59-4.59L18 10l-6 6-6-6z"/>',
    dots: '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>',
    refresh: '<path d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z"/>',
    night: '<path d="M17.75,4.09L15.22,6.03L16.13,9.09L13.5,7.28L10.87,9.09L11.78,6.03L9.25,4.09L12.44,4L13.5,1L14.56,4L17.75,4.09M21.25,11L19.61,12.25L20.2,14.23L18.5,13.06L16.8,14.23L17.39,12.25L15.75,11L17.81,10.95L18.5,9L19.19,10.95L21.25,11M18.97,15.95C19.8,15.87 20.69,17.05 20.16,17.8C19.84,18.25 19.5,18.67 19.08,19.07C15.17,23 8.84,23 4.94,19.07C1.03,15.17 1.03,8.83 4.94,4.93C5.34,4.53 5.76,4.17 6.21,3.85C6.96,3.32 8.14,4.21 8.06,5.04C7.79,7.9 8.75,10.87 10.95,13.06C13.14,15.26 16.1,16.22 18.97,15.95M17.33,17.97C14.5,17.81 11.7,16.64 9.53,14.5C7.36,12.31 6.2,9.5 6.04,6.68C3.23,9.82 3.34,14.64 6.35,17.66C9.37,20.67 14.19,20.78 17.33,17.97Z"/>',
    sunny: '<path d="M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M3.36,17L5.12,13.23C5.26,14 5.53,14.78 5.95,15.5C6.37,16.24 6.91,16.86 7.5,17.37L3.36,17M20.65,7L18.88,10.79C18.74,10 18.47,9.23 18.05,8.5C17.63,7.78 17.1,7.15 16.5,6.64L20.65,7M20.64,17L16.5,17.36C17.09,16.85 17.62,16.22 18.04,15.5C18.46,14.77 18.73,14 18.87,13.21L20.64,17M12,22L9.59,18.56C10.33,18.83 11.14,19 12,19C12.82,19 13.63,18.83 14.37,18.56L12,22Z"/>',
    exit: '<path d="M19,3H5C3.89,3 3,3.89 3,5V9H5V5H19V19H5V15H3V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3M10.08,15.58L11.5,17L16.5,12L11.5,7L10.08,8.41L12.67,11H3V13H12.67L10.08,15.58Z"/>',
    fullscreen: '<path d="M5,5H10V7H7V10H5V5M14,5H19V10H17V7H14V5M17,14H19V19H14V17H17V14M10,17V19H5V14H7V17H10Z"/>',
    minus: '<path d="M19,13H5V11H19V13Z"/>',
    clicker: '<path d="M12.0325 20.2597a1 1 0 10.0001 0ZM8.948 19.6295h6.0564l-.0024-8.9143H8.9481ZM11.8981 8.8136q1.389.0036 2.7767.0024c.806-.0181 1.5974.5988 1.6738 1.4205.0206 3.5572.0049 7.1169.0097 10.6741.1357.9199-.5648 1.8435-1.5102 1.8956-1.7271.0194-3.4554.0049-5.1813.0097-.9175.1212-1.961-.4315-2.0483-1.4253-.0218-3.5548-.0036-7.1132-.0097-10.6692-.1345-.9199.5648-1.8459 1.5102-1.898q1.3901-.0121 2.7791-.0097m.0897-4.5947c2.0156 0 4.0323.7515 5.4637 2.2495L15.9317 7.9896c-2.0241-1.9949-5.8031-2.167-7.8453.0364L6.5266 6.4686c1.4326-1.4981 3.4457-2.2495 5.4613-2.2495M12.0073 1a10.8353 10.8353 90 017.7144 3.23L18.3534 5.5996C15.081 2.2544 8.9713 2.086 5.6698 5.6238L4.3402 4.2906C6.0164 2.2023 9.1906.9855 12 1"></path>',
  };
  const icon = (name, cls = '', label = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="currentColor" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${ICON[name]}</svg>`;
  // course colours exactly as EduApp picks them (hash of course number + type into its palette)
  const PALETTE = ['#DC2A2A', '#1B365D', '#B11030', '#9F6B3F', '#DB0A5B', '#4B6319', '#000000', '#553529', '#40806A', '#663399', '#336E7B', '#9A12B3', '#7472E0', '#0000E0', '#550055', '#008080', '#4B6A88', '#5A781D', '#7D314C', '#80503D'];
  function courseColor(co) {
    let e = 0;
    for (const ch of `${co.code}${co.type}`) e = Math.imul(31, e) + ch.charCodeAt(0);
    e = e | 0; e = e + 2147483648;
    return PALETTE[e % (PALETTE.length - 1)];
  }

  const host = document.createElement('div');
  host.id = 'fast-clicker-host';
  const root = host.attachShadow({ mode: 'open' });
  let panelOpen = true;
  let mode = MODE;
  const ui = { view: 'list', id: null, group: [], pending: null, err: null, loading: false, spinUntil: 0 };
  const css = `
    :host{all:initial}
    *{box-sizing:border-box}
    [hidden]{display:none!important}
    .app{--bg:255,255,255;--sf:255,255,255;--sl:238,238,238;--on:0,0,0;--bo:.12;--hi:.87;--med:.6;--idle:.04;--openc:30,58,138;
      font:400 16px/1.5 DINNextLTW05,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:rgba(var(--on),var(--hi));background:rgb(var(--bg));
      -webkit-text-size-adjust:100%;text-align:left;position:relative;
      width:min(440px,calc(100vw - 24px));max-height:min(80vh,760px);overflow:auto;border-radius:14px;box-shadow:0 8px 30px #0005}
    :host(.dark) .app{--bg:18,18,18;--sf:33,33,33;--sl:66,66,66;--on:255,255,255;--hi:1;--med:.7;--idle:.1;--openc:147,197,253}
    :host(.focus) .app{width:100%;max-width:768px;margin:0 auto;min-height:100vh;min-height:100dvh;max-height:none;overflow:visible;border-radius:0;box-shadow:none}
    button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:left;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
    h2,h3,p,ul{margin:0;padding:0;font-size:inherit;font-weight:inherit}ul{list-style:none}
    .fab{background:#08407e;color:#fff;border-radius:22px;padding:10px 14px;font:600 14px system-ui,sans-serif;box-shadow:0 4px 14px #0004}
    .fab.alert{background:#c1121f;animation:pulse 1s infinite}
    @keyframes pulse{50%{transform:scale(1.06)}}
    @keyframes spin{to{transform:rotate(360deg)}}
    .ic{width:24px;height:24px;flex:none;display:block}
    .strike{fill:rgb(var(--on))}
    .iconbtn{width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;flex:none}
    .iconbtn:active{background:rgba(var(--on),.1)}
    /* app bar as in EduApp (Vuetify v-app-bar 64px) */
    .bar{position:sticky;top:0;z-index:7;display:flex;align-items:center;height:64px;padding:0 4px;background:rgb(var(--sf));border-bottom:2px solid rgba(var(--on),var(--bo))}
    .bar .iconbtn{width:48px;height:48px}
    .brand{display:flex;align-items:center;gap:8px;min-width:0;padding:0 8px}
    .brand h1{margin:0;font-size:20px;line-height:32px;font-weight:500;letter-spacing:.0125em;white-space:nowrap}
    .grow{flex:1;min-width:0}
    .rf{position:relative}.rf.busy .ic{animation:spin .8s linear infinite}
    .dot{width:8px;height:8px;border-radius:50%;background:#2a9d8f;flex:none}
    .dot{position:absolute;top:11px;right:11px;box-shadow:0 0 0 2px rgb(var(--sf))}
    .dot.slow{background:#9ca3af}.dot.err{background:#c1121f}.dot.warn{background:#e9a100}
    .tabs{display:flex;padding:10px 8px 0;background:rgb(var(--sl))}
    .tab{height:48px;padding:0 16px}
    .tab.on{background:rgb(var(--bg))}
    .pad{padding:16px}
    .empty{font-size:14px;line-height:1.45;color:rgba(var(--on),var(--med));padding:12px 16px 0}
    .empty b{color:rgba(var(--on),var(--hi))}
    .note{background:#fefce8;color:#854d0e;border-left:4px solid #facc15;padding:12px 16px;font-size:14px;line-height:1.43;margin:8px 16px}
    :host(.dark) .note{background:#3a3212;color:#fde68a}
    .note.gray{background:rgba(var(--on),.08);color:inherit;border-color:rgba(var(--on),.45)}
    .note.round{margin:0 0 12px;background:#fff4e5;color:#7a3e00;border-color:#f57c00;animation:pulse 1.6s 3}
    :host(.dark) .note.round{background:#3d2a12;color:#ffcc80}
    .dg{display:flex;min-height:100px}
    .day{display:flex;flex-direction:column;align-items:center;width:56px;padding:0 8px 16px 0;flex:none}
    .mon{font-size:12px;line-height:1.3333;padding-bottom:8px}
    .num{width:40px;height:40px;padding:8px;margin-bottom:4px;line-height:1.5;text-align:center;background:rgba(var(--on),var(--bo));border-radius:9999px}
    .num.today{color:#fff;background:#3b82f6}
    .dow{line-height:1}
    .dcs{flex:1 1 0%;min-width:0;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid rgba(var(--on),var(--bo))}
    .co{padding-left:8px;margin-bottom:12px}.co:last-child{margin-bottom:0}
    .ct{padding:8px 16px;margin-bottom:8px;font-size:17.6px;font-weight:700;color:#fff;border-radius:8px;overflow-wrap:anywhere}
    :host(.dark) .ct,:host(.dark) .gh{box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
    .rows{display:grid;gap:16px;grid-template-columns:minmax(0,1fr)}
    .row{display:flex;align-items:flex-start;width:100%;padding-right:16px;border-radius:6px}
    .row:active{background:rgba(var(--on),.06)}
    .sum{flex:1 1 0;min-width:0}
    .rt{font-size:14px;line-height:20px;font-weight:700;overflow-wrap:anywhere}
    .qs{position:relative;height:2em;margin:.25em 0;overflow:hidden;font-size:14px;line-height:2em;white-space:nowrap}
    .qs::after{position:absolute;top:0;right:0;bottom:0;width:24px;content:"";background:linear-gradient(90deg,rgba(var(--bg),0),rgba(var(--bg),.8) 60%,rgb(var(--bg)))}
    .qs svg{display:inline;max-width:none}
    .rs{width:24px;flex:none;margin-left:24px;padding-bottom:24px}
    .pill{display:inline-block;margin-left:8px;padding:0 8px;border-radius:9999px;font-size:11px;line-height:18px;font-weight:700;color:#fff;background:#2563eb;vertical-align:1px}
    .pill.live{animation:pulse 1.6s infinite}.pill.off{background:#6b7280}
    .c-open{color:rgb(var(--openc))}.c-ok{color:#15803d}.c-bad{color:#7f1d1d}.c-part{color:#d97706}.c-off{color:#9ca3af}
    :host(.dark) .c-ok{color:#4ade80}:host(.dark) .c-bad{color:#f87171}
    .lg{padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid rgba(var(--on),var(--bo))}
    .gh{display:flex;justify-content:space-between;align-items:center;width:100%;padding:8px;border-radius:8px;color:#fff}
    .gt{font-weight:500;overflow-wrap:anywhere}.gs{font-size:14px;line-height:20px}
    .gh .ic{margin:0 8px}.gh.exp .ic{transform:rotate(180deg)}
    .lg .rows{margin-top:16px}.lg .row{padding-left:8px}
    .more{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;padding:24px 16px;color:rgba(var(--on),var(--med));font-size:14px}
    .none b{display:block;margin-top:24px;font-size:24px;line-height:1.2;font-weight:700;color:rgba(var(--on),var(--hi))}
    .spin{width:28px;height:28px;border:3px solid rgba(var(--on),.2);border-top-color:rgba(var(--on),.75);border-radius:50%;animation:spin 1s linear infinite}
    .trow{display:flex;align-items:center;margin:8px 0}
    .trow .iconbtn{margin-left:-8px}.trow .ic{transform:rotate(90deg)}
    .trow h2{flex:1;min-width:0;font-weight:700;overflow-wrap:anywhere}
    .detail{padding:8px 16px 56px}
    .card{padding-bottom:16px}
    .course{font-size:12px;color:rgba(var(--on),var(--med));margin-bottom:8px}
    .q{line-height:1.5;overflow-x:auto;margin-bottom:24px}
    .q,.ans,.opt .grow{position:relative;contain:paint}   /* question text can never cover the app's own controls */
    .card.closed .q{margin-bottom:16px}
    /* question/answer content from EduApp: formulas (SVG), pictures (data: URLs), figures, lists, tables */
    .q svg,.opt svg,.ans svg{display:inline;max-width:100%}
    .q img,.opt img{max-width:100%;height:auto;background:#fff;border-radius:4px} /* white behind transparent diagrams (dark mode) */
    .ans img{max-width:100%;height:auto;background:#fff;border-radius:4px}
    .q img{cursor:zoom-in}
    .q figure,.opt figure{margin:8px 0}.q figure img{display:block;margin:0 auto}
    .q figcaption{font-size:12px;color:rgba(var(--on),var(--med));text-align:center;margin-top:4px}
    .q table,.opt table{border-collapse:collapse;margin:8px 0}.q td,.q th,.opt td,.opt th{border:1px solid rgba(var(--on),.3);padding:4px 8px}
    .q pre{overflow-x:auto}.q ul,.q ol{padding-left:1.4em;list-style:revert}
    .q p,.opt p,.ans p{margin:0 0 .5em}.q p:last-child,.opt p:last-child,.ans p:last-child{margin-bottom:0}
    .mjpage__block{display:block;text-align:center;margin:8px 0;overflow-x:auto}
    .display-latex{padding:4px;background:#fff}
    svg~.mathMLFormula{display:none}  /* EduApp ships every formula as SVG + hidden MathML; show the SVG once (MathML only if there is no SVG) */
    .zoom{position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;padding:12px;cursor:zoom-out}
    .zoom img{max-width:100%;max-height:100%;background:#fff;border-radius:4px}
    .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
    .opt{display:flex;align-items:center;gap:16px;width:100%;min-height:48px;padding:12px 8px;border-top:1px solid rgba(var(--on),var(--bo))}
    .opt:first-child{border-top:0}
    .opt.sel{background:rgba(37,99,235,.1)}
    .box{display:inline-block;width:16px;height:16px;flex:none;background:#fff center/100% no-repeat;border:1px solid #6b7280}
    .radio .box{border-radius:50%}
    .sel>.box{background-color:#2563eb;border-color:transparent;background-image:url("data:image/svg+xml,%3csvg viewBox='0 0 16 16' fill='white' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z'/%3e%3c/svg%3e")}
    .radio .sel>.box{background-image:url("data:image/svg+xml,%3csvg viewBox='0 0 16 16' fill='white' xmlns='http://www.w3.org/2000/svg'%3e%3ccircle cx='8' cy='8' r='3'/%3e%3c/svg%3e")}
    .opt.server::after{content:"saved";margin-left:auto;font-size:11px;color:#15803d;flex:none}
    :host(.dark) .opt.server::after{color:#4ade80}
    textarea{display:block;width:100%;min-height:80px;font:inherit;padding:8px 12px;border-radius:0;border:1px solid rgba(var(--on),.4);background:rgb(var(--sf));color:inherit}
    textarea.ro{background:rgba(var(--on),var(--idle))}
    .sendrow{display:flex;justify-content:flex-end;margin-top:8px}
    .send{display:flex;align-items:center;justify-content:center;min-height:44px;min-width:96px;padding:8px 16px;font-weight:600;color:#fff;background:#08407e;border-radius:4px}
    .send:active{background:#215caf}
    .send:disabled{opacity:.45}
    .st{font-size:14px;margin-top:8px;line-height:1.4;min-height:1.4em;text-align:right}.st.ok{color:#15803d}.st.err{color:#b91c1c}.st.warn{color:#b45309}.st.pending{color:rgba(var(--on),var(--med))}
    :host(.dark) .st.ok{color:#4ade80}:host(.dark) .st.err{color:#f87171}:host(.dark) .st.warn{color:#fbbf24}
    .summary{max-width:768px;padding:16px 8px;margin:0 0 16px;border-radius:4px}
    .summary.WRONG{background:rgba(176,0,32,.12)}.summary.CORRECT{background:rgba(76,175,80,.14)}.summary.PARTLY_CORRECT{background:rgba(251,140,0,.14)}.summary.UNANSWERED,.summary.ANSWERED{background:rgba(var(--on),var(--idle))}
    .res li{display:flex;align-items:baseline;padding:12px 8px}
    .res .box{margin-right:16px;opacity:.75;border-color:#9ca3af;position:relative;top:2px}
    .res .sel>.box,.res .box.on{background-color:#9ca3af}
    .res .w{flex:1;min-width:0}
    .vr{display:flex;max-width:320px;margin-top:4px}
    .vb{flex:1;min-width:0}.vt{font-size:14px;line-height:20px}
    .track{height:8px;background:rgb(var(--sl))}.fill{height:100%;background:#2563eb}
    .vi{display:flex;align-items:center;width:80px;flex:none;margin-left:16px;padding-top:8px}
    .v-ok{color:#16a34a}.v-no{color:#e11d48}
    .you{margin-left:8px;border-radius:4px;padding:4px 8px;font-size:12px;line-height:16px;font-weight:700}
    .you.ok{background:#bbf7d0;color:#14532d}.you.no{background:#fecdd3;color:#881337}
    .gnav{position:sticky;bottom:0;z-index:2;display:grid;grid-template-columns:48px auto 48px;align-items:center;justify-content:space-between;min-height:40px;padding:0 8px env(safe-area-inset-bottom);background:rgba(var(--bg),.75);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
    .gnav .prev .ic{transform:rotate(90deg)}.gnav .next .ic{transform:rotate(-90deg)}
    .row2{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
    .chip{font-size:14px;line-height:1.2;border:1px solid rgba(var(--on),.3);border-radius:18px;padding:8px 12px;min-height:36px}
    .chip.on{background:#08407e;color:#fff;border-color:#08407e}
    .chip.big{font-size:16px;padding:10px 18px;background:#08407e;color:#fff;border-color:#08407e;margin-top:6px}
    .foot{font-size:12px;line-height:16px;color:rgba(var(--on),var(--med));margin:24px 8px 0}
  `;
  root.innerHTML = `<style>${css}</style>
    <button class="fab" data-a="open"></button>
    <div class="app">
      <header class="bar">
        <div class="brand">${icon('clicker')}<h1>ETH Clicker</h1></div><span class="grow"></span>
        <button class="iconbtn x" data-a="min" title="Minimize" aria-label="Minimize">${icon('minus')}</button>
        <button class="iconbtn fs" data-a="focus" title="Full screen" aria-label="Full screen">${icon('fullscreen')}</button>
        <button class="iconbtn ex" data-a="exit" title="Back to EduApp" aria-label="Back to EduApp">${icon('exit')}</button>
        <button class="iconbtn rf" data-a="now" aria-label="Check now">${icon('refresh')}<span class="dot"></span></button>
        <button class="iconbtn" data-a="theme" id="themebtn"></button></header>
      <div id="banner"></div>
      <div id="listview">
        <div class="tabs"><button class="tab" data-a="grp" data-g="date">${L.byDate}</button><button class="tab" data-a="grp" data-g="lecture">${L.byLecture}</button></div>
        <div id="list" class="pad"></div>
      </div>
      <div id="detailview" hidden>
        <div class="detail">
          <div class="trow"><button class="iconbtn" data-a="back" aria-label="${esc(L.back)}">${icon('chevron')}</button><h2 id="dtitle"></h2></div>
          <div id="dmsg"></div>
          <div id="cards"></div>
        </div>
        <div class="gnav" id="gnav"></div>
      </div>
      <div class="zoom" hidden></div>
    </div>`;
  const $ = (sel) => root.querySelector(sel);
  const el = { fab: $('.fab'), app: $('.app'), dot: $('.dot'), themebtn: $('#themebtn'), refresh: $('.rf'), banner: $('#banner'), list: $('#list'), listview: $('#listview'),
    detailview: $('#detailview'), dtitle: $('#dtitle'), dmsg: $('#dmsg'), cards: $('#cards'), gnav: $('#gnav') };
  const setHtml = (node, html) => { if (node.__html !== html) { node.__html = html; node.innerHTML = html; } };
  let bannerOverride = null;
  function setBanner(text) { bannerOverride = text; render(); }

  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const isDark = () => CFG.theme === 'dark' || (CFG.theme !== 'light' && !!darkQuery && darkQuery.matches);
  function applyMode() {
    host.className = (mode === 'focus' ? 'focus' : '') + (isDark() ? ' dark' : '');
    host.style.cssText = mode === 'focus' ? 'display:block;position:relative;z-index:1' : 'position:fixed;z-index:2147483646;right:12px;bottom:12px;';
    if (mode === 'focus') {
      panelOpen = true;
      document.documentElement.style.background = isDark() ? '#121212' : '#fff';
    }
    if (hooks.onTheme) { try { hooks.onTheme(isDark()); } catch {} }      // the native app colours its status bar to match
  }
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', () => { applyMode(); });

  // EduApp's typeface (DIN Next) comes from EduApp's own style sheet. Where that is not loaded (the iPhone app shows
  // only this panel), take the font rules from it once and remember them.
  async function ensureFonts() {
    try {
      if (document.getElementById('fast-clicker-fonts') || /jsdom/i.test(navigator.userAgent)) return;
      if ([...document.styleSheets].some((sh) => /\/assets\/index-/.test(sh.href || ''))) return;
      let rules = localStorage.getItem('fast-clicker-fonts');
      const fresh = !rules;
      if (!rules) {
        const page = await fetch('/', { credentials: 'same-origin' });
        const m = page.ok && (await page.text()).match(/\/assets\/index-[\w-]+\.css/);
        if (!m) return;
        const sheet = await fetch(m[0], { credentials: 'same-origin' });
        if (!sheet.ok) return;
        rules = [...new Set((await sheet.text()).match(/@font-face\{[^}]*DINNextLTW05[^}]*\}/g) || [])].join('');
        if (!rules) return;
        localStorage.setItem('fast-clicker-fonts', rules);
      }
      const st = document.createElement('style');
      st.id = 'fast-clicker-fonts'; st.textContent = rules;
      document.head.appendChild(st);
      if (!fresh && document.fonts && document.fonts.load) {     // remembered rules may point to files of an older EduApp build
        const got = await document.fonts.load('16px DINNextLTW05').catch(() => []);
        if (!got.length) { st.remove(); localStorage.removeItem('fast-clicker-fonts'); ensureFonts(); }
      }
    } catch {}
  }

  // never rebuild DOM while a finger is down or an IME composition is active (would swallow the tap)
  let pointerDown = false, composing = false, renderPending = false;
  root.addEventListener('pointerdown', () => { pointerDown = true; unlockAudio(); });
  const pointerEnd = () => { if (pointerDown) { pointerDown = false; if (renderPending) setTimeout(render, 0); } };
  window.addEventListener('pointerup', pointerEnd, true);
  window.addEventListener('pointercancel', pointerEnd, true);
  root.addEventListener('compositionstart', () => { composing = true; });
  root.addEventListener('compositionend', () => { composing = false; if (renderPending) render(); });

  // ---- list
  const answeredLocally = (x) => {
    const c = state.clickers.get(x.id);
    return !!c && (c.type === 'TEXT' ? !!c.individualAnswer : (c.entries || []).some((e) => e.selected));
  };
  function statusOf(x) {                    // like EduApp's status icons, plus "answered" for open questions
    const a = x.answerState || 'UNANSWERED';
    if (x.state === 'OPEN') return a !== 'UNANSWERED' || answeredLocally(x) ? ['check', 'c-open', L.answered] : ['tap', 'c-open', L.pleaseAnswer];
    return { CORRECT: ['full', 'c-ok', L.CORRECT], WRONG: ['close', 'c-bad', L.WRONG], PARTLY_CORRECT: ['half', 'c-part', L.PARTLY_CORRECT], UNANSWERED: ['tapoff', 'c-off', L.UNANSWERED] }[a] || ['check', 'c-off', L.ANSWERED];
  }
  const sumCache = new Map();
  function summaryHtml(x) {                 // one line of the question: its first words and formulas
    const q = clean(x.question);
    const key = x.id + ':' + q.length;
    let out = sumCache.get(key);
    if (out !== undefined) return out;
    out = '';
    try {
      const doc = new DOMParser().parseFromString(q, 'text/html');
      const parts = [];
      let chars = 0;
      const walk = (node) => {
        for (const ch of node.childNodes) {
          if (parts.length >= 8 || chars > 160) return;
          if (ch.nodeType === 3) {
            const tx = ch.data.replace(/\s+/g, ' ').trim();
            if (tx) { parts.push(esc(tx.slice(0, 200))); chars += tx.length; }
          } else if (ch.nodeType === 1) {
            const cl = ch.classList;
            if (/^svg$/i.test(ch.tagName)) {                      // a formula: keep it, shrunk to the line if it is tall
              const w = parseFloat(ch.getAttribute('width')), h = parseFloat(ch.getAttribute('height')), va = parseFloat(ch.style.verticalAlign);
              if (w > 0 && h > 2.7) {
                const f = 2.7 / h;
                ch.setAttribute('height', '2.7ex'); ch.setAttribute('width', (w * f).toFixed(3) + 'ex');
                if (Number.isFinite(va)) ch.style.verticalAlign = (va * f).toFixed(3) + 'ex';
              }
              parts.push(ch.outerHTML); chars += 6;
            } else if (!/^(IMG|FIGURE|STYLE|SCRIPT|TABLE)$/i.test(ch.tagName) && !cl.contains('mathMLFormula') && !cl.contains('sr-only')) walk(ch);
          }
        }
      };
      walk(doc.body);
      out = parts.join(' ');
    } catch {}
    if (sumCache.size > 600) sumCache.clear();
    sumCache.set(key, out);
    return out;
  }
  function rowHtml(x, g) {
    const c = state.clickers.get(x.id);
    const [ic, cls, label] = statusOf(x);
    const pill = x.state !== 'OPEN' ? '' : c && c.roundStopped ? `<span class="pill off">${L.paused}</span>` : `<span class="pill${c && isLive(c) ? ' live' : ''}">${L.open}</span>`;
    return `<li><button class="row" data-a="view" data-id="${x.id}" data-g="${g}"><div class="sum"><h3 class="rt">${esc(x.title)}${pill}</h3><p class="qs">${summaryHtml(x)}</p></div><div class="rs">${icon(ic, cls, label)}</div></button></li>`;
  }
  const courseName = (co) => (co.type ? co.type + ': ' : '') + tr(co.title);
  const groupKey = (co) => String(co.type || '') + String(co.code || tr(co.title));
  function listHtml() {
    const list = state.list;
    let h = '';
    if (CFG.groupBy === 'lecture') {
      const groups = [...list.byCourse].sort((a, b) => (b.clickers.some((x) => x.state === 'OPEN') ? 1 : 0) - (a.clickers.some((x) => x.state === 'OPEN') ? 1 : 0));
      for (const co of groups) {
        const gi = list.byCourse.indexOf(co);
        const key = groupKey(co);
        const openN = co.clickers.filter((x) => x.state === 'OPEN' && (x.answerState || 'UNANSWERED') === 'UNANSWERED' && !answeredLocally(x)).length;
        const exp = CFG.expanded[key] !== undefined ? !!CFG.expanded[key] : co.clickers.some((x) => x.state === 'OPEN');
        h += `<li class="lg"><button class="gh${exp ? ' exp' : ''}" style="background:${courseColor(co)}" data-a="toggle" data-k="${esc(key)}" aria-expanded="${exp}" aria-label="${exp ? L.hideSection : L.showSection}">
          <div><h2 class="gt">${esc(courseName(co))}</h2><p class="gs">${L.total.replace('{n}', co.clickers.length)}${openN ? ', ' + L.unanswered.replace('{n}', openN) : ''}</p></div>${icon('chevron')}</button>
          ${exp ? `<ul class="rows">${co.clickers.map((x) => rowHtml(x, 'c' + gi)).join('')}</ul>` : ''}</li>`;
      }
      h = `<ul>${h}</ul>`;
    } else {
      const today = new Date(); const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      list.byDate.forEach((d, di) => {
        if (!d.courses || !d.courses.length) return;
        const key = String(d.date).slice(0, 10);
        const dt = new Date(key + 'T12:00:00');
        const loc = LANG === 'de' ? 'de-CH' : 'en-GB';
        h += `<li class="dg"><h2 class="day"><span class="mon">${esc(dt.toLocaleDateString(loc, { month: 'short' }))}</span><span class="num${key === todayKey ? ' today' : ''}">${dt.getDate()}</span><span class="dow">${esc(dt.toLocaleDateString(loc, { weekday: 'short' }))}</span></h2>
          <ul class="dcs">${d.courses.map((co, ci) => `<li class="co"><h3 class="ct" style="background:${courseColor(co)}">${esc(courseName(co))}</h3><ul class="rows">${co.clickers.map((x) => rowHtml(x, `d${di}.${ci}`)).join('')}</ul></li>`).join('')}</ul></li>`;
      });
      h = `<ul>${h}</ul>`;
    }
    const empty = !list.byDate.some((d) => d.courses && d.courses.length);
    if (state.scanning) h += `<div class="more"><div class="spin"></div></div>`;
    else if (list.partial) {
      h += `<div class="more${empty ? ' none' : ''}">${empty ? `<b>${L.noneTitle}</b><span>${L.noneText}</span>` : ''}
        ${state.listError ? `<span>Could not load earlier questions (${esc(state.listError)}).</span>` : ''}
        <button class="chip" data-a="scan">Show earlier questions</button><span>Downloads this semester's questions once (about 1 MB) and keeps them on this device.</span></div>`;
    } else if (empty) h += `<div class="more none"><b>${L.noneTitle}</b><span>${L.noneText}</span></div>`;
    return h;
  }
  function renderList() {
    for (const b of root.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.g === CFG.groupBy);
    const sig = JSON.stringify([CFG.groupBy, CFG.expanded, state.listRev, state.scanning, state.listError, isDark(),
      [...state.clickers.values()].filter((c) => c.state === 'OPEN').map((c) => [c.id, c.roundStopped, isLive(c), answeredLocally(c)])]);
    if (el.list.__sig === sig) return;
    el.list.__sig = sig;
    el.list.innerHTML = listHtml();
  }
  function groupOf(id, g) {                 // the questions listed together with this one (for previous / next)
    const list = state.list;
    let arr = null;
    if (g && g[0] === 'c') arr = (list.byCourse[Number(g.slice(1))] || {}).clickers;
    else if (g && g[0] === 'd') { const [di, ci] = g.slice(1).split('.').map(Number); arr = (((list.byDate[di] || {}).courses || [])[ci] || {}).clickers; }
    if (!arr) { const hit = (state.listIndex.get(id) || [])[0]; arr = hit && hit.course.clickers; }
    const ids = (arr || []).map((x) => x.id);
    return ids.includes(id) ? ids : [id];
  }
  function openDetail(id, g) {
    ui.view = 'detail'; ui.id = id; ui.group = groupOf(id, g); ui.err = null;
    state.dismissed.delete(id);
    if (ui.pending === id) ui.pending = null;
    const c = state.clickers.get(id);
    if (!c || c.state !== 'OPEN' || Date.now() - (c.fetchedAt || 0) > 5000) {     // results and counts: always read fresh
      ui.loading = !c;
      fetchClicker(id).then(() => { if (ui.id === id) ui.loading = false; render(); })
        .catch((e) => { if (ui.id === id) { ui.loading = false; ui.err = e instanceof AuthError ? null : e.message; } if (e instanceof AuthError) { state.authLost = true; tryRelogin(); } render(); });
    } else ui.loading = false;
    render();
    try { if (mode !== 'focus') el.app.scrollTop = 0; else if (!/jsdom/i.test(navigator.userAgent)) window.scrollTo(0, 0); } catch {}
  }
  function closeDetail() { ui.view = 'list'; ui.id = null; ui.err = null; render(); }
  function autoShow(id) {                   // a question just opened: put it on screen, unless an answer is in progress
    panelOpen = true;
    if (!CFG.autoOpen) { ui.pending = id; return; }
    const cur = ui.view === 'detail' && ui.id !== id ? state.clickers.get(ui.id) : null;
    if (cur && cur.state === 'OPEN' && (composing || state.sending.has(cur.id) || (state.draft.has(cur.id) && state.draft.get(cur.id).gen === cur.gen))) { ui.pending = id; return; }
    openDetail(id);
  }

  // ---- question page
  function cardSignature(c) {
    if (c.state !== 'OPEN') return JSON.stringify(['closed', c.title, c.type, c.question, c.answerState, c.showResults, c.individualAnswer, c.voteCount,
      (c.entries || []).map((e) => [e.id, e.answer, e.selected, e.correct, e.voteCount, e.voteRatio])]);
    const cur = c.type === 'TEXT' ? null : currentAnswer(c);
    return JSON.stringify([c.gen, c.title, c.courseTitle, c.type, c.question, c.roundStopped, voteAgain(c),
      c.type === 'TEXT' ? c.individualAnswer : c.entries.map((e) => [e.id, e.answer, e.selected, cur.includes(e.id)])]);
  }
  const kindText = (c) => c.type === 'MCMA' ? L.many : c.type === 'MCSA' ? L.one : L.text;
  function buildCard(c) {
    const div = document.createElement('div');
    div.className = 'card'; div.dataset.id = c.id;
    let h = `<h3 class="sr-only">${esc(c.title)}</h3><div class="course">${c.courseTitle ? esc(c.courseTitle) + ' · ' : ''}${kindText(c)}</div>`;
    if (c.roundStopped) h += `<div class="note gray" style="margin:0 0 12px">The lecturer stopped this round. You'll be alerted when the next round starts.</div>`;
    else if (voteAgain(c)) h += `<div class="note round" role="alert"><b>New round: vote again.</b> The lecturer restarted voting; your earlier answer does not count for this round. Choose and tap ${L.send}.</div>`;
    h += `<div class="q">${clean(c.question)}</div>`;
    if (c.type === 'TEXT') {
      h += `<textarea data-a="text" data-id="${c.id}" placeholder="${esc(L.yourAnswer)}">${esc(currentAnswer(c))}</textarea>`;
    } else {
      const cur = currentAnswer(c);
      h += `<div class="${c.type === 'MCSA' ? 'radio' : 'check'}">`;
      for (const e of c.entries) {
        h += `<button class="opt ${cur.includes(e.id) ? 'sel' : ''} ${e.selected ? 'server' : ''}" data-a="pick" data-id="${c.id}" data-e="${e.id}" role="${c.type === 'MCSA' ? 'radio' : 'checkbox'}" aria-checked="${cur.includes(e.id)}"><span class="box"></span><span class="grow">${clean(e.answer)}</span></button>`;
      }
      h += '</div>';
    }
    h += `<div class="sendrow"><button class="send" data-a="send" data-id="${c.id}"></button></div><div class="st" aria-live="polite"></div>
      <div class="row2"><button class="chip" data-a="reload" data-id="${c.id}">Reload question</button><button class="chip" data-a="dismiss" data-id="${c.id}">Hide</button></div>`;
    div.innerHTML = h;
    return div;
  }
  function buildClosed(c) {
    const div = document.createElement('div');
    div.className = 'card closed'; div.dataset.id = c.id;
    let h = `<h3 class="sr-only">${esc(c.title)}</h3><div class="q">${clean(c.question)}</div>`;
    const sumText = L[c.answerState];
    if (sumText) h += `<p class="summary ${esc(c.answerState)}">${sumText}</p>`;
    if (c.type === 'TEXT') h += `<textarea class="ro" readonly rows="8">${esc(c.individualAnswer || '')}</textarea>`;
    else {
      h += `<ul class="res ${c.type === 'MCSA' ? 'radio' : 'check'}">`;
      for (const e of c.entries || []) {
        let r = '';
        if (c.showResults && e.voteRatio !== undefined) {
          const ok = e.correct === true ? icon('check', 'v-ok', L.optRight) : e.correct === false ? icon('close', 'v-no', L.optWrong) : '';
          const you = !e.selected || e.correct === undefined ? '' : e.correct ? `<span class="you ok" aria-label="${esc(L.youRight)}">${L.you}</span>` : `<span class="you no" aria-label="${esc(L.youWrong)}">${L.you}</span>`;
          r = `<div class="vr"><div class="vb"><p class="vt">${esc(e.voteRatio)}% / ${esc(e.voteCount)} ${L.votes}</p><div class="track"><div class="fill" style="width:${Math.max(0, Math.min(100, Number(e.voteRatio) || 0))}%"></div></div></div><p class="vi">${ok}${you}</p></div>`;
        }
        h += `<li class="${e.selected ? 'sel' : ''}"><span class="box"></span><div class="w"><div class="ans">${clean(e.answer)}</div>${r}</div></li>`;
      }
      h += '</ul>';
    }
    h += `<div class="row2"><button class="chip" data-a="reload" data-id="${c.id}">Reload question</button></div>`;
    div.innerHTML = h;
    return div;
  }
  function patchCard(div, c) {
    if (c.state !== 'OPEN') return;
    const cur = currentAnswer(c);
    const ready = typeof cur === 'string' ? cur.trim().length > 0 : cur.length > 0;
    const already = (c.answerState && c.answerState !== 'UNANSWERED') || (c.type === 'TEXT' ? !!c.individualAnswer : c.entries.some((e) => e.selected));
    const btn = div.querySelector('.send');
    const sending = state.sending.has(c.id);
    btn.disabled = !ready && !sending;
    btn.textContent = sending ? 'Sending…' : already ? L.sendAgain : L.send;
    const st = state.status.get(c.id);
    const stEl = div.querySelector('.st');
    stEl.className = 'st ' + (st ? st.kind : '');
    stEl.textContent = st ? st.text : '';
  }

  function renderCards(live) {
    const shown = ui.view === 'detail' ? ui.id : null;
    const want = new Map(live.map((c) => [String(c.id), c]));
    const cur = shown != null ? state.clickers.get(shown) : null;
    if (cur) want.set(String(cur.id), cur);
    for (const div of [...el.cards.children]) if (!want.has(div.dataset.id)) div.remove();
    for (const c of want.values()) {
      let div = el.cards.querySelector(`.card[data-id="${c.id}"]`);
      const sig = cardSignature(c);
      if (!div || div.__sig !== sig) {
        const fresh = c.state === 'OPEN' ? buildCard(c) : buildClosed(c);
        fresh.__sig = sig;
        if (div) div.replaceWith(fresh); else el.cards.appendChild(fresh);
        div = fresh;
      }
      div.hidden = c.id !== shown;
      patchCard(div, c);
    }
  }
  function renderDetail() {
    const c = state.clickers.get(ui.id);
    const item = c || ((state.listIndex.get(ui.id) || [])[0] || {}).item;
    const label = !item ? '' : item.state !== 'OPEN' ? L.closed : c && c.roundStopped ? L.paused : L.open;
    el.dtitle.textContent = item ? `${item.title || ''} (${label})` : '';
    let msg = '';
    if (ui.err) msg = `<div class="note" style="margin:0 0 12px">Could not load this question (${esc(ui.err)}). <button class="chip" data-a="reload" data-id="${ui.id}">Try again</button></div>`;
    else if (!c) msg = `${item && item.question ? `<div class="q">${clean(item.question)}</div>` : ''}<div class="more"><div class="spin"></div></div>`;
    setHtml(el.dmsg, msg);
    const i = ui.group.indexOf(ui.id), n = ui.group.length;
    setHtml(el.gnav, n > 1 ? `${i > 0 ? `<button class="iconbtn prev" data-a="nav" data-d="-1" aria-label="${esc(L.prev)}">${icon('chevron')}</button>` : '<span></span>'}<p>${i + 1} / ${n}</p>${i < n - 1 ? `<button class="iconbtn next" data-a="nav" data-d="1" aria-label="${esc(L.next)}">${icon('chevron')}</button>` : '<span></span>'}` : '');
    el.gnav.hidden = n <= 1;
  }

  function render() {
    if (pointerDown || composing) { renderPending = true; return; }
    renderPending = false;
    const live = [...state.clickers.values()].filter(isLive);
    const alerting = live.some((c) => !c.roundStopped);
    el.fab.style.display = panelOpen ? 'none' : '';
    el.app.style.display = panelOpen ? '' : 'none';
    el.fab.className = 'fab' + (alerting ? ' alert' : '');
    el.fab.textContent = live.length ? `Clicker open (${live.length})` : 'ETH Clicker';
    $('.x').style.display = $('.fs').style.display = mode === 'focus' ? 'none' : '';
    $('.ex').style.display = mode === 'focus' && !hooks.noExit ? '' : 'none';
    const tone = !state.running ? 'slow' : state.authLost ? 'warn' : state.lastError ? 'err' : fastMode() ? '' : 'slow';
    el.dot.className = 'dot ' + tone;
    el.refresh.classList.toggle('busy', Date.now() < ui.spinUntil);
    const dk = isDark();
    setHtml(el.themebtn, icon(dk ? 'sunny' : 'night'));
    el.themebtn.setAttribute('aria-label', dk ? 'Switch to light mode' : 'Switch to dark mode');
    let banner = '';
    if (control.old) banner += `<div class="note">This version of ETH Clicker (${esc(VERSION)}) is out of date and has stopped checking for questions. <button class="chip big" data-a="update">Update</button></div>`;
    else if (control.pause) banner += `<div class="note">Checking for new questions is paused for now, to take load off EduApp. Use EduApp's own clicker meanwhile. Questions you open and answers you send here still work.</div>`;
    else if (control.update) banner += `<div class="note gray">A new version of ETH Clicker is available. <button class="chip" data-a="update">Update</button></div>`;
    if (state.authLost && state.loginNeeded) banner += `<div class="note">Your EduApp login expired. <button class="chip big" data-a="login">Log in</button><br>Opens the ETH login. Come back here afterwards. Answers you've chosen are kept.</div>`;
    else if (state.authLost) banner += `<div class="note">${esc(bannerOverride || 'Login expired. Renewing…')}</div>`;
    else if (state.lastError) banner += `<div class="note">Connection problem: ${esc(state.lastError)}. Retrying automatically.</div>`;
    if (CFG.sound && !hooks.nativeAlerts && (!audioCtx || audioCtx.state !== 'running')) banner += `<div class="note gray">Tap anywhere in this panel once to enable the alert sound.</div>`;
    if (!hooks.nativeAlerts && 'Notification' in window && Notification.permission === 'default') banner += `<div class="note gray">Get a notification when a question opens while this tab is in the background. <button class="chip" data-a="notif">Allow notifications</button></div>`;
    const pend = ui.pending != null ? state.clickers.get(ui.pending) : null;
    if (pend && pend.state === 'OPEN' && !(ui.view === 'detail' && ui.id === pend.id)) banner += `<div class="note">New question: <b>${esc(pend.title)}</b> <button class="chip big" data-a="view" data-id="${pend.id}">Show</button></div>`;
    else ui.pending = null;
    setHtml(el.banner, banner);
    if (ui.view === 'detail' && ui.id != null && state.dismissed.has(ui.id)) { ui.view = 'list'; ui.id = null; }
    const detail = ui.view === 'detail';
    el.listview.hidden = detail; el.detailview.hidden = !detail;
    if (!detail) renderList();
    renderCards(live);
    if (detail) renderDetail();
    updateStat();
  }
  function updateStat() {
    const ago = state.lastPollAt ? Math.round((Date.now() - state.lastPollAt) / 1000) + ' s ago' : 'starting…';
    let s;
    if (!state.running) s = 'paused';
    else if (!state.leader) s = 'live (checking in another tab)';
    else if (state.authLost) s = 'login expired';
    else if (navigator.onLine === false) s = 'offline, waiting for network';
    else s = `${fastMode() ? 'live' : 'standby (no lecture now)'}, checked ${ago}`;
    s = 'Check now. ' + s.charAt(0).toUpperCase() + s.slice(1);
    if (el.refresh.__label !== s) { el.refresh.__label = s; el.refresh.setAttribute('aria-label', s); el.refresh.title = s; }
  }

  // pictures in a question: tap to see them full screen, tap again to close
  const zoom = root.querySelector('.zoom');
  const closeZoom = () => { zoom.hidden = true; zoom.replaceChildren(); };
  root.addEventListener('click', (ev) => {
    if (!zoom.hidden) { closeZoom(); return; }
    if (ev.target.tagName === 'IMG' && ev.target.closest('.q')) {
      const img = document.createElement('img'); img.src = ev.target.src; img.alt = ev.target.alt || '';
      zoom.replaceChildren(img); zoom.hidden = false; return;
    }
    // a link in a question opens outside the app (the browser), never inside it
    const link = ev.target.closest('.q a[href], .ans a[href], .grow a[href]');
    if (link) {
      ev.preventDefault(); ev.stopPropagation();
      const u = link.href;
      if (/^(https?:|mailto:)/i.test(u)) { if (hooks.openUrl) { try { hooks.openUrl(u); } catch {} } else window.open(u, '_blank', 'noopener'); }
      return;
    }
    const b = ev.target.closest('[data-a]');
    if (b && b.closest('.q, .ans, .grow') && !b.matches('.opt, .opt *')) return;   // inside question text: never an app action
    if (!b) return;
    const id = b.dataset.id ? Number(b.dataset.id) : null;
    const c = id != null ? state.clickers.get(id) : null;
    switch (b.dataset.a) {
      case 'open': panelOpen = true; break;
      case 'min': panelOpen = false; break;
      case 'grp': CFG.groupBy = b.dataset.g === 'lecture' ? 'lecture' : 'date'; saveCfg(); break;
      case 'toggle': {
        const k = b.dataset.k;
        CFG.expanded[k] = b.getAttribute('aria-expanded') !== 'true';
        saveCfg(); break;
      }
      case 'view': openDetail(id, b.dataset.g); return;
      case 'back': closeDetail(); return;
      case 'nav': {
        const next = ui.group[ui.group.indexOf(ui.id) + Number(b.dataset.d)];
        if (next != null) { const g = ui.group; openDetail(next); ui.group = g; render(); }
        return;
      }
      case 'pick': {
        if (!c) break;
        const e = Number(b.dataset.e);
        if (c.type === 'MCSA') {
          setDraft(c, [e]);
          if (CFG.oneTap) { render(); sendVote(id); return; }
        } else {
          const cur = [...currentAnswer(c)];
          const i = cur.indexOf(e); i >= 0 ? cur.splice(i, 1) : cur.push(e);
          setDraft(c, cur);
        }
        break;
      }
      case 'send': sendVote(id); return;
      case 'dismiss': state.dismissed.add(id); break;
      case 'reload': ui.err = null; fetchClicker(id).then(render).catch((e) => { if (c) setStatus(id, 'err', e.message); else { ui.err = e.message; render(); } }); return;
      case 'theme': CFG.theme = isDark() ? 'light' : 'dark'; saveCfg(); applyMode(); break;
      case 'now': checkNow(); break;
      case 'scan': state.listError = null; startScan(); break;
      case 'notif': Notification.requestPermission().then(render); return;
      case 'login': openLogin(); break;
      case 'update': if (updateUrl) { if (hooks.openUrl) hooks.openUrl(updateUrl); else window.open(updateUrl, '_blank', 'noopener'); } return;
      case 'focus': show('focus'); return;
      case 'exit': location.href = '/'; return;
    }
    render();
  });
  // stop / resume checking in this tab (no button any more; tests and the other tabs' hand-over use it)
  function setRunning(on) {
    if (state.running === !!on) return;
    state.running = !!on;
    if (state.running) electLeader(); else { resignLeader(); relaySync(); }
    updateWakeLock(); render();
  }
  root.addEventListener('input', (ev) => {
    if (ev.target.dataset.a !== 'text') return;
    const c = state.clickers.get(Number(ev.target.dataset.id));
    if (!c) return;
    setDraft(c, ev.target.value);
    patchCard(ev.target.closest('.card'), c);
  });
  document.addEventListener('keydown', (ev) => {
    if (!zoom.hidden && ev.key === 'Escape') { closeZoom(); return; }
    if (!panelOpen || !zoom.hidden || ui.view !== 'detail' || (ev.target.closest && ev.target.closest('input,textarea,[contenteditable]')) || (root.activeElement && root.activeElement.tagName === 'TEXTAREA')) return;
    const c = state.clickers.get(ui.id);                         // only ever the question that is on screen
    const card = c && el.cards.querySelector(`.card[data-id="${c.id}"]`);
    if (!c || !isLive(c) || c.type === 'TEXT' || !card || card.hidden) return;
    const n = Number(ev.key);
    if (n >= 1 && n <= c.entries.length) {
      root.querySelector(`.opt[data-id="${c.id}"][data-e="${c.entries[n - 1].id}"]`).click();
      ev.preventDefault();
    } else if (ev.key === 'Enter') { sendVote(c.id); ev.preventDefault(); }
  });

  function show(newMode) {
    if (newMode === 'focus' && mode !== 'focus') {
      mode = 'focus';
      quietEduApp();
      if (state.leader) schedule(0);
      updateWakeLock();
    }
    panelOpen = true;
    applyMode();
    render();
  }

  // the phone's back button (Android app): close a zoomed picture, or go from a question back to the list.
  // Returns false when there is nothing to go back to here (the app then leaves the screen).
  function goBack() {
    if (!zoom.hidden) { closeZoom(); return true; }
    if (ui.view === 'detail') { closeDetail(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- start
  window.__fastClicker = { show, state, CFG, hooks, tick, fullScan, sendVote, relay, ui, openDetail, checkNow, setRunning, back: goBack, version: VERSION, control, fetchControl };
  if (mode === 'focus') quietEduApp(); else document.body.appendChild(host);
  applyMode();
  startTimers();
  render();
  electLeader();
  sweepSwCache();
  setTimeout(ensureFonts, 1500);
  control.timer = setTimeout(fetchControl, TS * 2000);           // after the start, not in its way
})();
