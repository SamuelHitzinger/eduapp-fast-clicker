// Functional + regression tests (mock server, jsdom). Run: node tools/test-mock.js
const { makeServer, boot, mcsa, st, until, wait, detail } = require('./harness');
const results = [];
const check = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);

(async () => {
  // ---------- A: main flow (panel mode)
  {
    const S = makeServer(); const hooks = {}; const { w, root, fc, stop } = boot(S, { hooks });
    check('A1 open clicker detected at start-up', await until(() => root.querySelector('.card[data-id="322454"]')));
    check('A2 start-up does not fetch closed clickers or the 1 MB list', !S.log.some((l) => /clickers\/3224(53|57|58)$/.test(l) || l.startsWith('GET clickers?')), S.log.filter((l) => l.startsWith('GET clickers')).join(', '));
    check('A3 start-up STOP_ROUND shown as stopped round', /stopped this round/.test(root.querySelector('.card[data-id="322454"]').textContent));
    check('A4 live mode during lecture', /live/i.test(root.querySelector('.rf').title), root.querySelector('.rf').title);
    S.failVotes = 1;
    const e = detail.entries;
    root.querySelector(`.opt[data-e="${e[0].id}"]`).click();
    root.querySelector(`.opt[data-e="${e[2].id}"]`).click();
    root.querySelector('.send[data-id="322454"]').click();
    check('A5 vote retried after 503, accepted, then confirmed', await until(() => /Confirmed/.test(st(root, 322454))), st(root, 322454));
    check('A6 vote body matches app format', JSON.stringify(S.votes.at(-1).body) === JSON.stringify({ selectedAnswer: [e[0].id, e[2].id] }));
    S.addClicker(mcsa(400001, 'Neue Frage'));
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 400001, courseTitle: { de: 'Analysis I' } });
    check('A7 newly opened clicker detected from feed', await until(() => root.querySelector('.card[data-id="400001"]')));
    fc.CFG.oneTap = true;
    root.querySelector('.opt[data-id="400001"][data-e="2"]').click();
    check('A8 1-tap send on single choice', await until(() => S.votes.some((v) => v.id === 400001 && v.body.selectedAnswer[0] === 2)));
    S.clickers.get(400001).state = 'CLOSED';
    S.push({ objectType: 'CLICKER', type: 'CLICKER_CLOSE', objectId: 400001 });
    check('A9 closed clicker switches to its results page', await until(() => root.querySelector('.card.closed[data-id="400001"]') && !root.querySelector('.send[data-id="400001"]')) && /closed/.test(root.getElementById('dtitle').textContent));
    S.addClicker({ id: 400002, type: 'TEXT', state: 'OPEN', title: 'Text', question: '<p>Why?</p>', answerState: 'UNANSWERED', individualAnswer: null, entries: [] });
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 400002 });
    await until(() => root.querySelector('textarea[data-id="400002"]'));
    const ta = root.querySelector('textarea[data-id="400002"]');
    const sendBtn = root.querySelector('.send[data-id="400002"]');
    ta.value = '  because  '; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(400);
    check('A10 typing + polls do not replace textarea/send button', ta.isConnected && sendBtn.isConnected);
    sendBtn.click();
    check('A11 text answer sent trimmed + confirmed', await until(() => /Confirmed/.test(st(root, 400002))) && S.votes.at(-1).body.individualAnswer === 'because');
    // login expiry, SSO dead → "Log in" button, no navigation; user logs in elsewhere → recovers
    hooks.relogin = async () => false;
    S.auth = false;
    const href = w.location.href;
    check('A12 expired login shows Log in button without navigating', await until(() => root.querySelector('[data-a="login"]')) && w.location.href === href);
    S.auth = true;
    check('A13 recovers automatically once logged in again', await until(() => !root.querySelector('[data-a="login"]') && !/expired/.test(root.textContent)));
    // silent renewal while SSO alive
    let silentCalls = 0;
    hooks.relogin = async () => { silentCalls++; S.auth = true; return true; };
    S.auth = false;
    await until(() => silentCalls > 0);
    check('A14 silent login renewal (no user action)', await until(() => !fc.state.authLost) && !root.querySelector('[data-a="login"]'));
    const gets = S.urls.filter((u) => !u.includes('/vote'));
    check('A15 every GET carries a unique _fc param (SW cache bypass)', gets.every((u) => /[?&]_fc=/.test(u)) && new Set(gets).size === gets.length);
    check('A16 feed polls never overlap', S.feedMaxInFlight === 1, `max in flight ${S.feedMaxInFlight}`);
    check('A17 never two vote requests for the same question at once', S.voteMaxInFlight === 1, `max ${S.voteMaxInFlight}`);
    stop();
  }
  // ---------- answer kept across login expiry, sent after renewal
  {
    const S = makeServer(); const hooks = {}; const { root, stop } = boot(S, { hooks });
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(470001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 470001 });
    await until(() => root.querySelector('.card[data-id="470001"]'));
    hooks.relogin = async () => false; S.auth = false;
    root.querySelector('.opt[data-id="470001"][data-e="3"]').click();
    root.querySelector('.send[data-id="470001"]').click();
    await until(() => /Login expired/.test(st(root, 470001)));
    check('A18 answer waits during login expiry', !S.votes.some((v) => v.id === 470001), st(root, 470001));
    S.auth = true;
    check('A19 waiting answer is delivered right after login', await until(() => /Confirmed/.test(st(root, 470001)), 6000) && S.votes.some((v) => v.id === 470001 && v.body.selectedAnswer[0] === 3));
    stop();
  }
  // ---------- offline: answer queued, sent when back online
  {
    const S = makeServer(); const hooks = {}; const { w, root, stop } = boot(S, { hooks });
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(480001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 480001 });
    await until(() => root.querySelector('.card[data-id="480001"]'));
    hooks.offline = true;
    root.querySelector('.opt[data-id="480001"][data-e="1"]').click();
    root.querySelector('.send[data-id="480001"]').click();
    check('A20 offline: shows still trying', await until(() => /Offline, still trying/.test(st(root, 480001))));
    hooks.offline = false; w.dispatchEvent(new w.Event('online'));
    check('A21 back online: delivered and confirmed', await until(() => /Confirmed/.test(st(root, 480001)), 6000));
    stop();
  }
  // ---------- B1: failed detail fetch retried next poll
  {
    const S = makeServer(); const { root, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(410001)); S.failDetail.set(410001, 2);
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 410001 });
    check('B1 opening event survives failed detail fetches', await until(() => root.querySelector('.card[data-id="410001"]')));
    stop();
  }
  // ---------- B2: burst of > feedSmall events between polls
  {
    const S = makeServer(); const { root, fc, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    fc.state.running = false; await wait(200);
    S.addClicker(mcsa(420001));
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 420001 });
    for (let i = 0; i < 12; i++) S.push({ objectType: 'CHANNEL', type: 'CHANNEL_COMMENT_CREATE', objectId: 1 });
    fc.state.running = true; fc.tick();
    check('B2 open event hidden behind 12 newer events still detected', await until(() => root.querySelector('.card[data-id="420001"]')));
    S.clickers.get(420001).state = 'CLOSED'; S.push({ objectType: 'CLICKER', type: 'CLICKER_CLOSE', objectId: 420001 });
    await until(() => !root.querySelector('.card[data-id="420001"]'));
    S.clickers.get(420001).state = 'OPEN';
    S.list.byCourse[0].clickers.push({ id: 420001, type: 'MCSA', state: 'OPEN', answerState: 'UNANSWERED', title: 'Q', question: '', preview: false });
    await fc.fullScan();
    check('B2b full scan re-detects a re-opened known clicker', await until(() => root.querySelector('.card[data-id="420001"]')));
    stop();
  }
  // ---------- B3: no old answer into a new round
  {
    const S = makeServer(); const { root, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(430001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 430001 });
    await until(() => root.querySelector('.card[data-id="430001"]'));
    S.failVotes = 50; S.voteDelay = 100;
    root.querySelector('.opt[data-id="430001"][data-e="1"]').click();
    root.querySelector('.send[data-id="430001"]').click();
    await wait(60);
    S.push({ objectType: 'CLICKER', type: 'CLICKER_START_ROUND', objectId: 430001 });
    await until(() => /new round/i.test(st(root, 430001)), 5000);
    S.failVotes = 0; await wait(500);
    check('B3 no old-round answer submitted after round change', !S.votes.some((v) => v.id === 430001), st(root, 430001));
    check('B3b draft cleared for new round', !root.querySelector('.opt.sel[data-id="430001"]'));
    S.voteDelay = 0;
    stop();
  }
  // ---------- B4: changed mind while sending (1-tap)
  {
    const S = makeServer(); const { root, fc, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(440001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 440001 });
    await until(() => root.querySelector('.card[data-id="440001"]'));
    fc.CFG.oneTap = true; S.voteDelay = 200;
    root.querySelector('.opt[data-id="440001"][data-e="1"]').click();
    await wait(50);
    root.querySelector('.opt[data-id="440001"][data-e="3"]').click();
    await until(() => S.votes.filter((v) => v.id === 440001).length >= 2 && /Confirmed/.test(st(root, 440001)), 5000);
    check('B4 newer choice made while sending is sent afterwards', S.clickers.get(440001).entries.find((e) => e.id === 3).selected, JSON.stringify(S.votes.filter((v) => v.id === 440001).map((v) => v.body)));
    S.voteDelay = 0;
    stop();
  }
  // ---------- B5: stale detail response must not overwrite confirmed vote
  {
    const S = makeServer(); const { root, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(450001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 450001 });
    await until(() => root.querySelector('.card[data-id="450001"]'));
    S.detailDelay.set(450001, 400);
    root.querySelector('.chip[data-a="reload"][data-id="450001"]').click();
    await wait(20);
    S.detailDelay.set(450001, 0);
    root.querySelector('.opt[data-id="450001"][data-e="2"]').click();
    root.querySelector('.send[data-id="450001"]').click();
    await until(() => /Confirmed/.test(st(root, 450001)));
    await wait(500);
    check('B5 stale detail response ignored after confirmed vote', !!root.querySelector('.opt.server[data-id="450001"][data-e="2"]'));
    stop();
  }
  // ---------- B6: late older request → server shows different answer → repaired automatically
  {
    const S = makeServer(); const { root, w, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(455001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 455001 });
    await until(() => root.querySelector('.card[data-id="455001"]'));
    const realFetch = w.fetch; let once = true;
    w.fetch = async (url, opts) => {                 // a stale request lands right after the vote was accepted
      const r = await realFetch(url, opts);
      if (once && /clickers\/455001\/vote/.test(String(url))) { once = false; S.clickers.get(455001).entries.forEach((e) => { e.selected = e.id === 1; }); }
      return r;
    };
    root.querySelector('.opt[data-id="455001"][data-e="2"]').click();
    root.querySelector('.send[data-id="455001"]').click();
    await until(() => S.votes.filter((v) => v.id === 455001).length >= 2, 5000);
    await until(() => /Confirmed/.test(st(root, 455001)), 5000);
    check('B6 verification repairs a mismatching server answer', S.clickers.get(455001).entries.find((e) => e.id === 2).selected, st(root, 455001));
    stop();
  }
  // ---------- B8: stale open clicker outside lectures → standby
  {
    const S = makeServer({ lectureNow: false });
    S.feed.unshift({ id: 999990, objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 460001, createdAt: new Date(Date.now() - 2 * 3600e3).toISOString() });
    S.addClicker(mcsa(460001));
    const { root, stop } = boot(S, { settings: { idleCadenceMs: 60000 } });
    await until(() => root.querySelector('.card[data-id="460001"]'));
    await wait(300);
    check('B8 stale open clicker → standby polling outside lectures', /standby/i.test(root.querySelector('.rf').title), root.querySelector('.rf').title);
    stop();
  }
  // ---------- R1: a slow download requested before a new round must not carry the old round's answer over
  {
    const S = makeServer(); const { root, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    const q = mcsa(700001); q.entries[0].selected = true; S.addClicker(q);       // answered in round 0
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 700001 });
    await until(() => root.querySelector('.card[data-id="700001"]'));
    S.detailDelay.set(700001, 500);
    root.querySelector('.chip[data-a="reload"][data-id="700001"]').click();      // slow request, snapshots round 0
    await wait(30);
    S.detailDelay.set(700001, 0);
    S.clickers.get(700001).entries.forEach((e) => { e.selected = false; });      // lecturer starts round 1
    S.push({ objectType: 'CLICKER', type: 'CLICKER_START_ROUND', objectId: 700001 });
    await wait(900);
    check('R1 new round shows no selection carried over from a stale download', !root.querySelector('.opt.sel[data-id="700001"]') && root.querySelector('.send[data-id="700001"]').disabled);
    stop();
  }
  // ---------- R2: round start buried behind > 25 events while a retry is pending → retry must stop
  {
    const S = makeServer(); const { root, fc, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(710001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 710001 });
    await until(() => root.querySelector('.card[data-id="710001"]'));
    S.failVotes = 1000;                                                          // server unreachable for votes
    root.querySelector('.opt[data-id="710001"][data-e="1"]').click();
    root.querySelector('.send[data-id="710001"]').click();
    await until(() => /still trying/.test(st(root, 710001)));
    fc.state.running = false; await wait(200);                                   // phone asleep
    S.clickers.get(710001).round = 1;
    S.push({ objectType: 'CLICKER', type: 'CLICKER_START_ROUND', objectId: 710001 });
    for (let i = 0; i < 30; i++) S.push({ objectType: 'CHANNEL', type: 'CHANNEL_COMMENT_CREATE', objectId: 1 });
    const t = Date.now();
    fc.state.running = true; fc.tick();
    await until(() => !fc.state.sending.has(710001), 5000);
    S.failVotes = 0; await wait(600);
    check('R2 unbridgeable feed gap stops retries of a possibly old-round answer', !S.votes.some((v) => v.id === 710001 && v.at > t), st(root, 710001));
    stop();
  }
  // ---------- N: native app shell hooks (iPhone app)
  {
    const S = makeServer(); const alerts = [];
    const { root, stop } = boot(S, { mode: 'focus', hooks: { nativeAlerts: true, noExit: true, onAlert: (q) => alerts.push(q) } });
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(740001, 'App Frage')); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 740001, courseTitle: { de: 'Analysis I' } });
    await until(() => root.querySelector('.card[data-id="740001"]'));
    await wait(400);
    const forNew = alerts.filter((a) => a.id === 740001);
    check('N1 app hook gets exactly one alert per opened question, with title and course', forNew.length === 1 && forNew[0].title === 'App Frage' && forNew[0].course === 'Analysis I', JSON.stringify(alerts));
    check('N2 in the app: no "tap to enable sound" hint and no "Back to EduApp"', !/enable the alert sound/.test(root.textContent) && root.querySelector('[data-a="exit"]').style.display === 'none');
    stop();
  }
  // ---------- R5: a round-start event whose download fails twice counts as ONE new round
  {
    const S = makeServer(); const { root, fc, stop } = boot(S);
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(730001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 730001 });
    await until(() => root.querySelector('.card[data-id="730001"]'));
    const g0 = fc.state.clickers.get(730001).gen;
    S.failDetail.set(730001, 2);
    S.push({ objectType: 'CLICKER', type: 'CLICKER_START_ROUND', objectId: 730001 });
    await until(() => fc.state.clickers.get(730001).gen > g0 && !fc.state.pendingRefresh.has(730001), 5000);
    root.querySelector('.opt[data-id="730001"][data-e="3"]').click();   // student answers the new round
    await wait(600);                                                     // several more polls
    check('R5 failed downloads of a round-start event bump the round once and keep the new choice', fc.state.clickers.get(730001).gen === g0 + 1 && !!root.querySelector('.opt.sel[data-id="730001"][data-e="3"]'), `gen ${g0} → ${fc.state.clickers.get(730001).gen}`);
    stop();
  }
  // ---------- R4: verification that only succeeds later and finds a different answer → repaired
  {
    const S = makeServer(); const { root, stop } = boot(S, { hooks: { timeScale: 0.03 } });
    await until(() => root.querySelector('.card[data-id="322454"]'));
    S.addClicker(mcsa(720001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 720001 });
    await until(() => root.querySelector('.card[data-id="720001"]'));
    S.failDetail.set(720001, 100);                                               // re-reads fail for a while
    root.querySelector('.opt[data-id="720001"][data-e="2"]').click();
    root.querySelector('.send[data-id="720001"]').click();
    await until(() => /Will double-check/.test(st(root, 720001)), 8000);
    S.clickers.get(720001).entries.forEach((e) => { e.selected = e.id === 1; }); // a stale request landed late
    S.failDetail.set(720001, 0);
    await until(() => /Confirmed/.test(st(root, 720001)), 8000);
    check('R4 late verification detects the wrong server answer and repairs it', S.clickers.get(720001).entries.find((e) => e.id === 2).selected, st(root, 720001));
    stop();
  }
  // ---------- F: focus mode
  {
    const S = makeServer(); const { w, root, stop } = boot(S, { mode: 'focus' });
    const appTimerFired = { n: 0 };
    check('F1 focus mode replaces the EduApp page with the panel', w.document.body.children.length === 1 && w.document.body.firstElementChild.id === 'fast-clicker-host');
    check('F2 focus mode shows clicker full-screen', await until(() => root.querySelector('.card[data-id="322454"]')) && w.document.getElementById('fast-clicker-host').classList.contains('focus'));
    check('F3 focus mode offers Back to EduApp', root.querySelector('[data-a="exit"]').style.display !== 'none');
    stop();
  }
  {
    // EduApp page timers created before the script must be stopped; the script keeps working afterwards
    const S = makeServer();
    const { JSDOM } = require('jsdom');
    let pageTicks = 0;
    const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { url: 'https://eduapp.ethz.ch/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window; w.fetch = S.fetch; w.AbortController = AbortController; w.__FC_HOOKS = {};
    w.__tick = () => pageTicks++;
    w.eval('setInterval(() => __tick(), 30)');
    w.localStorage.setItem('fast-clicker-settings', JSON.stringify({ cadenceMs: 120 }));
    w.eval(require('./harness').script);
    const root = w.document.getElementById('fast-clicker-host').shadowRoot;
    await until(() => root.querySelector('.card[data-id="322454"]'));
    root.querySelector('[data-a="focus"]').click();
    const before = pageTicks; await wait(300);
    S.addClicker(mcsa(490001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 490001 });
    check('F4 switching to focus stops EduApp page timers', pageTicks === before, `${pageTicks - before} ticks after`);
    check('F5 polling continues after switching to focus', await until(() => root.querySelector('.card[data-id="490001"]')));
    w.__fastClicker.state.running = false; w.close();
  }
  {
    // question content like EduApp sends it: MathJax SVG (defs + use) with hidden MathML, an embedded picture, formulas in answers
    const S = makeServer();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const formula = (n) => `<span class="mjpage"><span role="text" class="sr-only pLatexText">x squared</span><svg xmlns:xlink="http://www.w3.org/1999/xlink" width="2ex" height="2ex" viewBox="0 -800 900 1000" xmlns="http://www.w3.org/2000/svg"><defs><path id="E${n}-MJMATHI-78" d="M52 289Q59 331 106 386"></path></defs><g stroke="currentColor" fill="currentColor"><use xlink:href="#E${n}-MJMATHI-78"></use></g></svg><span class="mathMLFormula" aria-hidden="true"><math><msup><mi>x</mi><mn>2</mn></msup></math></span></span>`;
    S.addClicker({ id: 490777, type: 'MCSA', state: 'OPEN', title: 'Math', question: `<p>Is ${formula(1)} shown?</p><figure class="image"><img src="${png}"><figcaption>Plot</figcaption></figure><table><tr><td>a</td><td>b</td></tr></table>`,
      answerState: 'UNANSWERED', entries: [{ id: 1, answer: `<p>${formula(2)} yes</p>`, selected: false }, { id: 2, answer: '<p>no</p>', selected: false }], showResults: false, preview: false });
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 490777 });
    const { root, w, stop } = boot(S);
    const card = await until(() => root.querySelector('.card[data-id="490777"]')) && root.querySelector('.card[data-id="490777"]');
    const q = card && card.querySelector('.q');
    check('M1 formula SVG arrives with its glyph definitions', !!q && !!q.querySelector('svg defs path#E1-MJMATHI-78') && q.querySelector('svg use').getAttribute('xlink:href') === '#E1-MJMATHI-78');
    check('M2 picture arrives intact (embedded data URL, figure + caption)', !!q && q.querySelector('figure img')?.getAttribute('src') === png && q.querySelector('figcaption')?.textContent === 'Plot');
    check('M3 formulas inside answer options arrive', !!card && !!card.querySelector('.opt[data-e="1"] svg use') && card.querySelector('.opt[data-e="1"]').textContent.includes('yes'));
    check('M4 tables arrive', !!q && q.querySelectorAll('td').length === 2);
    const css = root.querySelector('style').textContent;
    check('M5 MathML copy hidden only when the SVG is there; pictures get a white backdrop', css.includes('svg~.mathMLFormula{display:none}') && /\.q img,\.opt img\{[^}]*background:#fff/.test(css));
    q.querySelector('img').dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
    const zoom = root.querySelector('.zoom');
    check('M6 tapping a picture shows it full screen', !zoom.hidden && zoom.querySelector('img')?.getAttribute('src') === png);
    zoom.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    check('M7 tapping again closes it without selecting anything', zoom.hidden && !card.querySelector('.opt.sel'));
    stop();
  }
  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
