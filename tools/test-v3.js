// v3 tests: EduApp-style list and question pages, shared discovery through the relay, diagnostics recorder.
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
    check('R1 around a lecture the client joins one room for the course, as a checking client', await until(() => R.joined()) && R.joined().rooms.length === 1 && /^[0-9a-f]{32}$/.test(R.joined().rooms[0]) && R.joined().scout === true && R.sockets[0].url === 'wss://relay.test/v1');
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
    root.querySelector('[data-a="menu"]').click();
    key('2');
    await wait(300);
    check('S7 with the settings sheet open, number keys send nothing', S.votes.length === 0);
    root.querySelector('[data-a="closemenu"]').click();
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

  // ---------- K: peek the next id (#3) — measure whether a direct poll beats the feed, read-only, own course
  const courseBase = (S) => Math.max(...S.list.byCourse.filter((c) => c.code === '401-0261-00').flatMap((c) => c.clickers.map((x) => x.id)));
  const logOf = (fc, y) => fc.rec.log.filter((e) => e.y === y);
  {
    const S = makeServer();
    const { root, fc, stop } = boot(S, { hooks: { timeScale: 0.02 }, settings: { record: true, peekNext: true, peekEveryMs: 30, peekWindow: 3 } });
    await fc.fullScan();                                   // so the client knows this course's highest id
    const base = courseBase(S);
    S.addClicker(mcsa(base + 1, 'Peeked open'));           // opens, but NOT announced through the feed
    S.forbid.add(base + 2);                                // an id ETH will not show this student
    // base + 3 is unknown -> 404
    const detected = await until(() => logOf(fc, 'P').some((e) => e.id === base + 1), 3000);
    await wait(200);
    const peeks = logOf(fc, 'p');
    const byOff = (o, pred) => peeks.some((e) => e.off === o && pred(e));
    check('K1 a direct poll of the next id notices the open question with no feed event', detected && logOf(fc, 'P').some((e) => e.id === base + 1 && e.off === 1));
    check('K2 the recording captures what each un-announced id returns (open / forbidden / not found)',
      byOff(1, (e) => e.s === 200 && e.st === 'OPEN') && byOff(2, (e) => e.s === 403) && byOff(3, (e) => e.s === 404),
      JSON.stringify(peeks.map((e) => [e.off, e.s, e.st])));
    check('K3 by default it only measures: the question is not put on screen, and nothing is ever voted', !root.querySelector(`.card[data-id="${base + 1}"]`) && fc.ui.id !== base + 1 && S.votes.length === 0);
    const allowed = new Set(['t', 'y', 'id', 'off', 's', 'st', 'q', 'pv', 'ans']);
    check('K4 the peek records hold ids and counts only — no question text or chosen answer',
      peeks.length > 0 && peeks.every((e) => Object.keys(e).every((k) => allowed.has(k)) && (e.st === null || typeof e.st === 'string')) && !/question|individualAnswer|2\+2|selectedAnswer/.test(JSON.stringify(fc.rec.log)));
    // it stays bounded: only a few ids above the base, only the current course
    check('K5 it probes only a small window in the current lecture\'s course', S.log.filter((l) => /^GET clickers\/\d+$/.test(l) && Number(l.split('/')[1]) > base).every((l) => Number(l.split('/')[1]) <= base + 3));
    stop();
  }
  {
    // the prototype: with peekAct on, a question found by the id-poll is actually shown (still never voted)
    const S = makeServer(); const alerts = [];
    const { root, fc, stop } = boot(S, { hooks: { timeScale: 0.02, onAlert: (q) => alerts.push(q.id), nativeAlerts: true }, settings: { record: true, peekNext: true, peekAct: true, peekEveryMs: 30 } });
    await fc.fullScan();
    const base = courseBase(S);
    S.addClicker(mcsa(base + 1, 'Peeked and shown'));
    const shown = await until(() => root.querySelector(`.card[data-id="${base + 1}"]`), 3000);
    check('K6 prototype: with peekAct on, an id-poll detection shows the question (via the hint path) and alerts once',
      shown && fc.ui.id === base + 1 && alerts.filter((x) => x === base + 1).length === 1 && logOf(fc, 'e').some((e) => e.id === base + 1 && e.via === 'peek'));
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: base + 1, courseTitle: { de: 'Analysis I' } });   // the feed catches up
    await wait(400);
    check('K7 the feed event for the same opening does not alert again or start a new round', alerts.filter((x) => x === base + 1).length === 1 && fc.state.clickers.get(base + 1).gen === 0);
    check('K8 still nothing is voted automatically', S.votes.length === 0);
    stop();
  }
  {
    // switched off, it makes no candidate requests at all
    const S = makeServer();
    const { fc, stop } = boot(S, { hooks: { timeScale: 0.02 }, settings: { record: true, peekNext: false, peekEveryMs: 30 } });
    await fc.fullScan();
    const base = courseBase(S);
    S.addClicker(mcsa(base + 1, 'Not peeked'));
    await wait(600);
    check('K9 with the experiment off, no ids above the known ones are requested', !S.log.some((l) => /^GET clickers\/\d+$/.test(l) && Number(l.split('/')[1]) > base) && logOf(fc, 'p').length === 0);
    stop();
  }

  // ---------- D: diagnostics recorder
  {
    const S = makeServer(); let shared = null;
    const { root, fc, stop } = boot(S, { hooks: { onShare: (text, name) => { shared = { text, name }; }, timeScale: 0.05 }, settings: { record: true } });
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(840001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 840001 });
    await until(() => root.querySelector('.card[data-id="840001"]'));
    await wait(500);
    root.querySelector('.opt[data-id="840001"][data-e="2"]').click();
    root.querySelector('.send[data-id="840001"]').click();
    await until(() => /Confirmed/.test(st(root, 840001)));
    root.querySelector('[data-a="menu"]').click();
    root.querySelector('[data-a="share"]').click();
    const out = shared && JSON.parse(shared.text);
    const types = out ? new Set(out.log.map((x) => x.y)) : new Set();
    check('D1 the recording has request timings, feed changes, events and alerts', !!out && ['r', 'f', 'e', 'a'].every((y) => types.has(y)), [...types].join());
    const uis = out ? out.log.filter((x) => x.y === 'u' && x.id === 840001).map((x) => x.ev) : [];
    check('D10 it records when a question came on screen, the first tap on an option and the send (not which option)',
      uis.join() === 'show,pick,send' && out.log.filter((x) => x.y === 'u').every((x) => !('e' in x) && !('answer' in x)), uis.join());
    const boot0 = out && out.log.find((x) => x.y === 's' && x.ev === 'boot');
    check('D11 it records each start with the version and whether the app was on screen', !!boot0 && boot0.v === fc.version && boot0.h === 0);
    check('D2 it also watched the timetable flags and the open question itself', types.has('g') && types.has('c') && S.log.filter((l) => l.startsWith('GET dashboard/upcoming-lectures')).length > 2);
    const vote = out && out.log.find((x) => x.y === 'r' && x.k === 'vote');
    check('D3 the vote is timed, but neither the answer nor any question text is recorded', !!vote && vote.s === 200 && typeof vote.ms === 'number' && !/selectedAnswer|2\+2|individualAnswer/.test(shared.text));
    check('D4 the export is a named JSON file', /^fast-clicker-diagnostics-.*\.json$/.test(shared.name) && out.app === 'fast-clicker' && out.entries === out.log.length);
    check('D5 the recording is kept on the device between starts', JSON.parse(fc.rec && root.ownerDocument.defaultView.localStorage.getItem('fast-clicker-rec') || '[]').length > 0 || (fc.rec.dirty === true));
    const snaps = out ? out.log.filter((x) => x.y === 'c') : [];
    check('D7 question snapshots hold counts only: not which options this student chose, not which are correct',
      snaps.length > 0 && snaps.every((x) => x.snap.length === 9 && typeof x.snap[4] === 'number' && x.snap[6].every((e) => e.length === 2)));
    check('D8 recording stops by itself after two weeks', fc.CFG.recordUntil === 0 || fc.CFG.recordUntil - Date.now() <= 14 * 86400e3);
    stop();
  }
  {
    // the iPhone app switches recording on once; after the student switches it off it stays off
    const S = makeServer();
    const first = boot(S, { hooks: { recordDefault: true } });
    const on = first.fc.CFG.record && first.fc.CFG.recordUntil > Date.now();
    first.root.querySelector('[data-a="menu"]').click();
    first.root.querySelector('[data-a="record"]').click();
    const off = !first.fc.CFG.record;
    const store = first.w.localStorage;
    const saved = { s: store.getItem('fast-clicker-settings'), d: store.getItem('fast-clicker-rec-default') };
    first.stop();
    const again = boot(S, { hooks: { recordDefault: true }, preset: { 'fast-clicker-settings': saved.s, 'fast-clicker-rec-default': saved.d } });
    check('D9 the app turns recording on once by default; switched off, it is not turned on again', on && off && saved.d === '3' && !again.fc.CFG.record);
    again.stop();
  }
  {
    // a new measurement run: an app whose first run (v3.0.0) has expired records again after the update, for two weeks
    const S = makeServer();
    const { fc, stop } = boot(S, { hooks: { recordDefault: true }, settings: { record: false, recordUntil: 0 }, preset: { 'fast-clicker-rec-default': '1' } });
    check('D12 after the update, recording is on again for the next lectures (two weeks)', fc.CFG.record && fc.CFG.recordUntil - Date.now() > 13 * 86400e3);
    stop();
  }
  {
    // the app going to the background and coming back is recorded: it cannot check while it is not on screen
    const S = makeServer();
    const { w, fc, stop } = boot(S, { settings: { record: true } });
    await until(() => fc.state.lastPollAt > 0);
    Object.defineProperty(w.document, 'hidden', { value: true, configurable: true });
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    Object.defineProperty(w.document, 'hidden', { value: false, configurable: true });
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    const vs = fc.rec.log.filter((x) => x.y === 'v').map((x) => x.h);
    check('D13 leaving and returning to the app are recorded', vs.join() === '1,0', vs.join());
    stop();
  }
  {
    // a draft (+1) that opens later: the recording brackets the moment it turned open (last seen as a draft, first seen open)
    const S = makeServer();
    const { fc, stop } = boot(S, { hooks: { timeScale: 0.02 }, settings: { record: true, peekNext: true, peekEveryMs: 30 } });
    await fc.fullScan();
    const base = courseBase(S);
    S.addClicker({ ...mcsa(base + 1, 'Draft first'), state: 'DRAFT' });
    const sawDraft = await until(() => logOf(fc, 'p').some((e) => e.id === base + 1 && e.st === 'DRAFT'), 3000);
    S.clickers.get(base + 1).state = 'OPEN';
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: base + 1, courseTitle: { de: 'Analysis I' } });
    await until(() => logOf(fc, 'P').some((e) => e.id === base + 1), 3000);
    const P = logOf(fc, 'P').find((e) => e.id === base + 1);
    check('K6 the last moment the next question was still a draft is recorded with its opening (whoever saw it first)',
      sawDraft && !!P && P.prev > 0 && P.prev <= P.t, JSON.stringify(P));
    stop();
  }
  {
    // the peek runs between feed checks, never on its own: with no feed check (paused) there is no peek either
    const S = makeServer();
    const { fc, stop } = boot(S, { hooks: { timeScale: 0.02 }, settings: { record: true, peekNext: true, peekEveryMs: 30 } });
    await fc.fullScan();
    await until(() => logOf(fc, 'p').length > 0, 3000);
    fc.state.running = false;
    await wait(300);
    const n = S.log.length;
    await wait(600);
    check('K7 the peek only follows feed checks', S.log.length === n, S.log.slice(n).join());
    stop();
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
    const { fc, stop } = boot(S, { settings: { cadenceMs: 5000, idleCadenceMs: 5000 } });
    await until(() => fc.state.lastPollAt > 0);
    await wait(100);
    const n = S.log.filter((l) => l.includes('activity-feed')).length;
    fc.checkNow();
    const asked = await until(() => S.log.filter((l) => l.includes('activity-feed')).length > n, 1000);
    check('V4 "check now" asks the feed right away', asked);
    stop();
  }
  {
    const S = makeServer();
    const { root, w, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    await wait(500);
    check('D6 with recording off nothing is stored and no extra requests are made', (w.localStorage.getItem('fast-clicker-rec') || '[]') === '[]' && S.log.filter((l) => l.startsWith('GET dashboard/upcoming-lectures')).length === 1 && !root.querySelector('[data-a="mark"]'));
    stop();
  }

  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
