// End-to-end: real Fast Clicker clients (jsdom) talking to the real relay (relay/src/node-server.js on a local
// port). Each client has its own mock EduApp, so a question can only reach the others through a relay hint.
// Run: node tools/test-relay-e2e.js   (needs `npm install` in relay/ once)
const path = require('path');
const { makeServer, boot, mcsa, until, wait } = require('./harness');
const WS = require(path.join(__dirname, '../relay/node_modules/ws'));
const results = [];
const check = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
const feedPolls = (S) => S.log.filter((l) => l.startsWith('GET dashboard/activity-feed')).length;

(async () => {
  const { startServer } = await import('../relay/src/node-server.js');
  const { Hub } = await import('../relay/src/hub.js');
  const hub = new Hub({ limits: { POLL_EVERY_MS: 150 } });          // test clients poll every 120 ms when alone; two sharing: every 300 ms each
  const relay = await startServer({ port: 0, host: '127.0.0.1', hub });
  const url = `ws://127.0.0.1:${relay.port}/v1`;
  const client = () => {
    const S = makeServer(); const alerts = [];
    const b = boot(S, { hooks: { relayUrl: url, WebSocket: WS, nativeAlerts: true, onAlert: (q) => alerts.push(q.id) }, settings: { shareMinMs: 10 } });
    return { S, alerts, ...b };
  };
  const A = client(), B = client();
  const both = await until(() => hub.stats().connections === 2 && [A, B].every((c) => [...c.fc.relay.rooms.values()].some((r) => r.n === 2)), 4000);
  const slots = [A, B].map((c) => [...c.fc.relay.rooms.values()][0]).map((r) => r && r.slot).sort().join();
  check('E1 two clients in the same lecture meet in one room and get slots 0 and 1', both && hub.stats().rooms === 1 && slots === '0,1', `slots ${slots}, ${JSON.stringify(hub.stats())}`);

  await wait(300);
  const a0 = feedPolls(A.S), b0 = feedPolls(B.S); await wait(1200);
  const na = feedPolls(A.S) - a0, nb = feedPolls(B.S) - b0;
  check('E2 they take turns: each asks its feed less than half as often as alone (alone: about 10 in 1.2 s)', na >= 2 && na <= 6 && nb >= 2 && nb <= 6, `A ${na}, B ${nb}`);

  // a question opens; only A's EduApp feed shows the event, B can only learn of it through the relay
  A.S.addClicker(mcsa(900001, 'Shared')); B.S.addClicker(mcsa(900001, 'Shared'));
  const createdAt = new Date().toISOString();
  A.S.feed.unshift({ id: 990500, createdAt, objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 900001, courseTitle: { de: 'Analysis I', en: 'Analysis I' } });
  const t0 = Date.now();
  const gotA = await until(() => A.root.querySelector('.card[data-id="900001"]'), 3000);
  const gotB = await until(() => B.root.querySelector('.card[data-id="900001"]'), 3000);
  check('E3 the client whose check finds the question shows it', gotA);
  check('E4 the other client gets it through the relay and reads the question from its own EduApp', gotB && B.S.log.includes('GET clickers/900001') && B.alerts.includes(900001), `after ${Date.now() - t0} ms`);
  check('E5 the other client opened the question page by itself', B.fc.ui.view === 'detail' && B.fc.ui.id === 900001);

  // B answers: the vote goes to B's EduApp only
  B.root.querySelector('.opt[data-id="900001"][data-e="2"]').click();
  B.root.querySelector('.send[data-id="900001"]').click();
  check('E6 answering works as usual and nothing about it goes to the relay', await until(() => B.S.votes.some((v) => v.id === 900001)) && A.S.votes.length === 0);

  // a third student opens the app a moment later: the relay replays the recent hint
  const C = client();
  C.S.addClicker(mcsa(900001, 'Shared'));
  check('E7 a client joining shortly afterwards is told about the open question right away', await until(() => C.root.querySelector('.card[data-id="900001"]'), 4000) && C.alerts.filter((x) => x === 900001).length === 1);
  check('E8 the room now has three checking clients', await until(() => [A, B, C].every((c) => [...c.fc.relay.rooms.values()].some((r) => r.n === 3)), 3000));

  // the relay goes away: everybody keeps working alone
  await new Promise((r) => { for (const ws of relay.wss.clients) ws.terminate(); relay.server.close(r); });
  await wait(300);
  A.S.addClicker(mcsa(900002, 'Alone'));
  A.S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: 900002, courseTitle: { de: 'Analysis I' } });
  const tE9 = Date.now();
  const found = await until(() => A.root.querySelector('.card[data-id="900002"]'), 8000);
  check('E9 with the relay gone a client still finds new questions by itself (alone, at the slower fallback pace)', found,
    `${Date.now() - tE9} ms; lastN ${A.fc.relay.lastN}; feed ${A.S.log.filter((l) => l.includes('activity-feed')).length}; err ${A.fc.state.lastError}; hold ${A.fc.state.hold.size}; confirm ${A.fc.relay.confirmDue}`);

  for (const c of [A, B, C]) c.stop();
  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
