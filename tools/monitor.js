// Beta monitoring: reads the anonymous diagnostics and relay snapshots from Cloudflare D1 (`clicker-metrics`).
//   node tools/monitor.js            last 24 hours (and 7-day testers)
//   node tools/monitor.js 72         last 72 hours
// Needs `npx wrangler login` on this PC (done). Reads only; never contacts ETH. Sums are computed in SQL (through the
// (kind, ts) index), so it stays quick with hundreds of users; what each section means: docs/OPERATIONS.md.
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
const now = Date.now();
const since = now - hours * 3600e3;
const KINDS = "kind IN ('period', 'question', 'start')";             // every query goes through the (kind, ts) index
const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const s = (ms) => ms == null ? '–' : (ms / 1000).toFixed(1) + ' s';
const n0 = (x) => Number(x) || 0;
const pc = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '–';
const J = (k) => `COALESCE(json_extract(data, '$.${k}'), 0)`;

// ---------------------------------------------------------------- testers
const testers = q(`SELECT platform, version, COUNT(DISTINCT install) AS n FROM reports WHERE ${KINDS} AND ts >= ${now - 7 * 86400e3} GROUP BY platform, version ORDER BY n DESC`);
const active = q(`SELECT platform, COUNT(DISTINCT install) AS n FROM reports WHERE ${KINDS} AND ts >= ${since} GROUP BY platform`);
console.log(`\n== Testers (installations that reported): last ${hours} h / last 7 days`);
for (const r of active) console.log(`  ${r.platform.padEnd(8)} ${String(r.n).padStart(5)} active`);
console.log('  by version, 7 days: ' + (testers.map((r) => `${r.platform} ${r.version}: ${r.n}`).join(', ') || 'none yet'));

// ---------------------------------------------------------------- questions (sampled in big rooms: p = share that reported)
const qs = q(`SELECT ${J('delay')} AS delay, ${J('hint')} AS hint, ${J('hidden')} AS hidden FROM reports WHERE kind = 'question' AND ts >= ${since}`);
console.log(`\n== Questions on screen (${qs.length} reports; in rooms over 20 students only a sample reports)`);
for (const [label, sel] of [['all', qs], ['via relay hint', qs.filter((x) => x.hint)], ['via own feed check', qs.filter((x) => !x.hint)], ['app in background', qs.filter((x) => x.hidden)]]) {
  const d = sel.map((x) => x.delay);
  if (d.length) console.log(`  ${label.padEnd(20)} n=${String(d.length).padStart(5)}  median ${s(pct(d, 0.5))}  90% ${s(pct(d, 0.9))}  worst ${s(Math.max(...d))}`);
}

// ---------------------------------------------------------------- periods: answers, ETH load, errors by platform
const sums = `SUM(${J('feed.n')}) AS fn, SUM(${J('feed.ok')}) AS fok, SUM(${J('feed.e5')}) AS f5, SUM(${J('feed.e429')}) AS f429, SUM(${J('feed.to')}) AS fto,
  SUM(${J('feed.net')}) AS fnet, SUM(${J('feed.auth')}) AS fauth, SUM(${J('feed.ms')} * ${J('feed.ok')}) AS fmsw, SUM(${J('detail.n')}) AS dn,
  SUM(${J('vote.n')}) AS vn, SUM(${J('vote.ok')}) AS vok, SUM(${J('vote.fail')}) AS vfail, SUM(${J('vote.att')}) AS vatt, SUM(${J('vote.ms')} * ${J('vote.ok')}) AS vmsw,
  AVG(${J('relay.open')}) AS ropen, SUM(${J('relay.hints')}) AS rhints, SUM(${J('relay.reads')}) AS rreads,
  SUM(${J('ctl.pause')}) AS cpause, SUM(${J('ctl.old')}) AS cold, SUM(CASE WHEN ${J('ctl.slow')} > 1 THEN 1 ELSE 0 END) AS cslow, COUNT(*) AS reports, COUNT(DISTINCT install) AS apps`;
