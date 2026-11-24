// Beta monitoring: reads the anonymous diagnostics and relay snapshots from Cloudflare D1 (`clicker-metrics`).
//   node tools/monitor.js            last 24 hours (and 7-day testers)
//   node tools/monitor.js 72         last 72 hours
// Needs `npx wrangler login` on this PC (done). Reads only; never contacts ETH.
const { execFileSync } = require('child_process');
const path = require('path');
const hours = Number(process.argv[2]) || 24;
const relayDir = path.resolve(__dirname, '..', 'relay');

function q(sql) {
  const wrangler = path.join(relayDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');   // no shell: the SQL stays one argument
  const out = execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'clicker-metrics', '--remote', '--json', '--command', sql],
    { cwd: relayDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(out.slice(out.indexOf('[')));
  return (j[0] && j[0].results) || [];
}
const since = Date.now() - hours * 3600e3;
const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const s = (ms) => ms == null ? '–' : (ms / 1000).toFixed(1) + ' s';
const n0 = (x) => Number(x) || 0;

// ---------------------------------------------------------------- testers
const testers = q(`SELECT platform, version, COUNT(DISTINCT install) AS n FROM reports WHERE ts >= ${Date.now() - 7 * 86400e3} GROUP BY platform, version ORDER BY n DESC`);
const active = q(`SELECT platform, COUNT(DISTINCT install) AS n FROM reports WHERE ts >= ${since} GROUP BY platform`);
console.log(`\n== Testers (installations that reported)  — last ${hours} h / last 7 days`);
for (const r of active) console.log(`  ${r.platform.padEnd(8)} ${String(r.n).padStart(4)} active`);
console.log('  by version, 7 days: ' + (testers.map((r) => `${r.platform} ${r.version}: ${r.n}`).join(', ') || 'none yet'));

// ---------------------------------------------------------------- questions
const qs = q(`SELECT platform, data FROM reports WHERE kind = 'question' AND ts >= ${since}`).map((r) => ({ p: r.platform, ...JSON.parse(r.data) }));
console.log(`\n== Questions on screen (${qs.length} times)`);
if (qs.length) {
  for (const [label, sel] of [['all', qs], ['via relay hint', qs.filter((x) => x.hint)], ['via own feed check', qs.filter((x) => !x.hint)], ['app in background', qs.filter((x) => x.hidden)]]) {
    const d = sel.map((x) => x.delay);
    if (d.length) console.log(`  ${label.padEnd(20)} n=${String(d.length).padStart(4)}  median ${s(pct(d, 0.5))}  90% ${s(pct(d, 0.9))}  worst ${s(Math.max(...d))}`);
  }
}

// ---------------------------------------------------------------- periods: requests, votes, relay, ETH load
const per = q(`SELECT ts, install, data FROM reports WHERE kind = 'period' AND ts >= ${since}`).map((r) => ({ ts: r.ts, install: r.install, ...JSON.parse(r.data) }));
const sum = (_, f) => per.reduce((a, x) => a + n0(f(x)), 0);
const feed = { n: sum(0, (x) => x.feed && x.feed.n), ok: sum(0, (x) => x.feed && x.feed.ok), e5: sum(0, (x) => x.feed && x.feed.e5), e429: sum(0, (x) => x.feed && x.feed.e429),
  to: sum(0, (x) => x.feed && x.feed.to), net: sum(0, (x) => x.feed && x.feed.net), auth: sum(0, (x) => x.feed && x.feed.auth), msw: sum(0, (x) => x.feed && x.feed.ms * x.feed.ok) };
const vote = { n: sum(0, (x) => x.vote && x.vote.n), ok: sum(0, (x) => x.vote && x.vote.ok), fail: sum(0, (x) => x.vote && x.vote.fail), att: sum(0, (x) => x.vote && x.vote.att), msw: sum(0, (x) => x.vote && x.vote.ms * x.vote.ok) };
const detailN = sum(0, (x) => x.detail && x.detail.n);
console.log(`\n== Answers`);
console.log(`  sent ${vote.n}, accepted ${vote.ok}, failed ${vote.fail}` + (vote.ok ? `, avg ${s(vote.msw / vote.ok)}, avg attempts ${(vote.att / vote.ok).toFixed(2)}` : ''));
console.log(`\n== Load on ETH from Clicker users (activity feed = the expensive request)`);
console.log(`  feed checks ${feed.n} (${(feed.n / (hours * 3600)).toFixed(3)}/s on average), question reads ${detailN}`);
console.log(`  feed answer time avg ${feed.ok ? s(feed.msw / feed.ok) : '–'}; errors: 5xx ${feed.e5}, 429 ${feed.e429}, timeouts ${feed.to}, network ${feed.net}, login ${feed.auth}`);
// busiest hours (feed checks per second, averaged over the hour) and how slow ETH answered then
const byHour = new Map();
for (const x of per) {
  const h = new Date(x.ts).toISOString().slice(0, 13);
  const b = byHour.get(h) || { n: 0, ok: 0, msw: 0, err: 0, users: new Set() };
  if (x.feed) { b.n += n0(x.feed.n); b.ok += n0(x.feed.ok); b.msw += n0(x.feed.ms) * n0(x.feed.ok); b.err += n0(x.feed.e5) + n0(x.feed.e429) + n0(x.feed.to); }
  b.users.add(x.install); byHour.set(h, b);
}
const busiest = [...byHour.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5);
for (const [h, b] of busiest) console.log(`  ${h}:00 UTC  ${String(b.users.size).padStart(4)} apps  ${(b.n / 3600).toFixed(2)} feed checks/s  ETH answer avg ${b.ok ? s(b.msw / b.ok) : '–'}  errors ${b.err}`);
const relayOpen = per.length ? per.reduce((a, x) => a + n0(x.relay && x.relay.open), 0) / per.length : 0;
console.log(`\n== Relay (as the apps see it)`);
console.log(`  connected ${(relayOpen * 100).toFixed(0)}% of the time; hints received ${sum(0, (x) => x.relay && x.relay.hints)}, question reads because of hints ${sum(0, (x) => x.relay && x.relay.reads)}`);

// ---------------------------------------------------------------- app starts (Android: did EduApp open at all?)
const OUTCOME = { 1: 'ok', 2: 'login shown', 3: 'load error', 4: 'no answer 30 s', 5: 'clicker failed to start', 6: 'page process died' };
const NET = { '-2': 'FAILED', '-3': 'ABORTED', '-7': 'TIMED_OUT', '-10': 'ACCESS_DENIED', '-20': 'BLOCKED_BY_CLIENT', '-21': 'NETWORK_CHANGED', '-100': 'CONNECTION_CLOSED', '-101': 'CONNECTION_RESET',
  '-102': 'CONNECTION_REFUSED', '-103': 'CONNECTION_ABORTED', '-104': 'CONNECTION_FAILED', '-105': 'NAME_NOT_RESOLVED', '-106': 'INTERNET_DISCONNECTED', '-107': 'SSL_PROTOCOL_ERROR',
  '-109': 'ADDRESS_UNREACHABLE', '-118': 'CONNECTION_TIMED_OUT', '-130': 'PROXY_CONNECTION_FAILED', '-137': 'NAME_RESOLUTION_FAILED', '-138': 'NETWORK_ACCESS_DENIED', '-200': 'CERT_COMMON_NAME_INVALID',
  '-201': 'CERT_DATE_INVALID', '-202': 'CERT_AUTHORITY_INVALID', '-324': 'EMPTY_RESPONSE', '-337': 'HTTP2_PROTOCOL_ERROR', '-356': 'QUIC_PROTOCOL_ERROR' };
const starts = q(`SELECT ts, install, version, data FROM reports WHERE kind = 'start' AND ts >= ${since} ORDER BY ts`).map((r) => ({ ts: r.ts, install: r.install, version: r.version, ...JSON.parse(r.data) }));
console.log(`\n== App starts (${starts.length} attempts, ${new Set(starts.map((x) => x.install)).size} phones)`);
const byOutcome = {};
for (const x of starts) byOutcome[x.outcome] = (byOutcome[x.outcome] || 0) + 1;
console.log('  ' + (Object.entries(byOutcome).map(([o, n]) => `${OUTCOME[o] || o}: ${n}`).join(', ') || 'none yet'));
const okMs = starts.filter((x) => x.outcome === 1 || x.outcome === 2).map((x) => x.ms);
const past = starts.filter((x) => x.pastVpn);
if (past.length) console.log(`  tries past a VPN: ${past.length}, of them reached EduApp: ${past.filter((x) => x.outcome <= 2).length}`);
if (okMs.length) console.log(`  time to EduApp: median ${s(pct(okMs, 0.5))}, 90% ${s(pct(okMs, 0.9))}`);
// phones that never got in: their last attempts, with what is known about the phone and connection
const lastOk = new Map();
for (const x of starts) if (x.outcome === 1 || x.outcome === 2) lastOk.set(x.install, x.ts);
const bad = starts.filter((x) => x.outcome >= 3 && !(lastOk.get(x.install) > x.ts));
for (const x of bad.slice(-15)) {
  const conn = [x.online === 0 ? 'offline' : null, x.wifi ? 'Wi-Fi' : null, x.cell ? 'mobile' : null, x.vpn ? (x.pastVpn ? 'VPN (app went past it)' : 'VPN') : null, x.privDns ? 'private DNS' : null, x.saver ? 'data saver' : null, x.validated === 0 ? 'not validated' : null].filter(Boolean).join('+') || '?';
  console.log(`  ${new Date(x.ts).toISOString().slice(0, 16)}Z ${x.install.slice(0, 6)} v${x.version} Android sdk ${x.sdk} WebView ${x.wv}: ${OUTCOME[x.outcome] || x.outcome}` +
    (x.net ? ` net::ERR_${NET[x.net] || x.net}` : x.err ? ` (WebView error ${x.err})` : '') + ` after ${s(x.ms)}, try ${x.attempt}, ${conn}` + (x.age > 60 ? `, sent ${Math.round(x.age / 60)} min later` : '') +
    (x.dnsOk !== undefined ? ` | check: DNS ${x.dnsOk === 0 ? 'failed' : x.dnsLocal ? 'LOCAL (blocker)' : 'ok'}${x.dnsV6 ? ' v6' : ''}, direct ${x.http ? 'HTTP ' + x.http : 'error ' + x.httpErr}, proxy ${x.proxy || x.netProxy ? 'yes' : 'no'}${x.direct ? ', proxy bypassed' : ''}` : ''));
}

// ---------------------------------------------------------------- relay rooms (as the relay sees them)
const rooms = q(`SELECT room, MAX(members) AS peak, MAX(scouts) AS scouts, SUM(hints) AS hints, COUNT(*) AS snaps, MAX(ts) AS last FROM rooms WHERE ts >= ${since} GROUP BY room ORDER BY peak DESC`);
const now = q(`SELECT COUNT(DISTINCT room) AS rooms, SUM(members) AS members FROM rooms WHERE ts >= ${Date.now() - 12 * 60e3}`)[0] || {};
console.log(`\n== Relay rooms (lectures)`);
console.log(`  right now: ${n0(now.rooms)} rooms, ${n0(now.members)} phones connected`);
console.log(`  last ${hours} h: ${rooms.length} rooms; biggest: ` + (rooms.slice(0, 5).map((r) => `${r.room} peak ${r.peak} (scouts ${r.scouts}, hints ${r.hints})`).join('; ') || 'none'));
console.log('');
