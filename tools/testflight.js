// TestFlight through the App Store Connect API: see where builds are, and hand a new build to the external testers.
//   node tools/testflight.js status                 builds (internal / external / Apple's beta review), groups, public link
//   node tools/testflight.js distribute [build]     wait until the build (default: newest) is processed, set "What to
//                                                   test", add it to the external group and submit it for beta review
// Internal testers (the "Clicker Tests" group) get every build by themselves once Apple has processed it.
// The API key (an Admin key, never committed): environment ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 (the .p8 text) or
// ASC_KEY_PATH (its file), or locally ~/.config/eth-clicker/asc.json {"keyId","issuerId","keyPath"}. CI uses its secrets.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const APP = '6838506687';                                  // ETH Clicker in App Store Connect (ch.students.clicker)

function credentials() {
  let c = { keyId: process.env.ASC_KEY_ID, issuerId: process.env.ASC_ISSUER_ID, key: process.env.ASC_KEY_P8, keyPath: process.env.ASC_KEY_PATH };
  const local = path.join(os.homedir(), '.config', 'eth-clicker', 'asc.json');
  if ((!c.keyId || !c.issuerId) && fs.existsSync(local)) c = { ...JSON.parse(fs.readFileSync(local, 'utf8')), ...Object.fromEntries(Object.entries(c).filter(([, v]) => v)) };
  if (!c.key && c.keyPath) c.key = fs.readFileSync(c.keyPath, 'utf8');
  if (!c.keyId || !c.issuerId || !c.key) throw new Error('App Store Connect key missing (see the top of tools/testflight.js)');
  return c;
}
let cred = null;
function token() {
  cred = cred || credentials();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'ES256', kid: cred.keyId, typ: 'JWT' }), p = b64({ iss: cred.issuerId, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  return h + '.' + p + '.' + crypto.sign('sha256', Buffer.from(h + '.' + p), { key: cred.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}
async function api(method, p, body) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + p, { method, headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, json, text };
}
async function get(p) { const r = await api('GET', p); if (r.status >= 300) throw new Error(`GET ${p}: ${r.status} ${r.text.slice(0, 300)}`); return r.json; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function builds(limit = 5, number) {
  const j = await get(`/v1/builds?filter[app]=${APP}&sort=-uploadedDate&limit=${limit}` + (number ? `&filter[version]=${number}` : '') +
    '&include=preReleaseVersion,buildBetaDetail,betaAppReviewSubmission');
  const inc = new Map((j.included || []).map((x) => [x.type + ':' + x.id, x]));
  const rel = (b, k, t) => b.relationships[k].data && inc.get(t + ':' + b.relationships[k].data.id);
  return j.data.map((b) => ({
    id: b.id, number: b.attributes.version, uploaded: b.attributes.uploadedDate, processing: b.attributes.processingState, expired: b.attributes.expired,
    version: (rel(b, 'preReleaseVersion', 'preReleaseVersions') || { attributes: {} }).attributes.version,
    internal: (rel(b, 'buildBetaDetail', 'buildBetaDetails') || { attributes: {} }).attributes.internalBuildState,
    external: (rel(b, 'buildBetaDetail', 'buildBetaDetails') || { attributes: {} }).attributes.externalBuildState,
    review: (rel(b, 'betaAppReviewSubmission', 'betaAppReviewSubmissions') || { attributes: {} }).attributes.betaReviewState || null,
  }));
}
async function groups() {
  return (await get(`/v1/apps/${APP}/betaGroups`)).data.map((g) => ({ id: g.id, name: g.attributes.name, internal: g.attributes.isInternalGroup, link: g.attributes.publicLinkEnabled ? g.attributes.publicLink : null }));
}

async function status() {
  console.log('Builds (newest first):');
  for (const b of await builds(6)) {
    console.log(`  ${b.version} (${b.number})  uploaded ${b.uploaded.slice(0, 10)}  ${b.processing}${b.expired ? ' EXPIRED' : ''}  internal: ${b.internal || '-'}  external: ${b.external || '-'}  Apple review: ${b.review || 'not submitted'}`);
  }
  console.log('Groups:');
  for (const g of await groups()) {
    const t = await get(`/v1/betaGroups/${g.id}/betaTesters?limit=200`);
    console.log(`  ${g.name} (${g.internal ? 'internal: every build' : 'external: after Apple\'s review'})  ${t.data.length} tester(s)${g.link ? '  public link ' + g.link : ''}`);
  }
}

async function distribute(number, whatsNew) {
  // 1. wait for Apple's processing (usually 5–20 min after the upload)
  let b;
  for (let i = 0; ; i++) {
    [b] = await builds(1, number);
    if (b && b.processing === 'VALID') break;
    if (b && b.processing !== 'PROCESSING') throw new Error(`build ${b.number}: ${b.processing}`);
    if (i > 80) throw new Error(`build ${number || '(newest)'} not processed after 40 min`);
    console.log(b ? `build ${b.number}: processing…` : `build ${number}: not visible yet…`);
    await sleep(30_000);
  }
  console.log(`build ${b.version} (${b.number}) processed; internal testers: ${b.internal}`);
  // 2. "What to test" (shown to testers in the TestFlight app)
  const loc = (await get(`/v1/builds/${b.id}/betaBuildLocalizations`)).data.find((l) => l.attributes.locale === 'en-US');
  const text = whatsNew || `Version ${b.version}. Please report anything odd to the contact on the install page.`;
  const r1 = loc ? await api('PATCH', `/v1/betaBuildLocalizations/${loc.id}`, { data: { type: 'betaBuildLocalizations', id: loc.id, attributes: { whatsNew: text } } })
    : await api('POST', '/v1/betaBuildLocalizations', { data: { type: 'betaBuildLocalizations', attributes: { locale: 'en-US', whatsNew: text }, relationships: { build: { data: { type: 'builds', id: b.id } } } } });
  console.log('what to test:', r1.status < 300 ? 'set' : r1.status + ' ' + r1.text.slice(0, 200));
  // 3. the external group(s)
  for (const g of (await groups()).filter((x) => !x.internal)) {
    const r = await api('POST', `/v1/betaGroups/${g.id}/relationships/builds`, { data: [{ type: 'builds', id: b.id }] });
    console.log(`added to "${g.name}":`, r.status < 300 ? 'yes' : r.status + ' ' + r.text.slice(0, 200));
  }
  // 4. Apple's beta review (needed once per version; later builds of an approved version usually pass by themselves)
  if (b.review) { console.log('beta review: already', b.review); return; }
  const r = await api('POST', '/v1/betaAppReviewSubmissions', { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: b.id } } } } });
  console.log('beta review:', r.status < 300 ? 'submitted' : r.status + ' ' + r.text.slice(0, 300));
  if (r.status >= 300) process.exitCode = 1;
}

const [cmd, arg, ...rest] = process.argv.slice(2);
(cmd === 'status' ? status() : cmd === 'distribute' ? distribute(arg && /^\d+$/.test(arg) ? arg : undefined, rest.join(' ') || undefined)
  : Promise.resolve(console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 7).join('\n'))))
  .catch((e) => { console.error(e.message); process.exit(1); });