const t = q(`SELECT ${sums} FROM reports WHERE kind = 'period' AND ts >= ${since}`)[0] || {};
const ferr = n0(t.f5) + n0(t.f429) + n0(t.fto) + n0(t.fnet);
console.log(`\n== Answers`);
console.log(`  sent ${n0(t.vn)}, accepted ${n0(t.vok)}, failed ${n0(t.vfail)}` + (t.vok ? `, avg ${s(t.vmsw / t.vok)}, avg attempts ${(t.vatt / t.vok).toFixed(2)}` : ''));
console.log(`\n== Load on ETH from Clicker users (activity feed = the expensive request)`);
console.log(`  feed checks ${n0(t.fn)} (${(n0(t.fn) / (hours * 3600)).toFixed(3)}/s on average), question reads ${n0(t.dn)}`);
console.log(`  feed answer time avg ${t.fok ? s(t.fmsw / t.fok) : '–'}; errors ${pc(ferr, t.fn)}: 5xx ${n0(t.f5)}, 429 ${n0(t.f429)}, timeouts ${n0(t.fto)}, network ${n0(t.fnet)}, login ${n0(t.fauth)}`);
// busiest hours: feed checks per second averaged over the hour (a period report covers ~10 min, so this is approximate)
const byHour = q(`SELECT strftime('%Y-%m-%d %H', ts / 1000, 'unixepoch') AS h, COUNT(DISTINCT install) AS apps, SUM(${J('feed.n')}) AS n,
  SUM(${J('feed.ok')}) AS ok, SUM(${J('feed.ms')} * ${J('feed.ok')}) AS msw, SUM(${J('feed.e5')} + ${J('feed.e429')} + ${J('feed.to')}) AS err
  FROM reports WHERE kind = 'period' AND ts >= ${since} GROUP BY h ORDER BY n DESC LIMIT 5`);
for (const b of byHour) console.log(`  ${b.h}:00 UTC  ${String(b.apps).padStart(5)} apps  ${(n0(b.n) / 3600).toFixed(2)} feed checks/s  ETH answer avg ${b.ok ? s(b.msw / b.ok) : '–'}  errors ${n0(b.err)}`);
// by platform and version: a bad release shows up here first
const byVer = q(`SELECT platform, version, ${sums} FROM reports WHERE kind = 'period' AND ts >= ${since} GROUP BY platform, version ORDER BY apps DESC LIMIT 12`);
if (byVer.length) console.log(`\n== By platform and version (period reports)`);
for (const r of byVer) {
  const e = n0(r.f5) + n0(r.f429) + n0(r.fto) + n0(r.fnet);
  console.log(`  ${(r.platform + ' ' + r.version).padEnd(16)} ${String(r.apps).padStart(5)} apps  feed ${String(n0(r.fn)).padStart(7)}  errors ${pc(e, r.fn).padStart(6)}  answers ${n0(r.vok)}/${n0(r.vn)}  relay ${(n0(r.ropen) * 100).toFixed(0)}%`);
}
console.log(`\n== Relay (as the apps see it)`);
console.log(`  connected ${(n0(t.ropen) * 100).toFixed(0)}% of the time; hints received ${n0(t.rhints)}, question reads because of hints ${n0(t.rreads)}`);
console.log(`\n== Remote control (install/control.json) as the apps applied it`);
console.log(`  period reports under pause ${n0(t.cpause)}, too old (below "min") ${n0(t.cold)}, slowed ${n0(t.cslow)} (of ${n0(t.reports)})`);

// ---------------------------------------------------------------- app starts (Android: did EduApp open at all?)
const OUTCOME = { 1: 'ok', 2: 'login shown', 3: 'load error', 4: 'no answer 30 s', 5: 'clicker failed to start', 6: 'page process died' };
const NET = { '-2': 'FAILED', '-3': 'ABORTED', '-7': 'TIMED_OUT', '-10': 'ACCESS_DENIED', '-20': 'BLOCKED_BY_CLIENT', '-21': 'NETWORK_CHANGED', '-100': 'CONNECTION_CLOSED', '-101': 'CONNECTION_RESET',
  '-102': 'CONNECTION_REFUSED', '-103': 'CONNECTION_ABORTED', '-104': 'CONNECTION_FAILED', '-105': 'NAME_NOT_RESOLVED', '-106': 'INTERNET_DISCONNECTED', '-107': 'SSL_PROTOCOL_ERROR',
  '-109': 'ADDRESS_UNREACHABLE', '-118': 'CONNECTION_TIMED_OUT', '-130': 'PROXY_CONNECTION_FAILED', '-137': 'NAME_RESOLUTION_FAILED', '-138': 'NETWORK_ACCESS_DENIED', '-200': 'CERT_COMMON_NAME_INVALID',
  '-201': 'CERT_DATE_INVALID', '-202': 'CERT_AUTHORITY_INVALID', '-324': 'EMPTY_RESPONSE', '-337': 'HTTP2_PROTOCOL_ERROR', '-356': 'QUIC_PROTOCOL_ERROR' };
