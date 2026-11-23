// v3 tests: EduApp-style list and question pages, shared discovery through the relay, the v3.2 simple screen.
// Mock server + jsdom, a fake WebSocket instead of the relay. Run: node tools/test-v3.js
const { makeServer, boot, fakeCaches, mcsa, st, until, wait } = require('./harness');
const results = [];
const check = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);

function fakeRelay() {
  const R = { sockets: [], fail: false };
  R.WebSocket = class {
    constructor(url) {
      if (R.fail) throw new Error('relay unreachable');
      this.url = url; this.sent = []; this.closed = false;
      R.sockets.push(this);
      setTimeout(() => { if (!this.closed && this.onopen) this.onopen(); }, 3);
    }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { if (this.closed) return; this.closed = true; if (this.onclose) this.onclose(); }
    push(msg) { if (!this.closed && this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }   // relay → client
  };
  R.last = () => R.sockets.filter((s) => !s.closed).at(-1);
  R.joined = () => { const s = R.last(); return s && s.sent.filter((m) => m.t === 'join').at(-1); };
  return R;
}
const closedWithResults = (id) => ({ id, type: 'MCSA', state: 'CLOSED', title: 'Old question', question: '<p>Past?</p>', answerState: 'CORRECT', showResults: true, preview: false, voteCount: 10,
  entries: [{ id: 1, answer: 'no', selected: false, correct: false, voteCount: 3, voteRatio: 30 }, { id: 2, answer: 'yes', selected: true, correct: true, voteCount: 7, voteRatio: 70 }] });
const feedPolls = (S) => S.log.filter((l) => l.startsWith('GET dashboard/activity-feed')).length;

(async () => {
  // ---------- L: list and question pages
  {
    const S = makeServer(); const { root, fc, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    check('L1 start-up shows the list page with the open question in it, without downloading the semester list',
      !root.getElementById('listview').hidden && !!root.querySelector('.row[data-id="322454"] .pill') && !S.log.some((l) => l.startsWith('GET clickers?')));
    check('L2 the earlier questions are offered, not downloaded during a lecture', !!root.querySelector('#list [data-a="scan"]'));
    root.querySelector('#list [data-a="scan"]').click();
    await until(() => root.querySelectorAll('.row').length > 50);
    const rows = root.querySelectorAll('.row').length;
    check('L3 the semester list shows up grouped by date, like EduApp', rows > 50 && root.querySelectorAll('.dg .ct').length > 5 && S.log.filter((l) => l.startsWith('GET clickers?')).length === 1, `rows=${rows}`);
    check('L4 each question shows its status icon and a one-line preview', root.querySelectorAll('.row .rs svg').length === rows && root.querySelectorAll('.row .qs').length === rows);
    root.querySelector('.tab[data-g="lecture"]').click();
    check('L5 "By Lecture" shows one coloured, collapsible group per course', await until(() => root.querySelectorAll('.lg .gh').length === 2) && /Clicker/.test(root.querySelector('.gs').textContent));
    const closedGroup = [...root.querySelectorAll('.gh')].find((b) => b.getAttribute('aria-expanded') === 'false');
    const before = root.querySelectorAll('.row').length;
    closedGroup.click();
    check('L6 a group opens on tap and stays open', await until(() => root.querySelectorAll('.row').length > before) && Object.values(fc.CFG.expanded).includes(true));
    root.querySelector('.tab[data-g="date"]').click();
    await until(() => root.querySelector('.dg'));
    // a closed question from the list: its page is read fresh and shows the results
    S.addClicker(closedWithResults(322453));
    root.querySelector('.row[data-id="322453"]').click();
    check('L7 tapping a past question opens its page with results', await until(() => root.querySelector('.card.closed[data-id="322453"] .fill')) && !root.getElementById('detailview').hidden
      && /Old question \(closed\)/.test(root.getElementById('dtitle').textContent) && /70% \/ 7 votes/.test(root.querySelector('.card[data-id="322453"]').textContent));
    check('L8 the results page marks the right answer and the student\'s own choice', !!root.querySelector('.card[data-id="322453"] .you.ok') && !!root.querySelector('.card[data-id="322453"] .v-ok') && /correct/.test(root.querySelector('.summary').textContent));
    check('L9 previous/next moves within the same lecture group', /\/ 2/.test(root.getElementById('gnav').textContent) && !!root.querySelector('#gnav [data-a="nav"]'));
    root.querySelector('#gnav [data-a="nav"]').click();
    check('L10 next question page opens', await until(() => fc.ui.id === 322454 && !root.querySelector('.card[data-id="322454"]').hidden));
    root.querySelector('[data-a="back"]').click();
    check('L11 back returns to the list', !root.getElementById('listview').hidden && root.getElementById('detailview').hidden);
    // a new question opens: its page comes up by itself
    S.addClicker(mcsa(810001, 'Fresh')); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 810001, courseTitle: { de: 'Analysis I' } });
    check('L12 a newly opened question comes on screen by itself', await until(() => fc.ui.view === 'detail' && fc.ui.id === 810001 && root.querySelector('.card[data-id="810001"]') && !root.querySelector('.card[data-id="810001"]').hidden));
    root.querySelector('.opt[data-id="810001"][data-e="2"]').click();          // answer in progress (chosen, not sent)
    S.addClicker(mcsa(810002, 'Second')); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 810002, courseTitle: { de: 'Analysis I' } });
    await until(() => root.querySelector('.card[data-id="810002"]'));
    check('L13 another question opening does not pull the student away from an answer in progress', fc.ui.id === 810001 && !!root.querySelector('#banner [data-a="view"][data-id="810002"]'));
    root.querySelector('.send[data-id="810001"]').click();
    check('L14 the answer still goes through and is confirmed', await until(() => /Confirmed/.test(st(root, 810001))) && S.votes.some((v) => v.id === 810001 && v.body.selectedAnswer[0] === 2));
    root.querySelector('#banner [data-a="view"][data-id="810002"]').click();
    check('L15 "Show" opens the other question', fc.ui.id === 810002 && !root.querySelector('#banner [data-a="view"]'));
    root.querySelector('[data-a="back"]').click();
    check('L16 questions opened since the list was loaded are filed under today and their course', !!root.querySelector('.row[data-id="810001"]') && !!root.querySelector('.row[data-id="810002"]')
      && root.querySelector('.row[data-id="810001"]').closest('.co').querySelector('.ct').textContent.includes('Analysis I'));
    stop();
  }
  {
    // outside lectures the list loads by itself once
    const S = makeServer({ lectureNow: false }); const { root, stop } = boot(S);
    check('L17 outside lectures the list is loaded automatically, once', await until(() => root.querySelectorAll('.row').length > 50) && (await wait(400), S.log.filter((l) => l.startsWith('GET clickers?')).length === 1));
    stop();
  }

  // ---------- R: shared discovery through the relay
  {
    const S = makeServer(); const R = fakeRelay(); const alerts = [];
    const { root, fc, stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket, onAlert: (q) => alerts.push(q.id), nativeAlerts: true }, settings: { shareMinMs: 10 } });
    check('R1 around a lecture the client joins one room for the course, as a checking client', await until(() => R.joined()) && R.joined().rooms.length === 1 && /^[0-9a-f]{32}$/.test(R.joined().rooms[0]) && R.joined().scout === true && R.sockets[0].url === 'wss://relay.test/v1/room/' + R.joined().rooms[0]);
    const room = R.joined().rooms[0];
    check('R2 the room name does not contain the course number', !room.includes('401') && !JSON.stringify(R.last().sent).includes('0261'));
    // 10 clients share: this one polls only every 10th slot
    R.last().push({ t: 'roster', room, n: 10, slot: 3, m: 10, every: 40, now: Date.now() });
    await wait(150);
    const p0 = feedPolls(S); await wait(1250); const shared = feedPolls(S) - p0;
    check('R3 with 10 clients sharing, this client asks the feed about a tenth as often', shared >= 2 && shared <= 5, `${shared} feed requests in 1.25 s (alone: about 10)`);
    // a hint from another client: the question is read from ETH directly, no feed request needed
    S.addClicker(mcsa(820001, 'Hinted'));
    const createdAt = new Date().toISOString();
    const before = feedPolls(S);
    R.last().push({ t: 'hint', room, k: 820001, e: 'CLICKER_OPEN', a: 555001, c: createdAt, now: Date.now() });
    const shown = await until(() => root.querySelector('.card[data-id="820001"]'), 1500);
    check('R4 a hint puts the question on screen without waiting for the own feed check', shown && fc.ui.id === 820001 && feedPolls(S) - before <= 1 && S.log.includes('GET clickers/820001'));
    check('R5 the hint alerted once', alerts.filter((x) => x === 820001).length === 1, JSON.stringify(alerts));
    // the same event later shows up in the own feed (even under another activity id): no second alert, no new round
    const gen = fc.state.clickers.get(820001).gen;
    S.feed.unshift({ id: 999001, createdAt, objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 820001, courseTitle: { de: 'Analysis I' } });
    await wait(700);
    check('R6 the same event arriving later through the feed is not handled twice', alerts.filter((x) => x === 820001).length === 1 && fc.state.clickers.get(820001).gen === gen);
    // this client's own feed check finds an event: it tells the room
    S.addClicker(mcsa(820002, 'Found here'));
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 820002, courseTitle: { de: 'Analysis I', en: 'Analysis I' } });
    const told = await until(() => R.last().sent.some((m) => m.t === 'hint' && m.k === 820002), 2500);
    const hint = R.last().sent.find((m) => m.t === 'hint' && m.k === 820002);
    check('R7 an event found by the own check is passed on as a hint (ids and time only)', told && hint.room === room && hint.e === 'CLICKER_OPEN' && Number.isInteger(hint.a) && Object.keys(hint).sort().join() === 'a,c,e,k,room,t');
    // events of other courses are not passed on
    S.addClicker(mcsa(820003, 'Other course'));
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 820003, courseTitle: { de: 'Lineare Algebra I' } });
    await until(() => root.querySelector('.card[data-id="820003"]'), 2500);
    check('R8 an event of another course is not sent into this course\'s room', !!root.querySelector('.card[data-id="820003"]') && !R.last().sent.some((m) => m.t === 'hint' && m.k === 820003));
    // junk and foreign hints are ignored
    const reads = S.log.filter((l) => l.startsWith('GET clickers/')).length;
    R.last().push({ t: 'hint', room: 'f'.repeat(32), k: 322453, e: 'CLICKER_OPEN', a: 1, c: createdAt });
    R.last().push({ t: 'hint', room, k: 'x', e: 'CLICKER_OPEN', a: 2, c: createdAt });
    R.last().push({ t: 'hint', room, k: 322453, e: 'open; drop', a: 3, c: createdAt });
    R.last().push('not an object');
    await wait(300);
    check('R9 hints for other rooms or with junk in them cause no request', S.log.filter((l) => l.startsWith('GET clickers/')).length === reads);
    // a hint for a question ETH does not show to this student: dropped quietly
    R.last().push({ t: 'hint', room, k: 777777, e: 'CLICKER_OPEN', a: 555777, c: createdAt });
    await wait(300);
    check('R10 a hint for a question ETH refuses is dropped without an error', !root.querySelector('.card[data-id="777777"]') && !fc.state.lastError);
    // a "new round" hint alone changes nothing: it only makes the client re-read the question (the relay is untrusted)
    fc.openDetail(820001);
    root.querySelector('.opt[data-id="820001"][data-e="2"]').click();
    root.querySelector('.send[data-id="820001"]').click();
    await until(() => /Confirmed/.test(st(root, 820001)));
    const reads0 = S.log.filter((l) => l === 'GET clickers/820001').length;
    R.last().push({ t: 'hint', room, k: 820001, e: 'CLICKER_START_ROUND', a: 555002, c: new Date().toISOString() });
    await until(() => S.log.filter((l) => l === 'GET clickers/820001').length > reads0, 1500);
    await wait(300);
    check('R11 a "new round" hint alone does not clear the answer or alert (only ETH\'s feed can say so)',
      fc.state.clickers.get(820001).gen === gen && /Confirmed/.test(st(root, 820001)) && alerts.filter((x) => x === 820001).length === 1);
    // the real round change, seen in the feed, does reset it and alerts again
    S.clickers.get(820001).entries.forEach((e) => { e.selected = false; });
    S.push({ objectType: 'CLICKER', type: 'CLICKER_START_ROUND', objectId: 820001, courseTitle: { de: 'Analysis I' } });
    check('R11b the round change from the feed clears the previous answer and alerts again',
      await until(() => fc.state.clickers.get(820001).gen === gen + 1 && !root.querySelector('.opt.sel[data-id="820001"]') && alerts.filter((x) => x === 820001).length === 2, 3000));
    stop();
  }
  {
    // relay configured but unreachable: check alone, slower the more students were sharing last time
    const S = makeServer(); const R = fakeRelay(); R.fail = true;
    const { root, w, stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket }, settings: { soloStepMs: 100, soloMaxMs: 2000 } });
    w.localStorage.setItem('fast-clicker-relay-n', '6');
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(830001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 830001 });
    check('R12 without the relay a new question is still found by the own check', await until(() => root.querySelector('.card[data-id="830001"]'), 3000));
    stop();
  }
  {
    const S = makeServer(); const R = fakeRelay(); R.fail = true;
    const { w, fc, stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket }, settings: { soloStepMs: 100, soloMaxMs: 2000 } });
    fc.relay.lastN = 6;
    await wait(400);
    const p0 = feedPolls(S); await wait(1300); const n = feedPolls(S) - p0;
    check('R13 without the relay, a client that last shared with 6 checks about every 6 steps instead of every step', n >= 1 && n <= 4, `${n} feed requests in 1.3 s`);
    void w; stop();
  }
  {
    // relay drops: the client reconnects and re-joins
    const S = makeServer(); const R = fakeRelay();
    const { stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket, timeScale: 0.02 } });
    await until(() => R.joined());
    const first = R.last();
    first.close();
    check('R14 after the relay connection drops the client reconnects and joins again', await until(() => R.last() && R.last() !== first && R.joined(), 4000));
    stop();
  }
  {
    // outside lectures: no relay connection at all
    const S = makeServer({ lectureNow: false }); const R = fakeRelay();
    const { stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket } });
    await wait(600);
    check('R15 outside lectures the relay is not contacted', R.sockets.length === 0);
    stop();
  }
  {
    // no relay configured: nothing changes
    const S = makeServer(); const R = fakeRelay();
    const { root, stop } = boot(S, { hooks: { WebSocket: R.WebSocket } });
    await until(() => root.querySelector('.card[data-id="322454"]'));
    await wait(300);
    check('R16 with no relay configured no connection is made', R.sockets.length === 0);
    stop();
  }

  // ---------- S: what a hostile relay (or a student sending crafted hints) can and cannot do
  {
    const S = makeServer(); const R = fakeRelay(); const alerts = [];
    const { root, fc, stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket, onAlert: (q) => alerts.push(q.id), nativeAlerts: true }, settings: { shareMinMs: 10 } });
    await until(() => R.joined());
    const room = R.joined().rooms[0];
    S.addClicker(mcsa(850001, 'Real')); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 850001, courseTitle: { de: 'Analysis I' } });
    await until(() => root.querySelector('.card[data-id="850001"]'));
    root.querySelector('.opt[data-id="850001"][data-e="2"]').click();
    root.querySelector('.send[data-id="850001"]').click();
    await until(() => /Confirmed/.test(st(root, 850001)));
    const gen = fc.state.clickers.get(850001).gen;
    // the attacker knows the activity id the next real round will get and attaches it to a question that does not exist
    const nextId = 991234;
    R.last().push({ t: 'hint', room, k: 777001, e: 'CLICKER_START_ROUND', a: nextId, c: new Date().toISOString() });
    await wait(200);
    S.clickers.get(850001).entries.forEach((e) => { e.selected = false; });
    S.feed.unshift({ id: nextId, createdAt: new Date().toISOString(), objectType: 'CLICKER', type: 'CLICKER_START_ROUND', objectId: 850001, courseTitle: { de: 'Analysis I' } });
    check('S1 a hint cannot hide a real round change from this client (activity ids from the relay are not trusted)',
      await until(() => fc.state.clickers.get(850001).gen === gen + 1 && !root.querySelector('.opt.sel[data-id="850001"]'), 3000),
      `gen ${gen}→${fc.state.clickers.get(850001).gen}, selected shown: ${!!root.querySelector('.opt.sel[data-id="850001"]')}, ui ${fc.ui.view}/${fc.ui.id}`);
    // forged hints in quantity: bounded reads, no votes, nothing else
    const votes0 = S.votes.length, reads0 = S.log.filter((l) => l.startsWith('GET clickers/')).length;
    for (let i = 0; i < 60; i++) R.last().push({ t: 'hint', room, k: 860000 + i, e: 'CLICKER_OPEN', a: 870000 + i, c: new Date().toISOString() });
    await wait(1500);
    const reads = S.log.filter((l) => l.startsWith('GET clickers/')).length - reads0;
    check('S2 a flood of forged hints causes only a few question reads and never a vote', reads <= 12 && S.votes.length === votes0, `${reads} reads`);
    stop();
  }
  {
    // ETH says "slow down" while handling a hint: the client waits as long as it is told
    const S = makeServer(); const R = fakeRelay();
    const { w, stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket }, settings: { shareMinMs: 10 } });
    await until(() => R.joined());
    const room = R.joined().rooms[0];
    const real = w.fetch; let hits = 0;
    w.fetch = async (url, opts) => {
      if (/clickers\/880001(\?|$)/.test(String(url))) {
        hits++;
        return { ok: false, status: 429, type: 'basic', headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '60' : null) }, text: async () => '' };
      }
      return real(url, opts);
    };
    R.last().push({ t: 'hint', room, k: 880001, e: 'CLICKER_OPEN', a: 1, c: new Date().toISOString() });
    await wait(2500);
    R.last().push({ t: 'hint', room, k: 880001, e: 'CLICKER_OPEN', a: 2, c: new Date().toISOString() });
    await wait(500);
    check('S3 "429, retry after 60 s" on a hinted question: no retries, and further hints wait too', hits === 1, `${hits} requests`);
    stop();
  }
  {
    // the relay hands out absurd plans: the client keeps its own minimum spacing and its own deadline
    const S = makeServer(); const R = fakeRelay();
    const { w, stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket }, settings: { cadenceMs: 400, shareMinMs: 10, shareMaxMs: 600 } });
    await until(() => R.joined());
    const room = R.joined().rooms[0];
    const real = w.fetch; const at = [];
    w.fetch = (url, opts) => { if (String(url).includes('activity-feed')) at.push(Date.now()); return real(url, opts); };
    const t0 = Date.now();
    const spam = setInterval(() => R.last() && R.last().push({ t: 'roster', room, n: 2 + Math.floor(Math.random() * 3), slot: Math.floor(Math.random() * 2), m: 5, every: 10, now: Date.now() }), 37);
    await wait(2000);
    clearInterval(spam);
    const gaps = at.filter((t) => t > t0).map((t, i, a) => (i ? t - a[i - 1] : null)).filter((x) => x !== null);
    check('S4 roster messages cannot make the client check the feed faster than its own rhythm', gaps.length >= 2 && Math.min(...gaps) >= 0.8 * 400, `gaps ${gaps.join(',')}`);
    R.last().push({ t: 'roster', room, n: 5000, slot: 4999, m: 5000, every: 5000, now: Date.now() });
    const t1 = Date.now(); await wait(2000);
    const after = at.filter((t) => t > t1).length;
    check('S5 a plan that would postpone checking for days still checks within the local deadline', after >= 1, `${after} checks in 2 s (deadline about 0.9 s)`);
    stop();
  }
  {
    // keyboard shortcuts only ever act on the question that is on screen
    const S = makeServer(); const { root, w, fc, stop } = boot(S, { settings: { oneTap: true } });
    S.addClicker(mcsa(890001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 890001 });
    await until(() => fc.ui.id === 890001);
    root.querySelector('[data-a="back"]').click();
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('2'); key('Enter');
    await wait(300);
    check('S6 on the list page, number keys and Enter send nothing', S.votes.length === 0 && !fc.state.draft.has(890001));
    fc.openDetail(890001);
    key('2');
    check('S8 on the question page, number keys still work', await until(() => S.votes.some((v) => v.id === 890001 && v.body.selectedAnswer[0] === 2)));
    stop();
  }
  {
    // start-up in a lecture with a busy feed: the 1.4 MB semester list is still not downloaded automatically
    const S = makeServer();
    const now = Date.now();
    S.feed = Array.from({ length: 70 }, (_, i) => ({ id: 960000 - i, createdAt: new Date(now - i * 60e3).toISOString(), objectType: 'CHANNEL', type: 'CHANNEL_COMMENT_CREATE', objectId: 1, itemId: i }));
    const { stop } = boot(S);
    await wait(1200);
    check('S9 during a lecture the semester list is never downloaded automatically, even when the feed cannot vouch for it', !S.log.some((l) => l.startsWith('GET clickers?')), S.log.filter((l) => l.startsWith('GET clickers?')).join());
    stop();
  }
  {
    // a newer semester list wins over an older copy of a closed question
    const S = makeServer({ lectureNow: false }); const { root, fc, stop } = boot(S);
    await until(() => root.querySelectorAll('.row').length > 50);
    S.addClicker(closedWithResults(322453));
    fc.openDetail(322453);
    await until(() => root.querySelector('.card.closed[data-id="322453"]'));
    root.querySelector('[data-a="back"]').click();
    for (const g of S.list.byCourse) for (const x of g.clickers) if (x.id === 322453) x.answerState = 'WRONG';
    for (const d of S.list.byDate) for (const co of d.courses) for (const x of co.clickers) if (x.id === 322453) x.answerState = 'WRONG';
    S.clickers.get(322453).answerState = 'WRONG';
    await wait(20);
    await fc.fullScan();
    const icon = await until(() => { const ic = root.querySelector('.row[data-id="322453"] .rs svg'); return ic && ic.classList.contains('c-bad'); }, 1500) && root.querySelector('.row[data-id="322453"] .rs svg');
    check('S10 a newer list is not overwritten by an older copy of a closed question', !!icon && icon.classList.contains('c-bad'), icon && icon.getAttribute('class'));
    stop();
  }

  // ---------- Q: round safety with the relay (second review)
  const relayClient = async (opts = {}) => {
    const S = makeServer(); const R = fakeRelay(); const alerts = [];
    const b = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket, onAlert: (q) => alerts.push(q.id), nativeAlerts: true }, settings: { shareMinMs: 10, ...(opts.settings || {}) } });
    await until(() => R.joined());
    return { S, R, alerts, room: R.joined().rooms[0], ...b };
  };
  const failing = (w, test, response) => {        // make matching requests fail until .off()
    const real = w.fetch; let on = true; const ctl = { hits: 0, off() { on = false; } };
    w.fetch = async (url, opts) => {
      if (on && test(String(url), opts || {})) { ctl.hits++; return response(); }
      return real(url, opts);
    };
    return ctl;
  };
  const resp = (status, headers = {}) => ({ ok: false, status, type: 'basic', headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => '' });
  const votesIn = (S, id, round) => S.votes.filter((v) => v.id === id && (round === undefined || v.round === round));
  {
    // a hint brings an open question; the answer's POST fails; within a second the lecturer restarts the round
    const { S, R, root, fc, room, stop } = await relayClient();
    S.addClicker(mcsa(910001, 'Quick restart'));
    R.last().push({ t: 'hint', room, k: 910001, e: 'CLICKER_OPEN', a: 1, c: new Date().toISOString() });
    await until(() => fc.ui.id === 910001 && root.querySelector('.opt[data-id="910001"]'));
    S.failVotes = 3;
    root.querySelector('.opt[data-id="910001"][data-e="2"]').click();
    root.querySelector('.send[data-id="910001"]').click();
    await until(() => /trying|Weak|Sending/.test(st(root, 910001)), 1500);
    const c = S.clickers.get(910001); c.round = 1; c.entries.forEach((e) => { e.selected = false; });
    S.push({ objectType: 'CLICKER', type: 'CLICKER_START_ROUND', objectId: 910001, courseTitle: { de: 'Analysis I' } });
    await wait(3500);
    check('Q1 a round restart right after a hint-opened question is a new round: the old answer is not retried into it',
      votesIn(S, 910001, 1).length === 0 && fc.state.clickers.get(910001).gen >= 1, `round-1 votes ${votesIn(S, 910001, 1).length}, gen ${fc.state.clickers.get(910001).gen}, status "${st(root, 910001)}"`);
    stop();
  }
  {
    // "maybe a new round" hint while a retry is pending, and the feed keeps failing: the retry must not go out
    const { S, R, root, w, fc, room, stop } = await relayClient();
    S.addClicker(mcsa(920001, 'Held')); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 920001, courseTitle: { de: 'Analysis I' } });
    await until(() => root.querySelector('.opt[data-id="920001"]'));
    S.failVotes = 1000;
    root.querySelector('.opt[data-id="920001"][data-e="2"]').click();
    root.querySelector('.send[data-id="920001"]').click();
    await until(() => /trying|Weak/.test(st(root, 920001)), 2000);
    R.last().push({ t: 'hint', room, k: 920001, e: 'CLICKER_START_ROUND', a: 2, c: new Date().toISOString() });
    await until(() => fc.state.hold.has(920001), 2000);
    const feedDown = failing(w, (u) => u.includes('activity-feed'), () => resp(503));
    const c = S.clickers.get(920001); c.round = 1; c.entries.forEach((e) => { e.selected = false; });
    S.failVotes = 0;
    await wait(2500);
    check('Q2 while the feed cannot be reached, a retry under a "maybe new round" hold is not sent', votesIn(S, 920001).length === 0 && fc.state.hold.has(920001) && /new round/.test(st(root, 920001)), `votes ${votesIn(S, 920001).length}, status "${st(root, 920001)}"`);
    feedDown.off();
    S.push({ objectType: 'CLICKER', type: 'CLICKER_START_ROUND', objectId: 920001, courseTitle: { de: 'Analysis I' } });
    await until(() => fc.state.clickers.get(920001).gen >= 1, 3000);
    await wait(800);
    check('Q3 once the feed confirms the new round, the old answer is dropped instead of sent', votesIn(S, 920001).length === 0 && !fc.state.hold.has(920001), `votes ${votesIn(S, 920001).length}`);
    stop();
  }
  {
    // the automatic repair after verification also waits for the hold
    const { S, R, root, w, fc, room, stop } = await relayClient();
    S.addClicker(mcsa(930001, 'Repair')); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 930001, courseTitle: { de: 'Analysis I' } });
    await until(() => root.querySelector('.opt[data-id="930001"]'));
    root.querySelector('.opt[data-id="930001"][data-e="2"]').click();
    root.querySelector('.send[data-id="930001"]').click();
    await until(() => /Confirmed/.test(st(root, 930001)));
    R.last().push({ t: 'hint', room, k: 930001, e: 'CLICKER_START_ROUND', a: 3, c: new Date().toISOString() });
    await until(() => fc.state.hold.has(930001), 2000);
    failing(w, (u) => u.includes('activity-feed'), () => resp(503));
    const before = votesIn(S, 930001).length;
    fc.sendVote(930001, { repair: 1 });
    await wait(1500);
    check('Q4 an automatic repair does not post while a "maybe new round" hold is on', votesIn(S, 930001).length === before);
    stop();
  }
  {
    // a hint opened the question; the feed's own "opened" event comes, but reading the question fails once
    const { S, R, root, fc, room, alerts, stop } = await relayClient();
    S.addClicker(mcsa(940001, 'Flaky read'));
    R.last().push({ t: 'hint', room, k: 940001, e: 'CLICKER_OPEN', a: 4, c: new Date().toISOString() });
    await until(() => fc.ui.id === 940001 && root.querySelector('.opt[data-id="940001"]'));
    root.querySelector('.opt[data-id="940001"][data-e="3"]').click();               // chosen, not sent yet
    S.failDetail.set(940001, 1);
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 940001, courseTitle: { de: 'Analysis I' } });
    await until(() => S.failDetail.get(940001) === 0, 2000);
    await wait(800);
    check('Q5 a failed read while confirming the same opening does not turn it into a second round',
      fc.state.clickers.get(940001).gen === 0 && !!root.querySelector('.opt.sel[data-id="940001"][data-e="3"]') && alerts.filter((x) => x === 940001).length === 1,
      `gen ${fc.state.clickers.get(940001).gen}, alerts ${alerts.filter((x) => x === 940001).length}`);
    stop();
  }
  {
    // feed errors while the relay keeps sending roster updates: checking resumes anyway
    const { S, R, w, room, stop } = await relayClient({ settings: { cadenceMs: 300 } });
    const at = []; const real = w.fetch; let down = true;
    w.fetch = async (url, opts) => {
      if (String(url).includes('activity-feed')) { at.push(Date.now()); if (down) return resp(503); }
      return real(url, opts);
    };
    const spam = setInterval(() => R.last() && R.last().push({ t: 'roster', room, n: 3, slot: Math.floor(Math.random() * 3), m: 3, every: 100, now: Date.now() }), 37);
    await wait(700); down = false;
    const t1 = Date.now(); await wait(2000);
    clearInterval(spam);
    const after = at.filter((t) => t > t1).length;
    check('Q6 relay messages cannot keep postponing the feed check after an error', after >= 2, `${after} checks in 2 s after the errors stopped`);
    stop();
  }
  {
    // ETH asks for a pause (Retry-After, as seconds on the feed, as a date on a question): everything waits
    const { S, R, w, root, room, stop } = await relayClient({ settings: { cadenceMs: 200 } });
    S.addClicker(mcsa(950001, 'Paused')); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 950001, courseTitle: { de: 'Analysis I' } });
    await until(() => root.querySelector('.card[data-id="950001"]'), 3000);
    const at = []; const real = w.fetch; let first = true;
    w.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('activity-feed')) { at.push(Date.now()); if (first) { first = false; return resp(429, { 'retry-after': '2' }); } }
      return real(url, opts);
    };
    await until(() => !first, 2000);
    const t429 = at[0], reads0 = S.log.filter((l) => l === 'GET clickers/950001').length;
    R.last().push({ t: 'hint', room, k: 950001, e: 'CLICKER_START_ROUND', a: 5, c: new Date().toISOString() });
    await wait(2600);
    const next = at.find((t) => t > t429);
    check('Q7 after "Retry-After: 2" on the feed, neither feed checks nor hint reads happen for 2 s',
      !!next && next - t429 >= 1950 && S.log.filter((l) => l === 'GET clickers/950001').length === reads0,
      `next feed after ${next ? next - t429 : 'none'} ms; reads ${reads0}→${S.log.filter((l) => l === 'GET clickers/950001').length}; log tail ${S.log.slice(-6).join(' | ')}`);
    stop();
  }
  {
    const { R, w, room, stop } = await relayClient();
    const ctl = failing(w, (u) => /clickers\/960001(\?|$)/.test(u), () => resp(503, { 'retry-after': new Date(Date.now() + 60000).toUTCString() }));
    R.last().push({ t: 'hint', room, k: 960001, e: 'CLICKER_OPEN', a: 6, c: new Date().toISOString() });
    await wait(1500);
    check('Q8 a Retry-After given as a date is honoured too', ctl.hits === 1, `${ctl.hits} requests`);
    stop();
  }
  {
    // retries count against the hint budget: at most 12 question reads a minute caused by hints
    const { R, w, room, stop } = await relayClient();
    const ctl = failing(w, (u) => /clickers\/97\d{4}(\?|$)/.test(u), () => resp(503));
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 4; i++) R.last().push({ t: 'hint', room, k: 970000 + round * 10 + i, e: 'CLICKER_OPEN', a: 100 + round * 10 + i, c: new Date().toISOString() });
      await wait(1800);
    }
    check('Q9 failing hint reads and their retries stay within 12 requests a minute', ctl.hits <= 12 && ctl.hits >= 4, `${ctl.hits} requests`);
    stop();
  }

  // ---------- O: an overloaded EduApp during the lecture (everyone reloading the 1.4 MB list at once)
  const slowFeed = (w, ms) => {                    // every feed answer takes `ms`; an aborted request is really aborted
    const real = w.fetch;
    w.fetch = (url, opts = {}) => !String(url).includes('activity-feed') ? real(url, opts) : new Promise((res, rej) => {
      const t = setTimeout(() => res(real(url, opts)), ms);
      if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    });
  };
  {
    // every answer from the feed takes longer than the first time limit (here 70 ms stands for 7 s, 200 ms for 20 s)
    const S = makeServer(); const { root, w, fc, stop } = boot(S, { hooks: { timeScale: 0.01 } });
    slowFeed(w, 200);
    S.addClicker(mcsa(980001, 'Overloaded')); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 980001, courseTitle: { de: 'Analysis I' } });
    check('O1 when EduApp answers slower than the time limit, the limit grows and the question still comes through',
      await until(() => root.querySelector('.card[data-id="980001"]'), 4000), `last error: ${fc.state.lastError}`);
    stop();
  }
  {
    // the feed fails many times in a row during a lecture, then recovers: the next check is not minutes away
    const S = makeServer(); const { root, w, stop } = boot(S, { settings: { maxBackoffMs: 30000, lectureBackoffMs: 250 } });
    await until(() => root.querySelector('.card[data-id="322454"]'));
    const real = w.fetch; let fails = 0;
    w.fetch = async (url, opts) => {
      if (String(url).includes('activity-feed') && fails < 8) { fails++; return { ok: false, status: 503, type: 'basic', headers: { get: () => null }, text: async () => '' }; }
      return real(url, opts);
    };
    await until(() => fails >= 8, 6000);
    S.addClicker(mcsa(980002, 'After the storm')); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 980002, courseTitle: { de: 'Analysis I' } });
    check('O2 after 8 failures in a row during a lecture, checking continues at most a few seconds apart (here 0.25 s)',
      fails >= 8 && await until(() => root.querySelector('.card[data-id="980002"]'), 1500), `${fails} failures`);
    stop();
  }
  {
    // EduApp's own app would show a stale saved list after 10 s; this client's requests can never be answered from a cache
    const S = makeServer(); const { root, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    const gets = S.urls.filter((u) => u.startsWith('/web/gw/') && !u.includes('/vote'));
    check('O3 every request is unique (so no cache, including EduApp\'s service worker, can answer it with old data)',
      gets.length > 3 && gets.every((u) => /[?&]_fc=/.test(u)) && new Set(gets).size === gets.length);
    stop();
  }

  // ---------- M: questions that ran while the app was closed
  {
    const listKey = '/__fast-clicker/list-' ;
    const saved = (S, ageMs) => { const C = fakeCaches(); C.store.set(listKey + '2026W', JSON.stringify({ ...JSON.parse(JSON.stringify(S.list)), fetchedAt: Date.now() - ageMs })); return C; };
    const missed = (S, id, title) => {
      S.addClicker({ ...closedWithResults(id), title });
      S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: id, courseTitle: { de: 'Analysis I' } });
      S.push({ objectType: 'CLICKER', type: 'CLICKER_CLOSE', objectId: id, courseTitle: { de: 'Analysis I' } });
    };
    const reads = (S, id) => S.log.filter((l) => l === `GET clickers/${id}`).length;
    {
      // during a lecture: the saved list is shown, and the question that opened and closed meanwhile is added to it
      const S = makeServer(); const C = saved(S, 3600e3); const alerts = [];
      missed(S, 820001, 'Missed while closed');
      const { root, fc, stop } = boot(S, { caches: C, hooks: { onAlert: (q) => alerts.push(q.id), nativeAlerts: true } });
      const shown = await until(() => root.querySelector('.row[data-id="820001"]'));
      await wait(300);
      check('M1 a question that opened and closed while the app was closed appears in the list on the next start', shown && !fc.state.list.partial
        && root.querySelector('.row[data-id="820001"]').closest('.co').querySelector('.ct').textContent.includes('Analysis I'));
      check('M2 it is read once, not announced as new, and the semester list is not downloaded during the lecture',
        reads(S, 820001) === 1 && !alerts.includes(820001) && fc.ui.id !== 820001 && !S.log.some((l) => l.startsWith('GET clickers?')));
      check('M3 questions the saved list already has as closed are not read again', reads(S, 322453) === 0 && reads(S, 322458) === 0);
      root.querySelector('.row[data-id="820001"]').click();
      check('M4 its page shows the result', await until(() => root.querySelector('.card.closed[data-id="820001"] .fill')));
      stop();
    }
    {
      // very first start, no saved list, during a lecture: today's missed question is still added (older ones wait for the list)
      const S = makeServer(); missed(S, 820002, 'Missed, first start');
      const { root, stop } = boot(S, { caches: fakeCaches() });
      check('M7 with no saved list yet, a question from earlier today still shows up, without the semester download',
        await until(() => root.querySelector('.row[data-id="820002"]')) && reads(S, 322453) === 0 && !S.log.some((l) => l.startsWith('GET clickers?')));
      stop();
    }
    {
      // the app was closed so long that the feed no longer reaches back to the saved list: outside lectures the list is reloaded
      const S = makeServer({ lectureNow: false }); const C = saved(S, 3 * 3600e3);
      for (let i = 0; i < 70; i++) S.push({ objectType: 'DOCUMENT', type: 'DOCUMENT_NEW', objectId: 1 });
      const { stop } = boot(S, { caches: C, settings: { feedLarge: 60 } });
      check('M5 a saved list older than what the feed still shows is downloaded again outside lectures', await until(() => S.log.some((l) => l.startsWith('GET clickers?'))));
      stop();
    }
    {
      // the same during a lecture: no 1.4 MB download, the saved list stays
      const S = makeServer(); const C = saved(S, 3 * 3600e3);
      for (let i = 0; i < 70; i++) S.push({ objectType: 'DOCUMENT', type: 'DOCUMENT_NEW', objectId: 1 });
      const { root, fc, stop } = boot(S, { caches: C, settings: { feedLarge: 60 } });
      await until(() => root.querySelectorAll('.row').length > 50);
      await wait(400);
      check('M6 …but never during a lecture', !S.log.some((l) => l.startsWith('GET clickers?')) && !fc.state.list.partial);
      stop();
    }
  }

  // ---------- S: start-up on a weak connection: the first feed check waits for nothing it does not need
  {
    const S = makeServer();
    const { w, fc, stop } = boot(S);
    await until(() => fc.state.lastPollAt > 0);
    const saved = JSON.parse(w.localStorage.getItem('fast-clicker-semkez') || 'null');
    check('S1 the first start asks for the semester and remembers it', S.log[0] === 'GET semesters/current' && !!saved && saved.k === '2026W');
    stop();
  }
  {
    const S = makeServer();
    const { fc, stop } = boot(S, { preset: { 'fast-clicker-semkez': JSON.stringify({ k: '2026W', at: Date.now() - 86400e3 }) } });
    await until(() => fc.state.lastPollAt > 0 && S.log.includes('GET semesters/current'));
    const iFeed = S.log.findIndex((l) => l.startsWith('GET dashboard/activity-feed'));
    const iLec = S.log.findIndex((l) => l.startsWith('GET dashboard/upcoming-lectures'));
    const iSem = S.log.indexOf('GET semesters/current');
    check('S2 later starts check the feed at once: the timetable loads alongside, the semester is confirmed afterwards',
      iFeed >= 0 && iFeed <= 1 && iLec >= 0 && iLec <= 1 && iSem > iFeed, S.log.slice(0, 5).join(' | '));
    stop();
  }
  {
    const S = makeServer();
    const { fc, stop } = boot(S, { preset: { 'fast-clicker-semkez': JSON.stringify({ k: '2026S', at: Date.now() }) } });
    const ok = await until(() => fc.state.semkez === '2026W' && S.log.some((l) => l.includes('activity-feed?semkez=2026W')));
    check('S3 a remembered semester that has ended is replaced right after the first check', ok, S.log.slice(0, 6).join(' | '));
    stop();
  }
  {
    // too old to trust: ask first, as on the very first start
    const S = makeServer();
    const { fc, stop } = boot(S, { preset: { 'fast-clicker-semkez': JSON.stringify({ k: '2026W', at: Date.now() - 40 * 86400e3 }) } });
    await until(() => fc.state.lastPollAt > 0);
    check('S4 a semester remembered more than a month ago is asked for again first', S.log[0] === 'GET semesters/current');
    stop();
  }

  // ---------- V: a restarted round (peer instruction: vote, discuss, vote again) cannot be missed
  {
    const S = makeServer(); const alerts = [];
    const { root, fc, stop } = boot(S, { hooks: { onAlert: (q) => alerts.push(q), nativeAlerts: true } });
    await until(() => fc.state.lastPollAt > 0);
    S.addClicker(mcsa(860001, 'Two rounds'));
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 860001, courseTitle: { de: 'Analysis I' } });
    await until(() => root.querySelector('.opt[data-id="860001"]'));
    const banner = () => !!root.querySelector('.card[data-id="860001"] .note.round');
    const none1 = !banner();
    root.querySelector('.opt[data-id="860001"][data-e="2"]').click();
    root.querySelector('.send[data-id="860001"]').click();
    await until(() => S.votes.length === 1 && /Confirmed/.test(st(root, 860001)));
    S.push({ objectType: 'CLICKER', type: 'CLICKER_STOP_ROUND', objectId: 860001, courseTitle: { de: 'Analysis I' } });
    await until(() => fc.state.clickers.get(860001).roundStopped);
    const none2 = !banner();
    S.clickers.get(860001).round = 1;
    S.push({ objectType: 'CLICKER', type: 'CLICKER_START_ROUND', objectId: 860001, courseTitle: { de: 'Analysis I' } });
    const shown = await until(banner);
    check('V1 after a restart the question says "New round: vote again" (not in round 1, not while stopped)', none1 && none2 && shown, [none1, none2, shown].join());
    check('V2 the alert for the restart tells the app it is a new round', alerts.length >= 2 && alerts[0].round === false && alerts[alerts.length - 1].round === true,
      JSON.stringify(alerts.map((a) => a.round)));
    root.querySelector('.opt[data-id="860001"][data-e="3"]').click();
    root.querySelector('.send[data-id="860001"]').click();
    const gone = await until(() => !banner() && votesIn(S, 860001, 1).length === 1);
    check("V3 once this round's answer is in, the note goes away", gone);
    stop();
  }
  {
    // pulling down in the iPhone app = "check now": no restart, the feed is asked right away
    const S = makeServer();
    const { fc, stop } = boot(S, { settings: { cadenceMs: 6000, idleCadenceMs: 6000 } });
    await until(() => fc.state.lastPollAt > 0);
    const feeds = () => S.log.filter((l) => l.includes('activity-feed')).length;
    const n = feeds();
    const t0 = fc.state.lastFeedStartAt;
    fc.checkNow();                                       // right after a check: waits for the 4 s floor
    await wait(1000);
    const early = feeds() > n;
    const asked = await until(() => feeds() > n, 5000);
    const gap = Date.now() - t0;
    check('V4 "check now" asks the feed as soon as allowed: not within 4 s of the last check, well before the normal 6 s', !early && asked && gap >= 3900 && gap < 5500, `after ${gap} ms`);
    stop();
  }
  // ---------- R+: one relay connection per room (v3.3)
  {
    const S = makeServer(); const R = fakeRelay();
    const now = Date.now();
    S.lectures.push({ code: '252-0027-00', title: { en: 'Einführung in die Programmierung' }, start: new Date(now + 5 * 60e3).toISOString(), end: new Date(now + 125 * 60e3).toISOString() });
    S.lectures.push({ code: '401-0151-00', title: { en: 'Lineare Algebra' }, start: new Date(now + 8 * 60e3).toISOString(), end: new Date(now + 128 * 60e3).toISOString() });
    const { fc, stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1/', WebSocket: R.WebSocket }, settings: { shareMinMs: 10 } });
    await until(() => R.sockets.filter((x) => !x.closed && x.sent.some((m) => m.t === 'join')).length >= 2, 4000);
    await wait(300);
    const open = R.sockets.filter((x) => !x.closed);
    const rooms = open.map((x) => x.sent.find((m) => m.t === 'join').rooms);
    check('R17 at a lecture changeover the client is in at most two rooms, one connection each, bound to its room',
      open.length === 2 && rooms.every((r, i) => r.length === 1 && open[i].url === 'wss://relay.test/v1/room/' + r[0]) && rooms[0][0] !== rooms[1][0],
      open.map((x) => x.url).join(' '));
    const [a, b] = open; const ra = rooms[0][0], rb = rooms[1][0];
    b.push({ t: 'roster', room: ra, n: 3, slot: 1, m: 3, every: 1000, now: Date.now() });   // another room's news on this socket
    await wait(100);
    check('R18 a connection only accepts news about its own room', !fc.relay.rooms.has(ra));
    a.push({ t: 'roster', room: ra, n: 2, slot: 0, m: 2, every: 1000, now: Date.now() });
    await wait(50);
    const off = fc.relay.offset;
    a.push({ t: 'hint', room: ra, k: 999001, e: 'CLICKER_CLOSE', a: 1, c: new Date().toISOString(), now: Date.now() - 3600e3, replay: true });
    await wait(100);
    check("R19 a replayed hint (stamped when it was first sent) does not change the relay clock", Math.abs(fc.relay.offset - off) < 1000, `${off} -> ${fc.relay.offset}`);
    stop();
  }
  {
    // standing by in a big room: the own safety checks get rarer the more students share (ETH load stays flat)
    const count = async (m) => {
      const S = makeServer(); const R = fakeRelay();
      const { stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket },
        settings: { cadenceMs: 100, hiddenCadenceMs: 50, shareMinMs: 10, standbyPerMemberMs: 2, standbyMinMs: 100, standbyMaxMs: 5000 } });
      await until(() => R.joined());
      const room = R.joined().rooms[0];
      R.last().push({ t: 'roster', room, n: 60, slot: -1, m, every: 1000, now: Date.now() });
      await wait(200);
      const n0 = feedPolls(S);
      await wait(1500);
      const n = feedPolls(S) - n0;
      stop();
      return n;
    };
    const small = await count(20), big = await count(2000);
    check('R20 standing by, a client checks on its own less often in a big room (60 scouts share the work)', small >= 5 && big <= 1, `room of 20: ${small} checks, room of 2000: ${big} in 1.5 s`);
  }

  {
    // standing by in a big room, a "round changed?" hint holds automatic re-sends but sends nobody to the feed early
    const S = makeServer(); const R = fakeRelay();
    const { fc, stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket }, settings: { cadenceMs: 100, shareMinMs: 10 } });
    await until(() => R.joined());
    const room = R.joined().rooms[0];
    R.last().push({ t: 'roster', room, n: 60, slot: -1, m: 2000, every: 1000, now: Date.now() });
    await wait(300);
    S.addClicker(mcsa(990001, 'Big room'));
    R.last().push({ t: 'hint', room, k: 990001, e: 'CLICKER_OPEN', a: 41, c: new Date().toISOString() });
    await until(() => fc.state.clickers.get(990001), 4000);
    await wait(1600);                                    // (hints about the same question are at least 1.5 s apart)
    const n0 = feedPolls(S);
    R.last().push({ t: 'hint', room, k: 990001, e: 'CLICKER_START_ROUND', a: 42, c: new Date().toISOString() });
    await until(() => fc.state.hold.has(990001), 4000);
    await wait(1500);
    check('R21 standing by in a big room, a round-change hint holds re-sends but brings no feed check forward',
      fc.state.hold.has(990001) && !fc.relay.confirmDue && feedPolls(S) === n0, `feed checks +${feedPolls(S) - n0}`);
    stop();
  }

  // ---------- X: safety before a wider release (v3.4)
  {
    // question and answer HTML from ETH is cleaned: formatting, formulas and pictures stay; anything active goes
    const S = makeServer();
    const evil = { ...mcsa(980001, 'Evil'),
      question: '<p>Q <b>bold</b> <script>window.__pwn=1</script><img src="x" onerror="window.__pwn=2"><svg onload="window.__pwn=3" width="2ex" height="1ex"><path d="M0 0"/><use href="#m1"/><use href="https://evil.example/x.svg#a"/></svg>'
        + '<a href="javascript:window.__pwn=4">link</a><a href="https://ethz.ch">ok</a><iframe src="https://evil.example"></iframe><img src="https://evil.example/t.png"><img src="data:image/png;base64,iVBORw0KGgo=">'
        + '<form action="https://evil.example"><input name="p"></form><div style="background:url(https://evil.example/t)">x</div><math><mi>x</mi></math></p>',
      entries: [{ id: 1, answer: '<img src=x onerror="window.__pwn=5">A', selected: false }, { id: 2, answer: '<b>B</b>', selected: false }] };
    S.addClicker(evil);
    const { root, w, stop } = boot(S);
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 980001, courseTitle: { de: 'Analysis I' } });
    await until(() => root.querySelector('.card[data-id="980001"] .q'));
    await wait(300);
    const card = root.querySelector('.card[data-id="980001"]');
    const html = card.innerHTML;
    const kept = !!card.querySelector('.q b') && !!card.querySelector('.q svg path') && !!card.querySelector('.q use[href="#m1"]') && !!card.querySelector('.q math mi')
      && !!card.querySelector('.q img[src^="data:image/png"]') && !!card.querySelector('.q a[href="https://ethz.ch"][rel~="noopener"]') && !!card.querySelector('.opt b');
    const gone = !/<script|onerror|onload|javascript:|<iframe|<form|<input|evil\.example/i.test(html);
    check('X1 question HTML is cleaned: formatting, formulas, data pictures and safe links stay; scripts, handlers, frames, forms, outside links/pictures go',
      kept && gone && w.__pwn === undefined, `kept ${kept}, gone ${gone}, pwn ${w.__pwn}`);
    stop();
  }
  {
    // hints: an id ETH refuses is never read again because of a hint, and hints cause at most a few reads a minute
    const S = makeServer(); const R = fakeRelay();
    const { fc, stop } = boot(S, { hooks: { relayUrl: 'wss://relay.test/v1', WebSocket: R.WebSocket }, settings: { shareMinMs: 10 } });
    await until(() => R.joined());
    const room = R.joined().rooms[0];
    R.last().push({ t: 'roster', room, n: 2, slot: 0, m: 2, every: 1000, now: Date.now() });
    S.forbid.add(990777);
    const reads = () => S.log.filter((l) => l === 'GET clickers/990777').length;
    R.last().push({ t: 'hint', room, k: 990777, e: 'CLICKER_OPEN', a: 1, c: new Date().toISOString() });
    await until(() => reads() === 1, 3000);
    await wait(1700);
    R.last().push({ t: 'hint', room, k: 990777, e: 'CLICKER_OPEN', a: 2, c: new Date().toISOString() });
    await wait(800);
    const r1 = reads();
    for (let i = 0; i < 20; i++) R.last().push({ t: 'hint', room, k: 991000 + i, e: 'CLICKER_OPEN', a: 100 + i, c: new Date().toISOString() });
    await wait(1500);
    const other = S.log.filter((l) => /^GET clickers\/991\d{3}$/.test(l)).length;
    check('X2 a question ETH refused is not read again for a hint; a flood of hints causes at most 4 reads a minute', r1 === 1 && other <= 3, `refused id read ${r1}x, flood reads ${other}`);
    stop();
  }
  {
    // the app left open on screen outside lectures slows down after a while without a touch
    const S = makeServer({ lectureNow: false });
    const { w, fc, stop } = boot(S, { mode: 'focus', settings: { cadenceMs: 100, idleCadenceMs: 5000, onScreenFastMs: 400 } });
    await until(() => fc.state.lastPollAt > 0);
    await wait(700);                                   // no touches: fast pace over
    const n0 = feedPolls(S);
    await wait(800);
    const idle = feedPolls(S) - n0;
    w.dispatchEvent(new w.Event('pointerdown'));       // a touch: fast again
    await wait(100);
    fc.checkNow();
    const n1 = feedPolls(S);
    await wait(350);
    const used = feedPolls(S) - n1;
    check('X3 open on screen but untouched outside lectures, the app falls back to the slow pace; a touch makes it fast again', idle === 0 && used >= 2, `idle ${idle}, after touch ${used}`);
    stop();
  }
  {
    // a burst of activity never makes two feed requests in a row without the normal spacing
    const S = makeServer();
    const { fc, stop } = boot(S, { settings: { cadenceMs: 400 } });
    await until(() => fc.state.lastPollAt > 0);
    await wait(500);
    for (let i = 0; i < 12; i++) S.push({ objectType: 'CHANNEL', type: 'CHANNEL_COMMENT_CREATE', objectId: 1, itemId: 5000 + i });
    const t0 = Date.now();
    await wait(1500);
    const times = S.reqs.filter((u) => u.t > t0 && u.p.includes('activity-feed')).map((u) => u.t);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    check('X4 after a burst of activity, the wider feed request waits for the normal spacing', times.length >= 2 && gaps.every((g) => g >= 300), JSON.stringify(gaps));
    stop();
  }

  // ---------- E: ETH Clicker (v3.2): one simple screen, no settings drawer, no timing experiment
  {
    const S = makeServer();
    const { root, w, stop } = boot(S, { mode: 'focus', hooks: { nativeAlerts: true, noExit: true } });
    await until(() => root.querySelector('.card[data-id="322454"]'));
    await wait(500);
    const bar = root.querySelector('header.bar');
    check('E1 the app is called Clicker and has no menu or settings drawer', /^\s*Clicker\s*$/.test(bar.querySelector('h1').textContent)
      && !root.querySelector('[data-a="menu"], #drawer, .drawer, #menu, [data-a="record"], [data-a="turbo"], [data-a="onetap"], [data-a="pause"]'));
    check('E2 the top bar keeps check-now and the dark-mode button; in the app no exit or full-screen button shows',
      !!root.querySelector('[data-a="now"]') && !!root.querySelector('#themebtn')
      && root.querySelector('[data-a="exit"]').style.display === 'none' && root.querySelector('[data-a="focus"]').style.display === 'none');
    check('E3 nothing is recorded and no extra requests are made', !w.localStorage.getItem('fast-clicker-rec')
      && S.log.filter((l) => l.startsWith('GET dashboard/upcoming-lectures')).length === 1 && !S.log.some((l) => /^GET clickers\/322455/.test(l)));
    const t = root.querySelector('#themebtn'); const dark0 = root.host.classList.contains('dark');
    t.click();
    check('E4 the dark-mode button still switches and is remembered', root.host.classList.contains('dark') !== dark0
      && JSON.parse(w.localStorage.getItem('fast-clicker-settings')).theme === (dark0 ? 'light' : 'dark'));
    stop();
  }
  {
    // an update from v3.1: switches that can no longer be seen are reset, the list layout is kept, the old recording deleted
    const S = makeServer();
    const old = JSON.stringify({ oneTap: true, turbo: true, sound: false, keepAwake: false, autoOpen: false, groupBy: 'lecture', theme: 'dark', expanded: { a: true },
      record: true, recordUntil: Date.now() + 86400e3, peekNext: true, peekAct: false });
    const { w, fc, stop } = boot(S, { preset: { 'fast-clicker-settings': old, 'fast-clicker-rec': '[{"t":1,"y":"r"}]', 'fast-clicker-rec-default': '3' } });
    await until(() => fc.state.lastPollAt > 0, 10000);
    const saved = JSON.parse(w.localStorage.getItem('fast-clicker-settings'));
    check('E5 after the update hidden switches are back to normal (tap then Send, sound on, timetable pace) and the layout is kept',
      !fc.CFG.oneTap && !fc.CFG.turbo && fc.CFG.sound && fc.CFG.keepAwake && fc.CFG.autoOpen && fc.CFG.groupBy === 'lecture' && fc.CFG.theme === 'dark'
      && Object.keys(saved).sort().join() === 'expanded,groupBy,theme', JSON.stringify(saved));
    check('E6 the old timing recording is deleted from the device', w.localStorage.getItem('fast-clicker-rec') === null && w.localStorage.getItem('fast-clicker-rec-default') === null);
    stop();
  }
  {
    // with no lecture in the timetable, the app on screen still checks at the fast pace (exercise classes etc.)
    const S = makeServer({ lectureNow: false });
    const { fc, stop } = boot(S, { mode: 'focus', settings: { cadenceMs: 120, idleCadenceMs: 5000 } });
    await until(() => fc.state.lastPollAt > 0);
    const n = S.log.filter((l) => l.includes('activity-feed')).length;
    await wait(1000);
    const fast = S.log.filter((l) => l.includes('activity-feed')).length - n;
    stop();
    const S2 = makeServer({ lectureNow: false });
    const b = boot(S2, { settings: { cadenceMs: 120, idleCadenceMs: 5000 } });   // the browser panel: timetable pace
    await until(() => b.fc.state.lastPollAt > 0);
    const n2 = S2.log.filter((l) => l.includes('activity-feed')).length;
    await wait(1000);
    const slow = S2.log.filter((l) => l.includes('activity-feed')).length - n2;
    check('E7 open on screen, the app checks fast even outside the timetable; the in-page panel does not', fast >= 4 && slow === 0, `${fast} vs ${slow} checks in 1 s`);
    b.stop();
  }

  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
