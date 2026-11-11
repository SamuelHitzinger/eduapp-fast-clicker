// ==UserScript==
// @name         EduApp Fast Clicker
// @namespace    https://eduapp.ethz.ch/
// @version      2.1.1
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
//   * focus mode (bookmarklet): stops the EduApp page's own background traffic and keeps the screen awake.
(() => {
  'use strict';
  const VERSION = '2.1.1';
  const MODE = window.__FC_MODE === 'focus' ? 'focus' : 'panel';
  if (window.__fastClicker) { window.__fastClicker.show(MODE); return; }
  if (location.hostname !== 'eduapp.ethz.ch') {
    if (confirm('Fast Clicker works inside EduApp.\n\nOpen EduApp now? Once it has loaded, tap the Fast Clicker bookmark again.')) {
      location.href = 'https://eduapp.ethz.ch/';
    }
    return;
  }

  const TIMER_WATERMARK = setTimeout(() => {}, 0); // timer ids up to here belong to the EduApp page
  const API = '/web/gw/';
  const SW_CACHE = 'api-requests';
  const LS_KEY = 'fast-clicker-settings';
  const CFG = Object.assign({
    cadenceMs: 4000,         // start-to-start feed poll interval around lectures (feed takes ~1.2 s itself)
    hiddenCadenceMs: 15000,  // same, while the tab is in the background
    idleCadenceMs: 50000,    // outside lectures (stays below the server's ~75 s keep-alive, so the line stays warm)
    maxBackoffMs: 30000,
    authCadenceMs: 15000, loginCadenceMs: 5000, silentEveryMs: 60000,
    leadMin: 10, tailMin: 15, // "around a lecture" = 10 min before start … 15 min after end
    openFastMin: 30,          // an open clicker keeps fast polling for at most this long after its last event
    voteDeadlineMs: 120000,   // keep trying to deliver an answer this long
    feedSmall: 8, feedLarge: 25,
    scanIfFeedSpanH: 6,       // skip the 1.1 MB list at start-up if the 25 newest events reach back this far
    oneTap: false, turbo: false, sound: true, keepAwake: true,
  }, JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
  const saveCfg = () => localStorage.setItem(LS_KEY, JSON.stringify({ oneTap: CFG.oneTap, turbo: CFG.turbo, sound: CFG.sound, keepAwake: CFG.keepAwake }));
  const hooks = window.__FC_HOOKS || {}; // test seams

  class AuthError extends Error {}
  class HttpError extends Error { constructor(status, msg, retryAfterMs) { super(msg); this.status = status; this.retryAfterMs = retryAfterMs; } }
  class NetError extends Error {}
  const isTransient = (e) => e instanceof NetError || (e instanceof HttpError && (e.status >= 500 || e.status === 429 || e.status === 408));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms, f = 0.15) => Math.round(ms * (1 - f + Math.random() * 2 * f));

  // ---------------------------------------------------------------- network
  const lat = { feed: 1300, detail: 500, vote: 500, other: 400, list: 3000 }; // EWMA of observed latency (ms)
  const minTimeout = { feed: 7000, detail: 7000, vote: 8000, other: 6000, list: 60000 };
  const timeoutFor = (kind) => Math.round((hooks.timeScale || 1) * Math.min(kind === 'list' ? 120000 : 30000, Math.max(minTimeout[kind], Math.round(3 * lat[kind] + 2500))));
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
      throw new NetError(e && e.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'network error');
    }
    try {
      if (r.status === 401 || r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) throw new AuthError('signed out');
      if (!r.ok) {
        const ra = Number(r.headers.get('retry-after'));
        throw new HttpError(r.status, `HTTP ${r.status}`, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : undefined);
      }
      const text = await r.text();
      const ct = r.headers.get('content-type') || '';
      if (text && !ct.includes('json')) throw new AuthError('signed out (got a web page instead of data)');
      const ms = performance.now() - t0;
      lat[kind] = Math.round(lat[kind] * 0.7 + ms * 0.3);
      state.lastLatency = Math.round(ms);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new NetError(`no answer within ${Math.round(timeoutMs / 1000)} s`);
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
    stamp: new Map(),            // id -> stamp of the newest send in ANY tab (time-based, broadcast to other tabs)
    unverified: new Map(),       // id -> {ans, gen, ver, stamp, took, repair, rechecks}: accepted, not yet re-read
    status: new Map(),
    scanDone: false, feedSpanOk: false, feedPrimed: false, lastOwnPollAt: 0,
    lastPollAt: 0, lastLatency: null, lastError: null, errorStreak: 0, retryAfterMs: 0,
    authLost: false, loginNeeded: false,
    running: true, timer: null, polling: false,
    leader: false,
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
        if (!state.running) { release(); return; }       // paused while queued: pass leadership on
        releaseLeader = release;
        becomeLeader();
      })).catch(() => becomeLeader());
      broadcast({ t: 'hello' });
    } else becomeLeader();
  }
  function resignLeader() {
    state.leader = false;
    clearTimeout(state.timer);
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
  const currentLecture = () => {
    const t = Date.now();
    return state.lectures.find((l) => t >= Date.parse(l.start) - CFG.leadMin * 60e3 && t <= Date.parse(l.end) + CFG.tailMin * 60e3);
  };
  const nextLecture = () => state.lectures.filter((l) => Date.parse(l.start) > Date.now()).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  const isLive = (c) => c.state === 'OPEN' && !state.dismissed.has(c.id);
  const hasFreshOpen = () => [...state.clickers.values()].some((c) => isLive(c) && !c.roundStopped && Date.now() - c.lastEventAt < CFG.openFastMin * 60e3);
  const fastMode = () => CFG.turbo || hasFreshOpen() || !!currentLecture() || !state.lecturesFetchedAt;

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
          lastEventAt: prev ? prev.lastEventAt : Date.now(),
          fetchedAt: Date.now(),
        });
        state.clickers.set(id, c);
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

  async function processClickerEvent(id, meta, initial) {
    const prev = state.clickers.get(id);
    if (!initial) fence(id);
    // a (possible) new round: invalidate drafts and in-flight sends now, once per event, before downloading
    if (!initial && prev && !ROUND_KEEP.has(meta.type) && !state.roundApplied.has(meta.activityId)) {
      prev.gen = (prev.gen || 0) + 1; state.roundApplied.add(meta.activityId); resetRound(id);
      if (meta.type === 'GAP') state.status.set(id, { kind: 'warn', text: 'Connection gap: a new round may have started. Check your answer and send again.' });
    }
    const { detail: c } = await fetchClicker(id);
    if (meta.courseTitle) c.courseTitle = meta.courseTitle;
    if (meta.type !== 'GAP') c.lastEventAt = meta.createdAt ? Math.min(Date.now(), Date.parse(meta.createdAt) || Date.now()) : Date.now();
    if (meta.type === 'CLICKER_STOP_ROUND') c.roundStopped = true;
    else if (meta.type !== 'CLICKER_CLOSE' && meta.type !== 'GAP') c.roundStopped = false;
    const alert = meta.type !== 'GAP' && c.state === 'OPEN' && !c.roundStopped && (!initial || Date.now() - c.lastEventAt < 3 * 3600e3);
    if (alert) { state.dismissed.delete(id); notify(c, true); }
    publish(c, alert);
  }
  function resetRound(id) {           // answers of a previous round must be chosen again explicitly
    state.draft.delete(id); state.status.delete(id); state.resend.delete(id); state.unverified.delete(id);
  }

  async function pollFeed(initial) {
    const gapSuspicious = !initial && Date.now() - state.lastOwnPollAt > 3 * CFG.hiddenCadenceMs;
    let n = initial || gapSuspicious ? CFG.feedLarge : CFG.feedSmall;
    let feed = await req(`dashboard/activity-feed?semkez=${state.semkez}&maxActivities=${n}`, { kind: 'feed' }) || [];
    const allNew = (f) => f.length >= n && f.every((a) => !state.receivedActivities.has(a.id));
    if (!initial && n < CFG.feedLarge && allNew(feed)) {           // burst: widen the window once
      n = CFG.feedLarge;
      feed = await req(`dashboard/activity-feed?semkez=${state.semkez}&maxActivities=${n}`, { kind: 'feed' }) || [];
    }
    const gap = !initial && allNew(feed);
    if (gap) { state.scanDone = false; state.gapCount++; }           // still a gap: reconcile with the list
    for (const a of feed) state.receivedActivities.add(a.id);
    if (initial) {
      const oldest = feed.length ? Date.parse(feed[feed.length - 1].createdAt) : 0;
      state.feedSpanOk = feed.length < n || (oldest && Date.now() - oldest > CFG.scanIfFeedSpanH * 3600e3);
      if (state.feedSpanOk) state.scanDone = true;                   // the feed already covers everything recent
    }
    const byClicker = new Map();
    for (const a of feed) {
      if (state.seenActivities.has(a.id)) continue;
      if (a.objectType !== 'CLICKER' || !a.objectId) { state.seenActivities.add(a.id); continue; }
      let g = byClicker.get(a.objectId);
      if (!g) byClicker.set(a.objectId, g = { latest: { activityId: a.id, type: a.type, createdAt: a.createdAt, courseTitle: a.courseTitle && (a.courseTitle.de || a.courseTitle.en) }, ids: [] });
      g.ids.push(a.id);
    }
    for (const [id, p] of state.pendingRefresh) if (!byClicker.has(id)) byClicker.set(id, p);
    if (gap) for (const c of state.clickers.values()) {
      if (c.state === 'OPEN' && !byClicker.has(c.id)) byClicker.set(c.id, { latest: { type: 'GAP', activityId: `gap-${state.gapCount}-${c.id}` }, ids: [] });
    }
    let authErr = null;
    await Promise.all([...byClicker].map(async ([id, g]) => {
      if (initial && g.latest.type === 'CLICKER_CLOSE' && !state.clickers.has(id)) { g.ids.forEach((x) => state.seenActivities.add(x)); return; }
      try {
        await processClickerEvent(id, g.latest, initial);
        g.ids.forEach((x) => state.seenActivities.add(x));     // acknowledge only after success
        state.pendingRefresh.delete(id);
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 403)) {   // deleted / not visible: drop
          g.ids.forEach((x) => state.seenActivities.add(x));
          state.pendingRefresh.delete(id);
          if (state.clickers.has(id)) { state.clickers.get(id).state = 'CLOSED'; }
          return;
        }
        state.pendingRefresh.set(id, g);                        // retried next poll
        if (e instanceof AuthError) authErr = e; else state.lastError = `question ${id}: ${e.message}`;
      }
    }));
    if (authErr) throw authErr;
    if (state.seenActivities.size > 5000) state.seenActivities = new Set([...state.seenActivities].slice(-1000));
    if (state.receivedActivities.size > 5000) state.receivedActivities = new Set([...state.receivedActivities].slice(-1000));
  }

  async function fullScan() {
    const list = await req(`clickers?semkez=${state.semkez}`, { kind: 'list', priority: 'low' });
    const todo = [];
    for (const course of (list && list.byCourse) || []) {
      const courseTitle = (course.title && (course.title.de || course.title.en)) || course.code;
      for (const c of course.clickers || []) {
        const known = state.clickers.get(c.id);
        if ((c.state === 'OPEN' && !known) || (known && known.state !== c.state)) todo.push([c.id, courseTitle, known]);
      }
    }
    await Promise.all(todo.map(async ([id, courseTitle, known]) => {
      const reopened = known && known.state !== 'OPEN';
      const { detail } = await fetchClicker(id);
      detail.courseTitle = detail.courseTitle || courseTitle;
      let alert = false;
      if (detail.state === 'OPEN' && (!known || reopened)) {
        if (reopened) { detail.roundStopped = false; detail.gen = (detail.gen || 0) + 1; resetRound(id); }
        detail.lastEventAt = Date.now();
        state.dismissed.delete(id);
        notify(detail, true); alert = true;
      }
      publish(detail, alert);
    }));
    state.scanDone = true;
  }

  // ---------------------------------------------------------------- poll loop (leader only)
  async function tick() {
    if (!state.running || state.polling || !state.leader) return;
    state.polling = true;
    const started = Date.now();
    try {
      if (state.authLost) { await tryRelogin(); if (state.authLost) return; }
      if (!state.semkez) state.semkez = (await req('semesters/current')).semkez;
      if (Date.now() - state.lecturesFetchedAt > 10 * 60e3) await loadLectures();
      state.lastError = null;
      await pollFeed(!state.feedPrimed);           // first own poll (also after taking over from another tab)
      state.feedPrimed = true;
      state.lastPollAt = state.lastOwnPollAt = Date.now();
      state.errorStreak = 0; state.retryAfterMs = 0;
      if (!state.scanDone && !state.scanning) {                 // low priority, not awaited
        state.scanning = true;
        fullScan().catch((e) => { if (e instanceof AuthError) state.authLost = true; }).finally(() => { state.scanning = false; render(); });
      }
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
      schedule(undefined, started);
    }
  }
  function schedule(ms, startedAt = Date.now()) {
    clearTimeout(state.timer);
    if (!state.running || !state.leader) return;
    if (ms === undefined) {
      let cadence = !fastMode() ? CFG.idleCadenceMs : document.hidden ? CFG.hiddenCadenceMs : CFG.cadenceMs;
      if (lat.feed > 2500) cadence = Math.max(cadence, Math.round(lat.feed * 3)); // server slower than usual: back off
      if (state.authLost) cadence = state.loginNeeded ? CFG.loginCadenceMs : CFG.authCadenceMs;
      else if (state.errorStreak) cadence = Math.max(state.retryAfterMs, Math.min(CFG.maxBackoffMs, 2000 * 2 ** (state.errorStreak - 1)), Math.min(cadence, 8000));
      ms = Math.max(0, jitter(cadence) - (Date.now() - startedAt));
    }
    state.timer = setTimeout(tick, ms);
  }
  const pokeNow = () => { if (state.leader && !state.polling) schedule(0); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pokeNow(); updateWakeLock(); });
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
    if (await checkSession()) return loggedIn();      // e.g. the user logged in in another tab
    state.loginNeeded = true;
    render();
  }
  function loggedIn() {
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
      if (back && await checkSession()) { clearInterval(iv); loggedIn(); }
    }, 2000);
  }
  async function waitForSession(deadline) {
    while (state.authLost && Date.now() < deadline) await sleep(Math.max(50, 1000 * (hooks.timeScale || 1)));
    return !state.authLost;
  }

  // ---------------------------------------------------------------- voting
  const answerOf = (c) => c.type === 'TEXT' ? (c.individualAnswer || '') : c.entries.filter((e) => e.selected).map((e) => e.id);
  const currentAnswer = (c) => { const d = state.draft.get(c.id); return d && d.gen === c.gen ? d.value : answerOf(c); };
  const sameAnswer = (a, b) => typeof a === 'string' ? a.trim() === String(b).trim()
    : Array.isArray(b) && a.length === b.length && [...a].sort().join() === [...b].sort().join();
  function setDraft(c, value) { state.draft.set(c.id, { value, ver: ++state.draftVer, gen: c.gen }); }
  const backoff = (n, ra) => (hooks.timeScale || 1) * Math.max(ra || 0, jitter(Math.min(4000, 400 * 2 ** (n - 1)), 0.3));
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
          attempt++;
          try {
            await req(`clickers/${id}/vote`, { method: 'POST', body, kind: 'vote' });
            delivered = true;
            return;
          } catch (e) {
            if (e instanceof AuthError) { state.authLost = true; continue; }
            if (!isTransient(e)) {
              setStatus(id, 'err', e.status >= 400 && e.status < 500 ? `Not accepted (HTTP ${e.status}). Is the round still running?` : `Failed: ${e.message}`);
              attempt = -1; return;
            }
            if (Date.now() > deadline) return;
            setStatus(id, 'pending', `${e.message === 'offline' ? 'Offline' : 'Weak connection'}, still trying… (attempt ${attempt + 1})`);
            await waitOnlineOr(backoff(attempt, e.retryAfterMs));
          }
        }
      });
      if (!delivered) {
        if (attempt >= 0 && state.stamp.get(id) === stamp && state.clickers.get(id).gen === gen && state.clickers.get(id).state === 'OPEN') {
          setStatus(id, 'err', 'Could not reach EduApp for 2 minutes. Tap Send to try again.');
        }
        return;
      }
      fence(id);                                                 // only re-reads issued after the vote count
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
      catch { await sleep((hooks.timeScale || 1) * 1000 * (i + 1)); }
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
    if (c.state === 'OPEN' && !newer && u.repair < 2) {         // e.g. an older request landed late
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
  function notify(c, desktop) {
    if (hooks.onAlert) {                 // native app shell: it plays sound, vibrates and notifies
      try { hooks.onAlert({ id: c.id, title: c.title || '', course: c.courseTitle || '' }); } catch {}
      panelOpen = true;
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
      try { new Notification('Clicker open: ' + (c.title || ''), { body: c.courseTitle || 'EduApp', tag: 'fast-clicker-' + c.id }); } catch {}
    }
    panelOpen = true;
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
    document.title = 'Fast Clicker · EduApp';
    if (!document.querySelector('meta[name=viewport]')) {
      const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width,initial-scale=1'; document.head.appendChild(m);
    }
    document.documentElement.style.cssText = `background:${window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? '#1d1f23' : '#fff'}`;
    document.body.style.cssText = 'margin:0';
  }
  const myTimers = { stat: null, sweep: null, recheck: null };
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
    clearInterval(myTimers.stat); clearInterval(myTimers.sweep); clearInterval(myTimers.recheck);
    myTimers.stat = setInterval(updateStat, 1000);
    myTimers.sweep = setInterval(sweepSwCache, 60e3);
    myTimers.recheck = setInterval(recheckUnverified, Math.max(200, 10000 * (hooks.timeScale || 1)));
  }

  // ---------------------------------------------------------------- UI (shadow DOM, isolated from the app's CSS)
  const host = document.createElement('div');
  host.id = 'fast-clicker-host';
  const root = host.attachShadow({ mode: 'open' });
  let panelOpen = true;
  let mode = MODE;
  const css = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    .fab{background:#1f407a;color:#fff;border:0;border-radius:22px;padding:10px 14px;font-size:14px;box-shadow:0 4px 14px #0004;cursor:pointer}
    .fab.alert{background:#c1121f;animation:pulse 1s infinite}
    @keyframes pulse{50%{transform:scale(1.06)}}
    .panel{width:min(440px,calc(100vw - 24px));max-height:min(80vh,760px);overflow:auto;background:#fff;color:#111;border-radius:14px;box-shadow:0 8px 30px #0005;padding:12px}
    :host(.focus) .panel{width:100%;max-width:760px;margin:0 auto;min-height:100vh;max-height:none;border-radius:0;box-shadow:none;padding:14px 14px 40px}
    :host(.focus) .q,:host(.focus) .opt{font-size:16px}
    .bar{display:flex;align-items:center;gap:8px;font-size:12px;color:#888;margin-bottom:8px}
    .bar b{font-size:15px;color:#1f407a}
    .dot{width:10px;height:10px;border-radius:50%;background:#2a9d8f;flex:none}
    .dot.slow{background:#999}.dot.err{background:#c1121f}.dot.warn{background:#e9a100}
    .grow{flex:1;min-width:0}
    .x{background:none;border:0;font-size:18px;cursor:pointer;color:inherit;padding:4px 8px}
    .card{border:1px solid #ddd;border-radius:12px;padding:12px;margin:10px 0}
    .card h3{margin:0 0 4px;font-size:16px}
    .course{font-size:12px;color:#888;margin-bottom:8px}
    .q{font-size:14px;line-height:1.45;overflow-x:auto}
    /* question/answer content from EduApp: formulas (SVG), pictures (data: URLs), figures, lists, tables */
    .q svg,.opt svg{max-width:100%}
    .q img,.opt img{max-width:100%;height:auto;background:#fff;border-radius:4px} /* white behind transparent diagrams (dark mode) */
    .q img{cursor:zoom-in}
    .q figure,.opt figure{margin:8px 0}.q figure img{display:block;margin:0 auto}
    .q figcaption{font-size:12px;color:#888;text-align:center;margin-top:4px}
    .q table,.opt table{border-collapse:collapse;margin:8px 0}.q td,.q th,.opt td,.opt th{border:1px solid #bbc;padding:4px 8px}
    .q pre{overflow-x:auto}.q ul,.q ol{padding-left:1.4em}
    .mjpage__block{display:block;text-align:center;margin:8px 0;overflow-x:auto}
    .zoom{position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;padding:12px;cursor:zoom-out}
    .zoom[hidden]{display:none}.zoom img{max-width:100%;max-height:100%;background:#fff;border-radius:4px}
    .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
    .opt{display:flex;gap:10px;align-items:flex-start;width:100%;text-align:left;margin:8px 0;padding:12px;border:2px solid #ccd;border-radius:12px;background:#f6f7fb;color:#111;font-size:14px;cursor:pointer;min-height:48px}
    .opt.sel{border-color:#1f407a;background:#dfe7f6}
    .opt .n{font-weight:700;min-width:1.4em}
    .opt .grow>:first-child,.q>:first-child{margin-top:0}.opt .grow>:last-child{margin-bottom:0}
    .opt.server::after{content:"saved";margin-left:auto;font-size:11px;color:#2a9d8f;flex:none}
    textarea{width:100%;min-height:100px;font-size:16px;padding:10px;border-radius:10px;border:1px solid #ccd}
    .send{width:100%;padding:14px;font-size:17px;font-weight:600;border:0;border-radius:12px;background:#1f407a;color:#fff;cursor:pointer;margin-top:8px}
    .send:disabled{opacity:.45}
    .st{font-size:13px;margin-top:8px;line-height:1.35}.st.ok{color:#1e8a7e}.st.err{color:#c1121f}.st.warn{color:#b26b00}.st.pending{color:#888}
    .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
    .chip{font-size:12px;border:1px solid #ccd;border-radius:14px;padding:6px 10px;background:none;color:inherit;cursor:pointer}
    .chip.on{background:#1f407a;color:#fff;border-color:#1f407a}
    .chip.big{font-size:15px;padding:10px 16px;background:#1f407a;color:#fff;border-color:#1f407a}
    .empty{font-size:14px;color:#777;padding:18px 4px;line-height:1.5}
    .note{background:#fff3cd;color:#664d03;border-radius:10px;padding:10px;font-size:13px;margin:8px 0;line-height:1.4}
    .foot{font-size:11px;color:#999;margin-top:14px}
    svg~.mathMLFormula{display:none}  /* EduApp ships every formula as SVG + hidden MathML; show the SVG once (MathML only if there is no SVG) */
    @media (prefers-color-scheme:dark){
      .panel{background:#1d1f23;color:#eee}
      .card{border-color:#333}
      .opt{background:#2a2d33;border-color:#444;color:#eee}
      .opt.sel{background:#22406f;border-color:#8fb0e8}
      textarea{background:#2a2d33;color:#eee;border-color:#444}
      .bar b{color:#8fb0e8}
    }
  `;
  root.innerHTML = `<style>${css}</style>
    <button class="fab" data-a="open"></button>
    <div class="panel">
      <div class="bar"><span class="dot"></span><b>Fast Clicker</b><span class="grow" id="stat"></span><button class="x" data-a="min" title="Minimize">–</button></div>
      <div id="banner"></div><div id="empty" class="empty"></div><div id="cards"></div><div id="chips" class="row"></div>
      <div class="foot">v${VERSION} · runs only in this tab, talks only to eduapp.ethz.ch</div>
    </div><div class="zoom" hidden></div>`;
  const $ = (sel) => root.querySelector(sel);
  const el = { fab: $('.fab'), panel: $('.panel'), dot: $('.dot'), stat: $('#stat'), banner: $('#banner'), empty: $('#empty'), cards: $('#cards'), chips: $('#chips') };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const setHtml = (node, html) => { if (node.__html !== html) { node.__html = html; node.innerHTML = html; } };
  let bannerOverride = null;
  function setBanner(text) { bannerOverride = text; render(); }

  function applyMode() {
    host.className = mode === 'focus' ? 'focus' : '';
    host.style.cssText = mode === 'focus' ? 'display:block;position:relative;z-index:1' : 'position:fixed;z-index:2147483646;right:12px;bottom:12px;';
    if (mode === 'focus') panelOpen = true;
  }

  // never rebuild DOM while a finger is down or an IME composition is active (would swallow the tap)
  let pointerDown = false, composing = false, renderPending = false;
  root.addEventListener('pointerdown', () => { pointerDown = true; unlockAudio(); });
  const pointerEnd = () => { if (pointerDown) { pointerDown = false; if (renderPending) setTimeout(render, 0); } };
  window.addEventListener('pointerup', pointerEnd, true);
  window.addEventListener('pointercancel', pointerEnd, true);
  root.addEventListener('compositionstart', () => { composing = true; });
  root.addEventListener('compositionend', () => { composing = false; if (renderPending) render(); });

  function cardSignature(c) {
    const cur = c.type === 'TEXT' ? null : currentAnswer(c);
    return JSON.stringify([c.gen, c.title, c.courseTitle, c.type, c.question, c.roundStopped,
      c.type === 'TEXT' ? c.individualAnswer : c.entries.map((e) => [e.id, e.answer, e.selected, cur.includes(e.id)])]);
  }
  function buildCard(c) {
    const div = document.createElement('div');
    div.className = 'card'; div.dataset.id = c.id;
    let h = `<h3>${esc(c.title)}</h3><div class="course">${c.courseTitle ? esc(c.courseTitle) + ' · ' : ''}${c.type === 'MCMA' ? 'multiple answers possible' : c.type === 'MCSA' ? 'one answer' : 'text answer'}</div>`;
    if (c.roundStopped) h += `<div class="note">The lecturer stopped this round. You'll be alerted when the next round starts.</div>`;
    h += `<div class="q">${c.question || ''}</div>`;
    if (c.type === 'TEXT') {
      h += `<textarea data-a="text" data-id="${c.id}" placeholder="Your answer">${esc(currentAnswer(c))}</textarea>`;
    } else {
      const cur = currentAnswer(c);
      c.entries.forEach((e, i) => {
        h += `<button class="opt ${cur.includes(e.id) ? 'sel' : ''} ${e.selected ? 'server' : ''}" data-a="pick" data-id="${c.id}" data-e="${e.id}"><span class="n">${i + 1}</span><span class="grow">${e.answer || ''}</span></button>`;
      });
    }
    h += `<button class="send" data-a="send" data-id="${c.id}"></button><div class="st"></div>
      <div class="row"><button class="chip" data-a="dismiss" data-id="${c.id}">Hide</button><button class="chip" data-a="reload" data-id="${c.id}">Reload question</button></div>`;
    div.innerHTML = h;
    return div;
  }
  function patchCard(div, c) {
    const cur = currentAnswer(c);
    const ready = typeof cur === 'string' ? cur.trim().length > 0 : cur.length > 0;
    const already = (c.answerState && c.answerState !== 'UNANSWERED') || (c.type === 'TEXT' ? !!c.individualAnswer : c.entries.some((e) => e.selected));
    const btn = div.querySelector('.send');
    const sending = state.sending.has(c.id);
    btn.disabled = !ready && !sending;
    btn.textContent = sending ? 'Sending…' : already ? 'Send again' : 'Send answer';
    const st = state.status.get(c.id);
    const stEl = div.querySelector('.st');
    stEl.className = 'st ' + (st ? st.kind : '');
    stEl.textContent = st ? st.text : '';
  }
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function render() {
    if (pointerDown || composing) { renderPending = true; return; }
    renderPending = false;
    const open = [...state.clickers.values()].filter(isLive);
    const alerting = open.some((c) => !c.roundStopped);
    el.fab.style.display = panelOpen ? 'none' : '';
    el.panel.style.display = panelOpen ? '' : 'none';
    el.fab.className = 'fab' + (alerting ? ' alert' : '');
    el.fab.textContent = open.length ? `Clicker open (${open.length})` : 'Clicker';
    $('.x').style.display = mode === 'focus' ? 'none' : '';
    el.dot.className = 'dot ' + (state.authLost ? 'warn' : state.lastError ? 'err' : fastMode() ? '' : 'slow');
    let banner = '';
    if (state.authLost && state.loginNeeded) banner = `<div class="note">Your EduApp login expired. <button class="chip big" data-a="login">Log in</button><br>Opens the ETH login. Come back here afterwards. Answers you've chosen are kept.</div>`;
    else if (state.authLost) banner = `<div class="note">${esc(bannerOverride || 'Login expired. Renewing…')}</div>`;
    else if (state.lastError) banner = `<div class="note">Connection problem: ${esc(state.lastError)}. Retrying automatically.</div>`;
    if (CFG.sound && !hooks.nativeAlerts && (!audioCtx || audioCtx.state !== 'running')) banner += `<div class="note">Tap anywhere in this panel once to enable the alert sound.</div>`;
    setHtml(el.banner, banner);
    if (!open.length) {
      const cl = currentLecture(), nl = nextLecture();
      const title = (l) => esc((l.title && (l.title.en || l.title.de)) || l.code);
      el.empty.innerHTML = `No open clicker question right now. Keep this tab open: you'll get a sound${navigator.vibrate ? ' and vibration' : ''} the moment one opens.` +
        (cl ? `<br><br>Watching closely: <b>${title(cl)}</b> (until ${fmtTime(cl.end)})` : nl ? `<br><br>Next lecture: <b>${title(nl)}</b> at ${fmtTime(nl.start)}. Fast checking starts ${CFG.leadMin} min before.` : '');
    } else el.empty.textContent = '';
    const want = new Set(open.map((c) => String(c.id)));
    for (const div of [...el.cards.children]) if (!want.has(div.dataset.id)) div.remove();
    for (const c of open) {
      let div = el.cards.querySelector(`.card[data-id="${c.id}"]`);
      const sig = cardSignature(c);
      if (!div || div.__sig !== sig) {
        const fresh = buildCard(c);
        fresh.__sig = sig;
        if (div) div.replaceWith(fresh); else el.cards.appendChild(fresh);
        div = fresh;
      }
      patchCard(div, c);
    }
    setHtml(el.chips, `
      <button class="chip ${CFG.oneTap ? 'on' : ''}" data-a="onetap" title="One-answer questions: tapping an option sends it immediately">1-tap send</button>
      <button class="chip ${CFG.sound ? 'on' : ''}" data-a="sound">Sound</button>
      ${mode === 'focus' ? `<button class="chip ${CFG.keepAwake ? 'on' : ''}" data-a="awake" title="Keep the screen on around lectures">Screen on</button>` : ''}
      <button class="chip ${CFG.turbo ? 'on' : ''}" data-a="turbo" title="Check fast even outside your timetable (e.g. exercise sessions)">Always fast</button>
      ${'Notification' in window && Notification.permission === 'default' ? '<button class="chip" data-a="notif">Notifications</button>' : ''}
      <button class="chip" data-a="now">Check now</button>
      <button class="chip" data-a="scan" title="Download the full clicker list once (about 1 MB)">Full scan</button>
      ${mode === 'focus' ? (hooks.noExit ? '' : '<button class="chip" data-a="exit">Back to EduApp</button>') : '<button class="chip" data-a="focus" title="Full screen, stops EduApp\'s own background downloads">Focus mode</button>'}
      <button class="chip" data-a="pause">${state.running ? 'Pause' : 'Resume'}</button>`);
    updateStat();
  }
  function updateStat() {
    const ago = state.lastPollAt ? Math.round((Date.now() - state.lastPollAt) / 1000) + ' s ago' : 'starting…';
    let s;
    if (!state.running) s = 'paused';
    else if (!state.leader) s = 'live (checking in another tab)';
    else if (state.authLost) s = 'login expired';
    else if (navigator.onLine === false) s = 'offline, waiting for network';
    else s = `${fastMode() ? 'live' : 'standby (no lecture now)'} · checked ${ago}`;
    el.stat.textContent = s;
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
    const b = ev.target.closest('[data-a]');
    if (!b) return;
    const id = b.dataset.id ? Number(b.dataset.id) : null;
    const c = id != null ? state.clickers.get(id) : null;
    switch (b.dataset.a) {
      case 'open': panelOpen = true; break;
      case 'min': panelOpen = false; break;
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
      case 'reload': fetchClicker(id).then(render).catch((e) => setStatus(id, 'err', e.message)); return;
      case 'turbo': CFG.turbo = !CFG.turbo; saveCfg(); pokeNow(); break;
      case 'onetap': CFG.oneTap = !CFG.oneTap; saveCfg(); break;
      case 'sound': CFG.sound = !CFG.sound; saveCfg(); unlockAudio(); break;
      case 'awake': CFG.keepAwake = !CFG.keepAwake; saveCfg(); updateWakeLock(); break;
      case 'now': pokeNow(); break;
      case 'scan': fullScan().then(render).catch((e) => { state.lastError = 'full scan: ' + e.message; render(); }); break;
      case 'notif': Notification.requestPermission().then(render); return;
      case 'login': openLogin(); break;
      case 'focus': show('focus'); return;
      case 'exit': location.href = '/'; return;
      case 'pause':
        state.running = !state.running;
        if (state.running) electLeader(); else resignLeader();
        updateWakeLock(); break;
    }
    render();
  });
  root.addEventListener('input', (ev) => {
    if (ev.target.dataset.a !== 'text') return;
    const c = state.clickers.get(Number(ev.target.dataset.id));
    if (!c) return;
    setDraft(c, ev.target.value);
    patchCard(ev.target.closest('.card'), c);
  });
  document.addEventListener('keydown', (ev) => {
    if (!zoom.hidden && ev.key === 'Escape') { closeZoom(); return; }
    if (!panelOpen || (ev.target.closest && ev.target.closest('input,textarea,[contenteditable]')) || (root.activeElement && root.activeElement.tagName === 'TEXTAREA')) return;
    const c = [...state.clickers.values()].find((x) => isLive(x) && x.type !== 'TEXT');
    if (!c) return;
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

  // ---------------------------------------------------------------- start
  window.__fastClicker = { show, state, CFG, hooks, tick, fullScan, sendVote, version: VERSION };
  if (mode === 'focus') quietEduApp(); else document.body.appendChild(host);
  applyMode();
  startTimers();
  render();
  electLeader();
  sweepSwCache();
})();