const outcomes = q(`SELECT ${J('outcome')} AS o, COUNT(*) AS n, COUNT(DISTINCT install) AS phones FROM reports WHERE kind = 'start' AND ts >= ${since} GROUP BY o`);
const okMs = q(`SELECT ${J('ms')} AS ms FROM reports WHERE kind = 'start' AND ts >= ${since} AND ${J('outcome')} IN (1, 2) ORDER BY ts DESC LIMIT 5000`).map((r) => r.ms);
console.log(`\n== App starts (Android)`);
console.log('  ' + (outcomes.map((r) => `${OUTCOME[r.o] || r.o}: ${r.n} (${r.phones} phones)`).join(', ') || 'none yet'));
if (okMs.length) console.log(`  time to EduApp: median ${s(pct(okMs, 0.5))}, 90% ${s(pct(okMs, 0.9))}`);
// phones whose latest start failed: what is known about the phone and connection
const bad = q(`SELECT r.ts, r.install, r.version, r.data FROM reports r WHERE r.kind = 'start' AND r.ts >= ${since}
  AND r.ts = (SELECT MAX(ts) FROM reports WHERE kind = 'start' AND install = r.install AND ts >= ${since})
  AND json_extract(r.data, '$.outcome') >= 3 ORDER BY r.ts DESC LIMIT 15`).map((r) => ({ ts: r.ts, install: r.install, version: r.version, ...JSON.parse(r.data) }));
for (const x of bad) {
  const conn = [x.online === 0 ? 'offline' : null, x.wifi ? 'Wi-Fi' : null, x.cell ? 'mobile' : null, x.vpn ? 'VPN' : null, x.privDns ? 'private DNS' : null, x.saver ? 'data saver' : null, x.validated === 0 ? 'not validated' : null].filter(Boolean).join('+') || '?';
  console.log(`  ${new Date(x.ts).toISOString().slice(0, 16)}Z ${x.install.slice(0, 6)} v${x.version} Android sdk ${x.sdk} WebView ${x.wv}: ${OUTCOME[x.outcome] || x.outcome}` +
    (x.net ? ` net::ERR_${NET[x.net] || x.net}` : x.err ? ` (WebView error ${x.err})` : '') + ` after ${s(x.ms)}, try ${x.attempt}, ${conn}` + (x.age > 60 ? `, sent ${Math.round(x.age / 60)} min later` : '') +
    (x.dnsOk !== undefined ? ` | check: DNS ${x.dnsOk === 0 ? 'failed' : x.dnsLocal ? 'LOCAL (blocker)' : 'ok'}${x.dnsV6 ? ' v6' : ''}, direct ${x.http ? 'HTTP ' + x.http : 'error ' + x.httpErr}, proxy ${x.proxy || x.netProxy ? 'yes' : 'no'}` : ''));
}

// ---------------------------------------------------------------- relay rooms (as the relay sees them)
const rooms = q(`SELECT room, MAX(members) AS peak, MAX(scouts) AS scouts, SUM(hints) AS hints, COUNT(*) AS snaps FROM rooms WHERE ts >= ${since} GROUP BY room ORDER BY peak DESC`);
// right now: the latest snapshot of each room from the last 6 minutes (rooms write one every 5 minutes while in use)
const live = q(`SELECT COUNT(*) AS rooms, SUM(members) AS members FROM rooms r WHERE r.ts >= ${now - 6 * 60e3}
  AND r.ts = (SELECT MAX(ts) FROM rooms WHERE room = r.room AND ts >= ${now - 6 * 60e3})`)[0] || {};
console.log(`\n== Relay rooms (lectures)`);
console.log(`  in the last 6 min: ${n0(live.rooms)} rooms in use, ${n0(live.members)} phones at their latest snapshot (a room that just emptied may still count)`);
console.log(`  last ${hours} h: ${rooms.length} rooms; biggest: ` + (rooms.slice(0, 5).map((r) => `${r.room} peak ${r.peak} (scouts ${r.scouts}, hints ${r.hints})`).join('; ') || 'none'));
// several phones for a long time and never a hint: no question in that lecture, or the course's hints don't reach its room
const quiet = rooms.filter((r) => r.peak >= 3 && r.snaps >= 6 && !n0(r.hints));
if (quiet.length) console.log(`  ${quiet.length} room(s) with 3+ phones for 30+ min and no hint at all (no question, or hints not reaching the room?): ${quiet.slice(0, 5).map((r) => r.room).join(', ')}`);

// ---------------------------------------------------------------- quotas (Cloudflare free plan; see docs/OPERATIONS.md)
const today = new Date(now).toISOString().slice(0, 10);
const day = q(`SELECT (SELECT COUNT(*) FROM reports WHERE ${KINDS} AND ts >= ${Date.parse(today)}) AS reports, (SELECT COUNT(*) FROM rooms WHERE ts >= ${Date.parse(today)}) AS rooms`)[0] || {};
console.log(`\n== Today (UTC) against the free plan`);
console.log(`  D1 rows written ≈ ${2 * (n0(day.reports) + n0(day.rooms))} of 100,000 (each row + its index); Worker requests from reports ${n0(day.reports)} of 100,000 (plus relay connections: see the Cloudflare dashboard)`);
console.log('');
