// "Terrible lecture-hall Wi-Fi" simulation. Run: node tools/test-chaos.js [seconds-per-run] [runs]
// Every request: random latency, some hang until the client gives up, some fail outright, some 503s,
// some votes are applied by the server but the reply is lost. Plus a login expiry and a round restart.
const { makeServer, boot, mcsa, until, wait } = require('./harness');
const runs = Number(process.argv[3] || 3);
const chaos = { minMs: 30, maxMs: 450, hang: 0.12, reset: 0.08, err503: 0.10, lostReply: 0.25 };

async function run(n) {
  const S = makeServer({ chaos });
  const hooks = { timeScale: 0.06 }; // 7 s minimum timeout → ~0.4 s
  const { root, fc, stop } = boot(S, { hooks, settings: { voteDeadlineMs: 30000 } });
  const problems = [];
  const pick = (id, e) => { const b = root.querySelector(`.opt[data-id="${id}"][data-e="${e}"]`); if (!b) return false; b.click(); return true; };
  const want = new Map(); // id -> option the student finally wants (current round)
  const detectedIn = [];
  const ids = [501, 502, 503, 504, 505];
  for (const id of ids) {
    S.addClicker(mcsa(id, 'Q' + id));
    const t0 = Date.now();
    S.push({ objectType: 'CLICKER', type: 'CLICKER_OPEN', objectId: id, courseTitle: { de: 'Analysis I' } });
    for (let i = 0; i < 1 + (id % 3) * 4; i++) S.push({ objectType: 'CHANNEL', type: 'CHANNEL_COMMENT_CREATE', objectId: 7 }); // forum noise
    if (!await until(() => root.querySelector(`.card[data-id="${id}"]`), 15000)) { problems.push(`Q${id} never shown`); continue; }
    detectedIn.push(Date.now() - t0);
    const first = 1 + (id % 3);
    pick(id, first); want.set(id, first);
    root.querySelector(`.send[data-id="${id}"]`).click();
    if (id === 502) { await wait(80); pick(id, 3); want.set(id, 3); root.querySelector(`.send[data-id="${id}"]`).click(); } // changes mind mid-send
    if (id === 503) { S.auth = false; hooks.relogin = async () => { await wait(100); S.auth = true; return true; }; } // login expires mid-lecture
    if (id === 504) { // lecturer restarts the round while the answer may still be in flight
      await wait(60);
      S.clickers.get(id).round = 1; S.clickers.get(id).entries.forEach((e) => { e.selected = false; });
      S.push({ objectType: 'CLICKER', type: 'CLICKER_START_ROUND', objectId: id });
      await until(() => fc.state.clickers.get(id) && fc.state.clickers.get(id).gen === 1, 15000);
      await until(() => !fc.state.sending.has(id), 15000);
      S.clickers.get(id).entries.forEach((e) => { e.selected = false; }); // anything that landed belongs to the old round
      const roundStart = Date.now();
      await until(() => root.querySelector(`.opt[data-id="${id}"]`), 5000);
      pick(id, 2); want.set(id, 2); root.querySelector(`.send[data-id="${id}"]`).click();
      S.round504Start = roundStart;
    }
    await wait(150);
  }
  // let everything settle
  await until(() => ids.every((id) => /Confirmed/.test(root.querySelector(`.card[data-id="${id}"] .st`)?.textContent || '')), 40000);
  for (const id of ids) {
    const sel = S.clickers.get(id).entries.filter((e) => e.selected).map((e) => e.id);
    const lc = fc.state.clickers.get(id);
    const status = root.querySelector(`.card[data-id="${id}"] .st`)?.textContent || `(no card: local state=${lc && lc.state}, gen=${lc && lc.gen}, stopped=${lc && lc.roundStopped}, dismissed=${fc.state.dismissed.has(id)}, status=${JSON.stringify(fc.state.status.get(id))}, serverState=${S.clickers.get(id).state})`;
    if (sel.length !== 1 || sel[0] !== want.get(id)) problems.push(`Q${id}: server has [${sel}] but student wants ${want.get(id)} | status: ${status}`);
    if (!/Confirmed/.test(status)) problems.push(`Q${id}: not confirmed: ${status}`);
  }
  if (S.feedMaxInFlight > 1) problems.push(`feed polls overlapped (${S.feedMaxInFlight})`);
  if (S.voteMaxInFlight > 1) problems.push(`parallel votes for one question (${S.voteMaxInFlight})`);
  const old504 = S.votes.filter((v) => v.id === 504 && v.at > (S.round504Start || Infinity) && v.body.selectedAnswer[0] !== 2);
  if (old504.length) problems.push(`old-round answer sent into new round: ${JSON.stringify(old504.map((v) => v.body))}`);
  const gaps = fc.state.gapCount;
  stop();
  const reqs = S.log.length;
  console.log(`run ${n}: ${problems.length ? 'FAIL' : 'PASS'}  detection ${detectedIn.map((x) => x + 'ms').join(' ')} | ${reqs} requests, ${S.votes.length} votes applied, feed gaps ${gaps}`);
  for (const p of problems) console.log('   - ' + p);
  return problems.length === 0;
}
(async () => {
  let ok = 0;
  for (let i = 1; i <= runs; i++) if (await run(i)) ok++;
  console.log(`\n${ok}/${runs} chaos runs passed (hang ${chaos.hang * 100}%, reset ${chaos.reset * 100}%, 503 ${chaos.err503 * 100}%, lost vote replies ${chaos.lostReply * 100}%)`);
  process.exit(ok === runs ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
