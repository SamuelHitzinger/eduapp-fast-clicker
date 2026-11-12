// ==UserScript==
// @name         EduApp Fast Clicker
// @namespace    https://eduapp.ethz.ch/
// @version      3.0.0
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
//     The relay never sees logins, questions or answers (relay/README.md),
//   * optional diagnostics recorder (off by default; stays on this device until you export it).
(() => {
  'use strict';
  const VERSION = '3.0.0';
  const RELAY_URL = '';     // wss://… of the hint relay; empty = every client checks the feed itself (set by tools/build.js)
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
    feedSmall: 8, feedLarge: 60,
    scanIfFeedSpanH: 6,       // skip the 1.1 MB list at start-up if the 25 newest events reach back this far
    oneTap: false, turbo: false, sound: true, keepAwake: true,
    groupBy: 'date', theme: 'auto', expanded: {}, autoOpen: true,
    shareMinMs: 500, shareMaxMs: 180000,  // sharing: a client's own check is never further apart than shareMaxMs
    soloStepMs: 1000, soloMaxMs: 30000,   // relay unreachable: check alone every (students last seen sharing) x step, at most max
    record: false, recordUntil: 0,
  }, JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
  const saveCfg = () => { try { localStorage.setItem(LS_KEY, JSON.stringify({ oneTap: CFG.oneTap, turbo: CFG.turbo, sound: CFG.sound, keepAwake: CFG.keepAwake, groupBy: CFG.groupBy, theme: CFG.theme, expanded: CFG.expanded, autoOpen: CFG.autoOpen, record: CFG.record, recordUntil: CFG.recordUntil })); } catch {} };
  const hooks = window.__FC_HOOKS || {}; // test seams and the native app's bridge
  const TS = hooks.timeScale || 1;
  // Recording stops by itself after a few days. The iPhone app switches it on once (a first measurement run).
  const REC_DAYS_MS = 4 * 86400e3;
  try {
    if (hooks.recordDefault && !localStorage.getItem('fast-clicker-rec-default')) {
      localStorage.setItem('fast-clicker-rec-default', '1');
      CFG.record = true; CFG.recordUntil = Date.now() + REC_DAYS_MS; saveCfg();
    }
    if (CFG.record && CFG.recordUntil && Date.now() > CFG.recordUntil) { CFG.record = false; saveCfg(); }
  } catch {}

  class AuthError extends Error {}
  class HttpError extends Error { constructor(status, msg, retryAfterMs) { super(msg); this.status = status; this.retryAfterMs = retryAfterMs; } }
  class NetError extends Error {}
  const isTransient = (e) => e instanceof NetError || (e instanceof HttpError && (e.status >= 500 || e.status === 429 || e.status === 408));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms, f = 0.15) => Math.round(ms * (1 - f + Math.random() * 2 * f));

  // ---------------------------------------------------------------- diagnostics recorder (opt-in, stays on this device)
  // Compact timeline of what was asked from EduApp and when it answered, to measure how fast questions can be
  // noticed. No names, logins, question texts or answer texts are recorded.
  const REC_KEY = 'fast-clicker-rec', REC_MAX = 9000;
  const rec = { log: [], dirty: false, last: new Map(), n: 0 };
  try { rec.log = JSON.parse(localStorage.getItem(REC_KEY) || '[]'); if (!Array.isArray(rec.log)) rec.log = []; } catch { rec.log = []; }
  function recAdd(type, data) {
    if (!CFG.record) return;
    rec.log.push(Object.assign({ t: Date.now(), y: type }, data));
    if (rec.log.length > REC_MAX) rec.log.splice(0, rec.log.length - REC_MAX);
    rec.dirty = true;
  }
  const recChanged = (key, value) => { const s = JSON.stringify(value); if (rec.last.get(key) === s) return false; rec.last.set(key, s); return true; };
  function recSave() {
    if (!rec.dirty) return;
    rec.dirty = false;
    try { localStorage.setItem(REC_KEY, JSON.stringify(rec.log)); }
    catch { rec.log.splice(0, Math.ceil(rec.log.length / 3)); rec.dirty = true; }     // storage full: drop the oldest third
  }

  // ---------------------------------------------------------------- network
  const lat = { feed: 1300, detail: 500, vote: 500, other: 400, list: 3000, probe: 400 }; // EWMA of observed latency (ms)
  const minTimeout = { feed: 7000, detail: 7000, vote: 8000, other: 6000, list: 60000, probe: 6000 };
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
      recAdd('r', { k: kind, p: path.split('?')[0], ms: Math.round(performance.now() - t0), e: e && e.name === 'AbortError' ? 'timeout' : 'network' });
      throw new NetError(e && e.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'network error');
    }
    const serverDate = Date.parse(r.headers.get('date') || '');
    if (serverDate) state.serverOffset = serverDate + 500 - Date.now();   // the header has whole seconds
    if (kind !== 'probe' || !r.ok) recAdd('r', { k: kind, p: path.split('?')[0], ms: Math.round(performance.now() - t0), s: r.status, d: serverDate || undefined });
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
    evTurn: new Map(), evBusy: new Set(),       // per question: which feed event is the newest / is being handled
    hold: new Map(),                            // id -> {until, at}: answer retries wait for the feed's word on a possible new round
    lastFeedStartAt: 0, serverOffset: 0,
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
  window.addEventListener('pagehide', (e) => { recSave(); if (!e.persisted && bc) bc.close(); });
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
  const currentLectures = () => {
    const t = Date.now();
    return state.lectures.filter((l) => t >= Date.parse(l.start) - CFG.leadMin * 60e3 && t <= Date.parse(l.end) + CFG.tailMin * 60e3);
  };
  const currentLecture = () => currentLectures()[0];
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
      const sameOpening = !initial && !!prev && !ROUND_KEEP.has(meta.type) && meta.type !== 'GAP' && prev.hintOpenAt > 0
        && (Date.parse(meta.createdAt) || Infinity) <= prev.hintOpenAt + 2000;
      if (prev && meta.type !== 'GAP') prev.hintOpenAt = 0;
      // a (possible) new round: invalidate drafts and in-flight sends now, once per event, before downloading
      if (!initial && prev && !sameOpening && !ROUND_KEEP.has(meta.type) && !state.roundApplied.has(meta.activityId)) {
        prev.gen = (prev.gen || 0) + 1; state.roundApplied.add(meta.activityId); resetRound(id);
        if (meta.type === 'GAP') state.status.set(id, { kind: 'warn', text: 'Connection gap: a new round may have started. Check your answer and send again.' });
      }
      const { detail: c } = await fetchClicker(id);
      if (state.evTurn.get(id) !== turn) return;                 // a newer event for this question took over meanwhile
      if (meta.courseTitle) c.courseTitle = meta.courseTitle;
      if (meta.type !== 'GAP') c.lastEventAt = meta.createdAt ? Math.min(Date.now(), Date.parse(meta.createdAt) || Date.now()) : Date.now();
      if (meta.type === 'CLICKER_STOP_ROUND') c.roundStopped = true;
      else if (meta.type !== 'CLICKER_CLOSE' && meta.type !== 'GAP') c.roundStopped = false;
      const alert = !sameOpening && meta.type !== 'GAP' && c.state === 'OPEN' && !c.roundStopped && (!initial || Date.now() - c.lastEventAt < 3 * 3600e3);
      recAdd('e', { id, e: meta.type, c: meta.createdAt, via: 'feed', initial: initial ? 1 : undefined, state: c.state, alert: alert ? 1 : undefined, same: sameOpening ? 1 : undefined });
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
    let n = initial || gapSuspicious ? CFG.feedLarge : CFG.feedSmall;
    state.lastFeedStartAt = Date.now();
    relay.confirmDue = 0;
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
    if (recChanged('feed', feed.slice(0, 3).map((a) => a.id))) recAdd('f', { n: feed.length, top: feed.slice(0, 4).map((a) => [a.id, a.type, a.objectId, a.createdAt]) });
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
    sendHints(fresh);
    for (const [id, p] of state.pendingRefresh) if (!byClicker.has(id)) byClicker.set(id, p);
    if (gap) for (const c of state.clickers.values()) {
      if (c.state === 'OPEN' && !byClicker.has(c.id)) byClicker.set(c.id, { latest: { type: 'GAP', activityId: `gap-${state.gapCount}-${c.id}` }, ids: [] });
    }
    let authErr = null;
    await Promise.all([...byClicker].map(async ([id, g]) => {
      const ack = () => g.ids.forEach((x) => state.seenActivities.add(x));
      if (initial && g.latest.type === 'CLICKER_CLOSE' && !state.clickers.has(id)) { ack(); return; }
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
    }));
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
    await Promise.all(todo.map(async ([id, courseTitle, known]) => {
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
    }));
    state.scanDone = true;
  }

  // ---------------------------------------------------------------- history list (what EduApp's clicker page shows)
  // EduApp downloads the whole semester (about 1.4 MB compressed) every time its clicker page is opened. Here it is
  // downloaded at most once in a while, never automatically during a lecture, kept on the device, and patched
  // whenever a question is read.
  const LIST_CACHE = 'fast-clicker-data';
  const listCacheKey = () => '/__fast-clicker/list-' + state.semkez;
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
    if (!listCacheTried) { listCacheTried = true; await loadListCache(); }
    const stale = !state.scanDone || state.list.partial || Date.now() - (state.list.fetchedAt || 0) > 12 * 3600e3;
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
  const relay = { ws: null, open: false, rooms: new Map(), want: new Map(), joined: '', retry: 0, retryAt: 0, timer: null, lastMsgAt: 0, offset: 0, hintAt: new Map(), hints: [], queue: [], draining: false, quietUntil: 0, confirms: [], confirmDue: 0, lastN: 1 };
  try { relay.lastN = Math.max(1, Number(localStorage.getItem('fast-clicker-relay-n')) || 1); } catch {}
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
    for (const l of currentLectures()) {
      if (!l.code) continue;
      const room = hash32(`fc1|${state.semkez}|${l.code}`);
      const info = m.get(room) || { code: l.code, titles: new Set(), title: null };
      if (l.title) { for (const k of ['de', 'en']) if (l.title[k]) info.titles.add(l.title[k]); info.title = info.title || l.title.de || l.title.en; }
      m.set(room, info);
      if (m.size >= 8) break;
    }
    return m;
  }
  const relaySend = (msg) => { try { if (relay.open) relay.ws.send(JSON.stringify(msg)); } catch {} };
  function relayJoin() {
    const rooms = [...relay.want.keys()];
    const scout = !document.hidden;
    const sig = rooms.join() + '|' + scout;
    if (sig === relay.joined) return;
    relay.joined = sig;
    for (const r of [...relay.rooms.keys()]) if (!relay.want.has(r)) relay.rooms.delete(r);
    relaySend({ t: 'join', rooms, scout });
  }
  function relayClose() {
    const ws = relay.ws;
    relay.ws = null; relay.open = false; relay.joined = ''; relay.rooms.clear();
    clearTimeout(relay.timer);
    try { if (ws) { ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null; ws.close(); } } catch {}
  }
  function relayRetry() {
    clearTimeout(relay.timer);
    relay.retry++;
    const wait = TS * jitter(Math.min(60000, 1000 * 2 ** Math.min(relay.retry, 6)), 0.3);
    relay.retryAt = Date.now() + wait;
    relay.timer = setTimeout(relaySync, wait + 5);
  }
  function relayConnect() {
    let ws;
    try { ws = new WS(relayUrl); } catch { relayRetry(); return; }
    relay.ws = ws; relay.open = false; relay.joined = ''; relay.lastMsgAt = Date.now();
    ws.onopen = () => {
      if (relay.ws !== ws) return;
      relay.open = true; relay.retry = 0; relay.lastMsgAt = Date.now();
      recAdd('h', { ev: 'open' });
      relayJoin();
    };
    ws.onmessage = (ev) => { if (relay.ws === ws) relayMessage(ev.data); };
    ws.onclose = ws.onerror = () => {
      if (relay.ws !== ws) return;
      relay.ws = null; relay.open = false; relay.rooms.clear();
      recAdd('h', { ev: 'closed' });
      relayRetry();
      if (state.leader && !state.polling) schedule();              // back to checking alone
    };
  }
  function relaySync() {
    if (!relayUrl || !WS) return;
    relay.want = state.leader && state.running && !state.authLost && fastMode() ? wantedRooms() : new Map();
    if (!relay.want.size) { if (relay.ws) relayClose(); return; }
    if (!relay.ws) { if (Date.now() >= relay.retryAt) relayConnect(); return; }
    if (relay.open) relayJoin();
  }
  function relayKeepAlive() {                                   // every 25 s
    if (!relay.ws) return;
    if (Date.now() - relay.lastMsgAt > TS * 70000) {              // silent for too long: start over
      relayClose(); relayRetry();
      if (state.leader && !state.polling) schedule();
      return;
    }
    relaySend({ t: 'ping' });
  }
  function sharedPlan() {                                       // the busiest joined room decides the rhythm
    if (!relay.open) return null;
    let best = null;
    for (const [room, r] of relay.rooms) if (relay.want.has(room) && r.n > 0 && (!best || r.n > best.n)) best = r;
    return best;
  }
  function relayMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    relay.lastMsgAt = Date.now();
    if (typeof m.now === 'number' && Math.abs(m.now - Date.now()) < 86400e3) relay.offset = m.now - Date.now();
    if (m.t === 'roster' && relay.want.has(m.room)) {
      const n = Math.max(0, Math.min(5000, m.n | 0));
      relay.rooms.set(m.room, { n, slot: Math.max(-1, Math.min(n - 1, m.slot | 0)), m: Math.max(0, Math.min(5000, m.m | 0)), every: Math.max(CFG.shareMinMs, Math.min(5000, Number(m.every) || 1000)) });
      if (n > 0 && n !== relay.lastN) { relay.lastN = n; try { localStorage.setItem('fast-clicker-relay-n', String(n)); } catch {} }
      recAdd('h', { ev: 'roster', n, slot: m.slot | 0, m: m.m | 0 });
      if (state.leader && !state.polling && sharedPlan()) schedule();   // move to the (new) slot
      render();
    } else if (m.t === 'hint') onHint(m);
  }
  function sendHints(events) {
    if (!relay.open || !events.length) return;
    for (const ev of events) {
      let room = null;
      for (const [r, info] of relay.want) if (ev.titles && (info.titles.has(ev.titles.de) || info.titles.has(ev.titles.en))) { room = r; break; }
      if (!room || !relay.rooms.has(room)) continue;            // only into the room of the course the event belongs to
      relaySend({ t: 'hint', room, k: ev.k, e: ev.e, a: ev.a, c: String(ev.c || '').slice(0, 32) });
      recAdd('h', { ev: 'sent', k: ev.k, e: ev.e });
    }
  }
  // A hint is only a wake-up call. The relay and the students behind it are not trusted: a hint never marks a feed
  // event as handled, never starts a new round, never changes an answer. It makes this client read that one
  // question from ETH, and what ETH says decides:
  //   * the question is open and was not before  -> show it and alert (this is the fast path for a new question);
  //   * it was open and still is                 -> perhaps a round was stopped or restarted, which only the feed can
  //     tell: check the feed soon (spread out over the hall), and let answer retries wait for that check.
  function onHint(m) {
    const info = relay.want.get(m.room);
    if (!info || !state.leader || !state.running || state.authLost) return;
    if (!Number.isSafeInteger(m.k) || m.k <= 0 || typeof m.e !== 'string' || !/^CLICKER_[A-Z_]{1,24}$/.test(m.e)) return;
    const now = Date.now();
    if (now < relay.quietUntil) return;                          // ETH asked for a pause
    relay.hints = relay.hints.filter((t) => now - t < 60000);
    if (relay.hints.length >= 12 || relay.queue.length >= 4 || now - (relay.hintAt.get(m.k) || 0) < TS * 1500) return;   // flood guard
    relay.hints.push(now); relay.hintAt.set(m.k, now);
    if (relay.hintAt.size > 200) relay.hintAt.clear();
    recAdd('h', { ev: 'hint', k: m.k, e: m.e, c: typeof m.c === 'string' ? m.c.slice(0, 32) : undefined, replay: m.replay ? 1 : undefined });
    const room = relay.rooms.get(m.room);
    const members = (room && room.m) || 0;
    // a full hall does not hit ETH in the same millisecond
    relay.queue.push({ id: m.k, type: m.e, title: info.title, members, at: now + Math.random() * TS * Math.min(300, 3 * members) });
    drainHints();
  }
  async function drainHints() {                                 // one question at a time
    if (relay.draining) return;
    relay.draining = true;
    try {
      while (relay.queue.length) {
        const h = relay.queue.shift();
        if (h.at > Date.now()) await sleep(h.at - Date.now());
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!state.leader || !state.running || state.authLost) break;
          try { await hintRefresh(h); break; } catch (e) {
            if (e instanceof AuthError) { state.authLost = true; relay.queue.length = 0; tryRelogin(); render(); break; }
            if (!isTransient(e)) break;                          // e.g. not this student's question: nothing to do
            if (e.retryAfterMs) { relay.quietUntil = Date.now() + e.retryAfterMs; relay.queue.length = 0; break; }
            if (attempt < 2) await sleep(backoff(attempt + 1));  // after that the own feed check will find it
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
      recAdd('e', { id, e: 'OPEN', via: 'hint', state: c.state, alert: 1 });
      state.dismissed.delete(id);
      patchList(c, true);
      notify(c, true);
      publish(c, true);
    } else {
      publish(c, false);
      if (c.state === 'OPEN' && h.type !== 'CLICKER_OPEN') confirmSoon(id, h.members);
    }
    render();
  }
  function confirmSoon(id, members) {
    const now = Date.now();
    relay.confirms = relay.confirms.filter((t) => now - t < 300000);
    if (relay.confirmDue || relay.confirms.length >= 6) return;  // one at a time, at most 6 in 5 minutes
    relay.confirms.push(now);
    relay.confirmDue = now + Math.random() * TS * Math.min(8000, 25 * members);
    state.hold.set(id, { until: relay.confirmDue + TS * 6000, at: now });
    if (state.leader && !state.polling) schedule();
  }

  // ---------------------------------------------------------------- recorder probes (only while recording)
  // During a lecture, also watch the two cheap signals that might announce a question faster than the feed:
  // the lecture's clicker flags in the timetable, and the content of questions that were open recently.
  async function recProbe() {
    if (!CFG.record || !state.leader || !state.running || state.authLost || document.hidden || !state.semkez || !fastMode() || rec.busy) return;
    if (CFG.recordUntil && Date.now() > CFG.recordUntil) { CFG.record = false; saveCfg(); render(); return; }
    if (state.errorStreak || lat.feed > 2500) return;            // EduApp is struggling: no extra requests
    rec.busy = true;
    try {
      if (rec.n++ % 2 === 0) {
        try {
          const l = await req(`dashboard/upcoming-lectures?start=${encodeURIComponent(nowIso(-4 * 3600e3))}&days=1`, { kind: 'probe', priority: 'low' }) || [];
          const flags = l.map((x) => [x.code, x.type, x.start].concat(['CLICKER', 'FEEDBACK', 'CHANNEL'].map((k) => x.assets && x.assets[k] ? (x.assets[k].available ? 1 : 0) + (x.assets[k].callToAction ? 2 : 0) : -1)));
          if (recChanged('flags', flags)) recAdd('g', { flags });
          else if (rec.n % 24 === 1) recAdd('g', { same: 1 });
        } catch {}
      }
      for (const c of [...state.clickers.values()]) {
        const age = Date.now() - (c.lastEventAt || 0);
        if (!c.lastEventAt || (c.state === 'OPEN' ? age > 20 * 60e3 : age > 3 * 60e3 || rec.n % 4)) continue;
        try {
          const d = await req(`clickers/${c.id}`, { kind: 'probe', priority: 'low' });
          const en = d.entries || [];                            // how many options are selected / have results, never which
          const snap = [d.state, d.answerState && d.answerState !== 'UNANSWERED' ? 1 : 0, d.voteCount, d.showResults ? 1 : 0, en.filter((e) => e.selected).length,
            en.some((e) => e.correct !== undefined) ? 1 : 0, en.map((e) => [e.voteCount, e.voteRatio]), (d.question || '').length, d.individualAnswer ? 1 : 0];
          if (recChanged('c' + c.id, snap)) recAdd('c', { id: c.id, snap });
        } catch {}
      }
    } finally { rec.busy = false; }
  }
  function exportRecording() {
    recSave();
    const text = JSON.stringify({ app: 'fast-clicker', version: VERSION, exportedAt: new Date().toISOString(), ua: navigator.userAgent, semkez: state.semkez,
      lectures: state.lectures.map((l) => ({ code: l.code, type: l.type, start: l.start, end: l.end })), relay: !!relayUrl, entries: rec.log.length, log: rec.log });
    const name = `fast-clicker-diagnostics-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    if (hooks.onShare) { try { hooks.onShare(text, name); } catch {} return; }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } catch { try { navigator.clipboard.writeText(text); } catch {} }
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
    if (ms === undefined) {
      const fast = fastMode();
      const sp = fast && !state.authLost && !state.errorStreak && lat.feed <= 2500 ? sharedPlan() : null;
      if (sp) {
        // Shared discovery: the relay gave every checking client of this lecture a slot; together they ask the feed
        // about once per `every` ms, each one only every n-th time. Hints from the others arrive through the relay.
        const period = Math.min(Math.max(CFG.shareMaxMs, CFG.cadenceMs), Math.max(CFG.cadenceMs, sp.n * sp.every));
        if (sp.slot >= 0 && !document.hidden) {
          const now = Date.now() + relay.offset;
          let wait = (Math.round(sp.slot * period / sp.n) - (now % period) + 2 * period) % period;
          const gap = state.lastFeedStartAt + CFG.cadenceMs - Date.now();        // never sooner than the normal rhythm after the last check…
          if (wait < gap - 0.15 * CFG.cadenceMs) wait += period * Math.ceil((gap - wait) / period);
          const late = state.lastFeedStartAt + 1.5 * period - Date.now();          // …and whatever the relay says, never much later than one round
          ms = state.lastFeedStartAt ? Math.min(wait, Math.max(0, late)) : wait;
        } else ms = jitter(Math.min(60000, Math.max(CFG.hiddenCadenceMs, period)));          // not checking for others: slow safety check
      } else {
        let cadence = !fast ? CFG.idleCadenceMs : document.hidden ? CFG.hiddenCadenceMs : CFG.cadenceMs;
        // relay configured but unreachable: check alone, but the more students were sharing, the slower (ETH load)
        if (fast && relayUrl && relay.want.size && !relay.open) cadence = Math.max(cadence, Math.min(CFG.soloMaxMs, relay.lastN * CFG.soloStepMs));
        if (lat.feed > 2500) cadence = Math.max(cadence, Math.round(lat.feed * 3)); // server slower than usual: back off
        if (state.authLost) cadence = state.loginNeeded ? CFG.loginCadenceMs : CFG.authCadenceMs;
        else if (state.errorStreak) cadence = Math.max(state.retryAfterMs, Math.min(CFG.maxBackoffMs, 2000 * 2 ** (state.errorStreak - 1)), Math.min(cadence, 8000));
        ms = Math.max(0, jitter(cadence) - (Date.now() - startedAt));
      }
      if (relay.confirmDue) {                                    // a hint asked for the feed's word on a round change
        const gap = state.lastFeedStartAt + 0.85 * CFG.cadenceMs - Date.now();
        ms = Math.min(ms, Math.max(0, relay.confirmDue - Date.now(), gap));
      }
    }
    state.timer = setTimeout(tick, ms);
  }
  const pokeNow = () => { if (state.leader && !state.polling) schedule(0); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pokeNow(); updateWakeLock(); relaySync(); recSave(); });
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
          const hold = attempt > 0 && state.hold.get(id);        // a retry (not a fresh tap) waits for the feed's word on a possible new round
          if (hold && Date.now() < hold.until) { await sleep(Math.max(40, TS * 250)); continue; }
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
    recAdd('a', { id: c.id });
    if (hooks.onAlert) {                 // native app shell: it plays sound, vibrates and notifies
      try { hooks.onAlert({ id: c.id, title: c.title || '', course: c.courseTitle || '' }); } catch {}
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
      try { new Notification('Clicker open: ' + (c.title || ''), { body: c.courseTitle || 'EduApp', tag: 'fast-clicker-' + c.id }); } catch {}
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
    document.title = 'Fast Clicker · EduApp';
    if (!document.querySelector('meta[name=viewport]')) {
      const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width,initial-scale=1,viewport-fit=cover'; document.head.appendChild(m);
    }
    document.documentElement.style.cssText = `background:${window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? '#1d1f23' : '#fff'}`;
    document.body.style.cssText = 'margin:0';
  }
  const myTimers = { stat: null, sweep: null, recheck: null, rec: null, probe: null, relay: null };
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
    myTimers.rec = setInterval(recSave, 10000);
    myTimers.probe = setInterval(recProbe, Math.max(100, 2500 * TS));
    myTimers.relay = setInterval(relayKeepAlive, Math.max(100, 25000 * TS));
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
  const ui = { view: 'list', id: null, group: [], pending: null, menu: false, err: null, loading: false };
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
    .bar{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;min-height:56px;padding:0 8px 0 16px;background:rgb(var(--sf));border-bottom:2px solid rgba(var(--on),var(--bo))}
    .bar b{font-size:20px;font-weight:500;letter-spacing:.0125em}
    .dot{width:10px;height:10px;border-radius:50%;background:#2a9d8f;flex:none}
    .dot.slow{background:#999}.dot.err{background:#c1121f}.dot.warn{background:#e9a100}
    .grow{flex:1;min-width:0}
    #stat{font-size:12px;line-height:1.3;color:rgba(var(--on),var(--med));text-align:right;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .recdot{font-size:11px;font-weight:700;color:#c1121f;animation:pulse 1.6s infinite}
    .tabs{display:flex;padding:10px 8px 0;background:rgb(var(--sl))}
    .tab{height:48px;padding:0 16px}
    .tab.on{background:rgb(var(--bg))}
    .pad{padding:16px}
    .empty{font-size:14px;line-height:1.45;color:rgba(var(--on),var(--med));padding:12px 16px 0}
    .empty b{color:rgba(var(--on),var(--hi))}
    .note{background:#fefce8;color:#854d0e;border-left:4px solid #facc15;padding:12px 16px;font-size:14px;line-height:1.43;margin:8px 16px}
    :host(.dark) .note{background:#3a3212;color:#fde68a}
    .note.gray{background:rgba(var(--on),.08);color:inherit;border-color:rgba(var(--on),.45)}
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
    .sheet{position:fixed;inset:0;z-index:9;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.45)}
    .sheetin{width:100%;max-width:768px;max-height:85vh;overflow:auto;background:rgb(var(--sf));border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom))}
    .sheetin h3{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(var(--on),var(--med));margin:14px 0 8px}
    .sheetin h3:first-child{margin-top:0}
    .foot{font-size:12px;line-height:1.4;color:rgba(var(--on),var(--med));margin-top:14px}
  `;
  root.innerHTML = `<style>${css}</style>
    <button class="fab" data-a="open"></button>
    <div class="app">
      <div class="bar"><b>Clicker</b><span class="dot"></span><span class="grow" id="stat"></span><span class="recdot" hidden>REC</span><button class="iconbtn x" data-a="min" title="Minimize">–</button><button class="iconbtn" data-a="menu" title="Settings" aria-label="Settings">${icon('dots')}</button></div>
      <div id="banner"></div>
      <div id="listview">
        <div class="tabs"><button class="tab" data-a="grp" data-g="date">${L.byDate}</button><button class="tab" data-a="grp" data-g="lecture">${L.byLecture}</button></div>
        <div id="empty" class="empty"></div>
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
      <div class="sheet" id="sheet" hidden><div class="sheetin" id="menu"></div></div>
      <div class="zoom" hidden></div>
    </div>`;
  const $ = (sel) => root.querySelector(sel);
  const el = { fab: $('.fab'), app: $('.app'), dot: $('.dot'), stat: $('#stat'), recdot: $('.recdot'), banner: $('#banner'), empty: $('#empty'), list: $('#list'), listview: $('#listview'),
    detailview: $('#detailview'), dtitle: $('#dtitle'), dmsg: $('#dmsg'), cards: $('#cards'), gnav: $('#gnav'), sheet: $('#sheet'), menu: $('#menu') };
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
    const q = x.question || '';
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
    const cl = currentLecture(), nl = nextLecture();
    const title = (l) => esc(tr(l.title) || l.code);
    setHtml(el.empty, cl ? `Watching closely: <b>${title(cl)}</b> (until ${fmtTime(cl.end)}). A new question opens here by itself.`
      : nl ? `Next lecture: <b>${title(nl)}</b> at ${fmtTime(nl.start)}. Fast checking starts ${CFG.leadMin} min before.`
        : 'No lecture right now. Keep this open: a new question still shows up within a minute.');
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
    return JSON.stringify([c.gen, c.title, c.courseTitle, c.type, c.question, c.roundStopped,
      c.type === 'TEXT' ? c.individualAnswer : c.entries.map((e) => [e.id, e.answer, e.selected, cur.includes(e.id)])]);
  }
  const kindText = (c) => c.type === 'MCMA' ? L.many : c.type === 'MCSA' ? L.one : L.text;
  function buildCard(c) {
    const div = document.createElement('div');
    div.className = 'card'; div.dataset.id = c.id;
    let h = `<h3 class="sr-only">${esc(c.title)}</h3><div class="course">${c.courseTitle ? esc(c.courseTitle) + ' · ' : ''}${kindText(c)}</div>`;
    if (c.roundStopped) h += `<div class="note gray" style="margin:0 0 12px">The lecturer stopped this round. You'll be alerted when the next round starts.</div>`;
    h += `<div class="q">${c.question || ''}</div>`;
    if (c.type === 'TEXT') {
      h += `<textarea data-a="text" data-id="${c.id}" placeholder="${esc(L.yourAnswer)}">${esc(currentAnswer(c))}</textarea>`;
    } else {
      const cur = currentAnswer(c);
      h += `<div class="${c.type === 'MCSA' ? 'radio' : 'check'}">`;
      for (const e of c.entries) {
        h += `<button class="opt ${cur.includes(e.id) ? 'sel' : ''} ${e.selected ? 'server' : ''}" data-a="pick" data-id="${c.id}" data-e="${e.id}" role="${c.type === 'MCSA' ? 'radio' : 'checkbox'}" aria-checked="${cur.includes(e.id)}"><span class="box"></span><span class="grow">${e.answer || ''}</span></button>`;
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
    let h = `<h3 class="sr-only">${esc(c.title)}</h3><div class="q">${c.question || ''}</div>`;
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
        h += `<li class="${e.selected ? 'sel' : ''}"><span class="box"></span><div class="w"><div class="ans">${e.answer || ''}</div>${r}</div></li>`;
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
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
    else if (!c) msg = `${item && item.question ? `<div class="q">${item.question}</div>` : ''}<div class="more"><div class="spin"></div></div>`;
    setHtml(el.dmsg, msg);
    const i = ui.group.indexOf(ui.id), n = ui.group.length;
    setHtml(el.gnav, n > 1 ? `${i > 0 ? `<button class="iconbtn prev" data-a="nav" data-d="-1" aria-label="${esc(L.prev)}">${icon('chevron')}</button>` : '<span></span>'}<p>${i + 1} / ${n}</p>${i < n - 1 ? `<button class="iconbtn next" data-a="nav" data-d="1" aria-label="${esc(L.next)}">${icon('chevron')}</button>` : '<span></span>'}` : '');
    el.gnav.hidden = n <= 1;
  }
  function renderMenu() {
    const sp = sharedPlan();
    const share = !relayUrl ? '' : sp ? `Checking is shared with ${sp.n} ${sp.n === 1 ? 'device' : 'devices'} in this lecture.` : relay.want.size ? 'Shared checking is not connected. Checking alone.' : 'Shared checking starts with your next lecture.';
    const chip = (a, on, text, title) => `<button class="chip ${on ? 'on' : ''}" data-a="${a}"${title ? ` title="${esc(title)}"` : ''}>${text}</button>`;
    setHtml(el.menu, `
      <h3>Answering</h3><div class="row2" style="margin:0">
        ${chip('onetap', CFG.oneTap, '1-tap send', 'One-answer questions: tapping an option sends it immediately')}
        ${chip('autoopen', CFG.autoOpen, 'Open new questions by themselves')}
        ${chip('sound', CFG.sound, 'Sound')}
        ${mode === 'focus' ? chip('awake', CFG.keepAwake, 'Screen on', 'Keep the screen on around lectures') : ''}
        ${'Notification' in window && Notification.permission === 'default' ? chip('notif', false, 'Notifications') : ''}
      </div>
      <h3>Checking</h3><div class="row2" style="margin:0">
        ${chip('turbo', CFG.turbo, 'Always fast', 'Check fast even outside your timetable (e.g. exercise sessions)')}
        ${chip('now', false, 'Check now')}
        ${chip('scan', false, 'Refresh list', 'Download the full clicker list again (about 1 MB)')}
        ${chip('pause', false, state.running ? 'Pause' : 'Resume')}
      </div>
      <h3>Display</h3><div class="row2" style="margin:0">
        ${chip('theme', CFG.theme !== 'auto', 'Theme: ' + CFG.theme)}
        ${mode === 'focus' ? (hooks.noExit ? '' : chip('exit', false, 'Back to EduApp')) : chip('focus', false, 'Focus mode', 'Full screen, stops EduApp\'s own background downloads')}
      </div>
      <h3>Diagnostics</h3><div class="row2" style="margin:0">
        ${chip('record', CFG.record, 'Record timing', 'Keeps a timeline of requests on this device, to measure how fast questions arrive. Stops by itself after 4 days.')}
        ${CFG.record || rec.log.length ? chip('share', false, `Export (${rec.log.length})`) + chip('recclear', false, 'Clear') : ''}
      </div>
      <div class="foot">${share ? share + '<br>' : ''}v${VERSION} · unofficial · reads questions and sends your answers only to eduapp.ethz.ch${relayUrl ? '; the sharing service only learns that a question changed' : ''}.</div>
      <div class="sendrow"><button class="send" data-a="closemenu">Done</button></div>`);
    el.sheet.hidden = !ui.menu;
  }

  function render() {
    if (pointerDown || composing) { renderPending = true; return; }
    renderPending = false;
    const live = [...state.clickers.values()].filter(isLive);
    const alerting = live.some((c) => !c.roundStopped);
    el.fab.style.display = panelOpen ? 'none' : '';
    el.app.style.display = panelOpen ? '' : 'none';
    el.fab.className = 'fab' + (alerting ? ' alert' : '');
    el.fab.textContent = live.length ? `Clicker open (${live.length})` : 'Clicker';
    $('.x').style.display = mode === 'focus' ? 'none' : '';
    el.dot.className = 'dot ' + (state.authLost ? 'warn' : state.lastError ? 'err' : fastMode() ? '' : 'slow');
    el.recdot.hidden = !CFG.record;
    let banner = '';
    if (state.authLost && state.loginNeeded) banner = `<div class="note">Your EduApp login expired. <button class="chip big" data-a="login">Log in</button><br>Opens the ETH login. Come back here afterwards. Answers you've chosen are kept.</div>`;
    else if (state.authLost) banner = `<div class="note">${esc(bannerOverride || 'Login expired. Renewing…')}</div>`;
    else if (state.lastError) banner = `<div class="note">Connection problem: ${esc(state.lastError)}. Retrying automatically.</div>`;
    if (CFG.sound && !hooks.nativeAlerts && (!audioCtx || audioCtx.state !== 'running')) banner += `<div class="note gray">Tap anywhere in this panel once to enable the alert sound.</div>`;
    const pend = ui.pending != null ? state.clickers.get(ui.pending) : null;
    if (pend && pend.state === 'OPEN' && !(ui.view === 'detail' && ui.id === pend.id)) banner += `<div class="note">New question: <b>${esc(pend.title)}</b> <button class="chip big" data-a="view" data-id="${pend.id}">Show</button></div>`;
    else ui.pending = null;
    if (CFG.record && fastMode()) banner += `<div class="note gray">Recording timing. When you see the lecturer open or restart a question: <button class="chip" data-a="mark">Mark now</button>${rec.marked && Date.now() - rec.marked < 4000 ? ' ✓ marked' : ''}</div>`;
    setHtml(el.banner, banner);
    if (ui.view === 'detail' && ui.id != null && state.dismissed.has(ui.id)) { ui.view = 'list'; ui.id = null; }
    const detail = ui.view === 'detail';
    el.listview.hidden = detail; el.detailview.hidden = !detail;
    if (!detail) renderList();
    renderCards(live);
    if (detail) renderDetail();
    renderMenu();
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
    if (ev.target === el.sheet) { ui.menu = false; render(); return; }
    const b = ev.target.closest('[data-a]');
    if (!b) return;
    const id = b.dataset.id ? Number(b.dataset.id) : null;
    const c = id != null ? state.clickers.get(id) : null;
    switch (b.dataset.a) {
      case 'open': panelOpen = true; break;
      case 'min': panelOpen = false; break;
      case 'menu': ui.menu = true; break;
      case 'closemenu': ui.menu = false; break;
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
      case 'turbo': CFG.turbo = !CFG.turbo; saveCfg(); pokeNow(); break;
      case 'onetap': CFG.oneTap = !CFG.oneTap; saveCfg(); break;
      case 'autoopen': CFG.autoOpen = !CFG.autoOpen; saveCfg(); break;
      case 'sound': CFG.sound = !CFG.sound; saveCfg(); unlockAudio(); break;
      case 'awake': CFG.keepAwake = !CFG.keepAwake; saveCfg(); updateWakeLock(); break;
      case 'theme': CFG.theme = CFG.theme === 'auto' ? 'dark' : CFG.theme === 'dark' ? 'light' : 'auto'; saveCfg(); applyMode(); break;
      case 'now': pokeNow(); break;
      case 'scan': state.listError = null; startScan(); break;
      case 'notif': Notification.requestPermission().then(render); return;
      case 'login': openLogin(); break;
      case 'focus': ui.menu = false; show('focus'); return;
      case 'exit': location.href = '/'; return;
      case 'record': CFG.record = !CFG.record; CFG.recordUntil = CFG.record ? Date.now() + REC_DAYS_MS : 0; saveCfg(); if (CFG.record) recAdd('s', { ev: 'start', v: VERSION }); recSave(); break;
      case 'mark': recAdd('m', {}); rec.marked = Date.now(); recSave(); setTimeout(render, 4100); break;
      case 'share': exportRecording(); break;
      case 'recclear': rec.log = []; rec.last.clear(); rec.dirty = true; recSave(); break;
      case 'pause':
        state.running = !state.running;
        if (state.running) electLeader(); else { resignLeader(); relaySync(); }
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
    if (ui.menu && ev.key === 'Escape') { ui.menu = false; render(); return; }
    if (!panelOpen || ui.menu || !zoom.hidden || ui.view !== 'detail' || (ev.target.closest && ev.target.closest('input,textarea,[contenteditable]')) || (root.activeElement && root.activeElement.tagName === 'TEXTAREA')) return;
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

  // ---------------------------------------------------------------- start
  window.__fastClicker = { show, state, CFG, hooks, tick, fullScan, sendVote, relay, rec, ui, openDetail, version: VERSION };
  if (mode === 'focus') quietEduApp(); else document.body.appendChild(host);
  applyMode();
  startTimers();
  render();
  electLeader();
  sweepSwCache();
  setTimeout(ensureFonts, 1500);
})();
