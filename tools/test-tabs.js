// Two EduApp tabs in one browser: only one may poll, the other must still show questions; when the
// polling tab closes the other takes over. Uses a fake Web Locks API + an in-process BroadcastChannel bus.
const { makeServer, boot, mcsa, until } = require('./harness');
const results = [];
const check = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);

function fakeLocks() {
  // per-name exclusive locks; a lock is held until the callback's promise settles (like navigator.locks)
  const locks = new Map(); // name -> {holder, queue}
  const L = (name) => { if (!locks.has(name)) locks.set(name, { holder: null, queue: [] }); return locks.get(name); };
  const grant = (name) => {
    const l = L(name); if (l.holder || !l.queue.length) return;
    const h = l.holder = l.queue.shift();
    Promise.resolve().then(() => h.cb()).then(h.resolve, h.reject).finally(() => { if (l.holder === h) { l.holder = null; setTimeout(() => grant(name), 0); } });
  };
  return {
    forWindow: (tag) => ({ request: (name, cb) => new Promise((resolve, reject) => { L(name).queue.push({ tag, cb, resolve, reject }); setTimeout(() => grant(name), 0); }) }),
    closeTag(tag) { for (const [name, l] of locks) { l.queue = l.queue.filter((q) => q.tag !== tag); if (l.holder && l.holder.tag === tag) { l.holder = null; setTimeout(() => grant(name), 0); } } },
  };
}
function bus() {
  const chans = new Set();
  const make = (tag) => class BC {
    constructor(name) { this.name = name; this.tag = tag; chans.add(this); }
    postMessage(m) { const data = JSON.parse(JSON.stringify(m)); for (const c of chans) if (c !== this && c.name === this.name && c.onmessage) setTimeout(() => { if (chans.has(c)) c.onmessage({ data }); }, 0); }
    close() { chans.delete(this); }
  };
  return { forWindow: make, closeTag: (tag) => { for (const c of [...chans]) if (c.tag === tag) chans.delete(c); } };
}

(async () => {
  const S = makeServer();
  const L = fakeLocks(); const BC = bus();
  const feedBy = { a: 0, b: 0 };
  const tagged = (tag) => async (url, opts) => { if (String(url).includes('activity-feed')) feedBy[tag]++; return S.fetch(url, opts); };
  const A = boot({ ...S, fetch: tagged('a') }, { locks: L.forWindow('a'), BroadcastChannel: BC.forWindow('a') });
  await until(() => A.root.querySelector('.card[data-id="322454"]'));
  const B = boot({ ...S, fetch: tagged('b') }, { locks: L.forWindow('b'), BroadcastChannel: BC.forWindow('b') });
  check('T1 second tab receives the open question without polling', await until(() => B.root.querySelector('.card[data-id="322454"]')) && feedBy.b === 0);
  S.addClicker(mcsa(600001)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 600001 });
  check('T2 new question appears in both tabs, polled by one', await until(() => A.root.querySelector('.card[data-id="600001"]') && B.root.querySelector('.card[data-id="600001"]')) && feedBy.b === 0, `feed polls a=${feedBy.a} b=${feedBy.b}`);
  check('T3 follower shows it is following', /another tab/.test(B.root.querySelector('.rf').title));
  B.root.querySelector('.opt[data-id="600001"][data-e="2"]').click();
  B.root.querySelector('.send[data-id="600001"]').click();
  check('T4 answering from the follower tab works', await until(() => /Confirmed/.test(B.root.querySelector('.card[data-id="600001"] .st').textContent)));
  // T6: same question answered in two tabs; A's request is slow, B answers later → server must end with B's answer
  S.addClicker(mcsa(600003)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 600003 });
  await until(() => A.root.querySelector('.card[data-id="600003"]') && B.root.querySelector('.card[data-id="600003"]'));
  S.voteDelay = 400;
  A.root.querySelector('.opt[data-id="600003"][data-e="1"]').click(); A.root.querySelector('.send[data-id="600003"]').click();
  await new Promise((r) => setTimeout(r, 80));
  S.voteDelay = 0;
  B.root.querySelector('.opt[data-id="600003"][data-e="2"]').click(); B.root.querySelector('.send[data-id="600003"]').click();
  await until(() => /Confirmed/.test(B.root.querySelector('.card[data-id="600003"] .st').textContent), 6000);
  await new Promise((r) => setTimeout(r, 800));
  const sel = S.clickers.get(600003).entries.filter((e) => e.selected).map((e) => e.id);
  check('T6 newer answer from another tab wins (votes serialized across tabs)', sel.length === 1 && sel[0] === 2, `server [${sel}], A: "${A.root.querySelector('.card[data-id="600003"] .st').textContent}", B: "${B.root.querySelector('.card[data-id="600003"] .st').textContent}"`);
  check('T7 never two vote requests for one question at once (across tabs)', S.voteMaxInFlight === 1, `max ${S.voteMaxInFlight}`);
  // T8: leader needs a login → follower shows the Log in button
  A.fc.hooks.relogin = async () => false; B.fc.hooks.relogin = async () => false;
  S.auth = false;
  check('T8 follower tab also offers Log in when the session expired', await until(() => B.root.querySelector('[data-a="login"]'), 6000));
  S.auth = true;
  await until(() => !A.fc.state.authLost && !B.root.querySelector('[data-a="login"]'), 6000);
  // T9: pausing the polling tab hands polling over to the other tab
  A.fc.setRunning(false);
  const bBefore = feedBy.b;
  S.addClicker(mcsa(600004)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 600004 });
  check('T9 pausing the polling tab hands polling to the other tab', await until(() => B.root.querySelector('.card[data-id="600004"]') && feedBy.b > bBefore, 6000));
  A.fc.setRunning(true); // resume: A queues as follower again
  // close tab A
  A.fc.state.running = false; BC.closeTag('a'); A.w.close(); L.closeTag('a');
  const before = feedBy.b;
  S.addClicker(mcsa(600002)); S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 600002 });
  const ok5 = await until(() => B.root.querySelector('.card[data-id="600002"]') && feedBy.b > before + 1, 6000);
  check('T5 remaining tab takes over polling when the other closes', ok5, ok5 ? '' : JSON.stringify({ leader: B.fc.state.leader, running: B.fc.state.running, polling: B.fc.state.polling, err: B.fc.state.lastError, authLost: B.fc.state.authLost, feedB: feedBy.b, before, stat: B.root.getElementById("stat").textContent, inflight: [...B.fc.state.inflight.keys()], timer: B.fc.state.timer, primed: B.fc.state.feedPrimed, lpAgo: Date.now() - B.fc.state.lastPollAt, ownAgo: Date.now() - B.fc.state.lastOwnPollAt, pend: [...B.fc.state.pendingRefresh.keys()] }));
  B.stop();
  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
