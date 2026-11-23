// Integration test: real `ws` clients against a real server.
// By default starts src/node-server.js on a random port. Set RELAY_URL
// (e.g. http://127.0.0.1:8787 from `wrangler dev`) to test another server.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { test, assert } from './lib.js';

// room ids as the clients make them (32 hex digits); every connection is for one room: /v1/room/<id>
const R1 = '0123456789abcdef0123456789abcdef';
const R2 = 'fedcba9876543210fedcba9876543210';
let base; // http://host:port
let child;

export async function start() {
  if (process.env.RELAY_URL) {
    base = process.env.RELAY_URL.replace(/\/$/, '');
    return;
  }
  const script = fileURLToPath(new URL('../src/node-server.js', import.meta.url));
  child = spawn(process.execPath, [script], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /listening on :(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error('server exited ' + code)));
  });
  base = `http://127.0.0.1:${port}`;
}

export async function stop() {
  if (child) child.kill();
}

/** A ws client that records every message and lets tests await specific ones. */
function client(room = R1, headers = {}) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/v1/room/' + room, { headers });
  const msgs = [];
  const waiters = [];
  ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    msgs.push(m);
    for (const w of [...waiters]) w();
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  return {
    ws,
    msgs,
    closed,
    open: () => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }),
    send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    /** Resolves with the first not-yet-taken message matching `pred`. */
    next(pred, ms = 3000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const i = msgs.findIndex(pred);
          if (i < 0) return false;
          const [m] = msgs.splice(i, 1);
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(m);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error('timeout waiting for message; have ' + JSON.stringify(msgs)));
        }, ms);
        waiters.push(check);
        check();
      });
    },
  };
}

const health = async () => (await fetch(base + '/health')).json();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('GET /health says ok and at most counts (Cloudflare: nothing else)', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  for (const k of Object.keys(body)) assert.ok(['ok', 'connections', 'rooms'].includes(k), k);
});

test('other paths and malformed room ids are 404', async () => {
  for (const p of ['/', '/v2', '/v1/room/', '/v1/room/xyz', '/v1/room/' + 'A'.repeat(32), '/v1/room/' + 'a'.repeat(31), '/v1/room/' + R1 + '/x']) {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + p);
    const r = await new Promise((resolve) => { ws.once('open', () => resolve('open')); ws.once('error', (e) => resolve(String(e.message))); });
    if (ws.readyState !== WebSocket.CLOSED) await new Promise((resolve) => { ws.once('close', resolve); ws.terminate(); });
    assert.match(r, /404/, p);
  }
});

test('foreign Origin is refused; eduapp origin and no origin are allowed', async () => {
  const bad = client(R1, { Origin: 'https://evil.example' });
  await assert.rejects(bad.open(), /403/);
  const good = client(R1, { Origin: 'https://eduapp.ethz.ch' });
  await good.open();
  const none = client();
  await none.open();
  good.ws.close();
  none.ws.close();
  await Promise.all([good.closed, none.closed]);
});

test('join, roster, hint fan-out (not to sender), replay, ping', async () => {
  const a = client();
  const b = client();
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'join', rooms: [R1], scout: true });
  const ra = await a.next((m) => m.t === 'roster');
  assert.deepEqual([ra.room, ra.n, ra.slot, ra.m, ra.every], [R1, 1, 0, 1, 1000]);
  assert.equal(typeof ra.now, 'number');

  b.send({ t: 'join', rooms: [R1, R2], scout: true });            // a connection is for its own room only
  assert.ok(['room', 'bad'].includes((await b.next((m) => m.t === 'err')).code));   // refused (Cloudflare: one room per connection)
  b.send({ t: 'join', rooms: [R1], scout: true });
  const rb = await b.next((m) => m.t === 'roster' && m.room === R1);
  assert.deepEqual([rb.n, rb.slot, rb.m], [2, 1, 2]);
  const ra2 = await a.next((m) => m.t === 'roster' && m.n === 2); // coalesced broadcast
  assert.equal(ra2.slot, 0);

  a.send({ t: 'hint', room: R1, k: 322454, e: 'ACTIVITY_STARTED', a: 991, c: '2026-11-12T10:15:00Z' });
  const h = await b.next((m) => m.t === 'hint');
  assert.deepEqual([h.room, h.k, h.e, h.a, h.c, h.replay], [R1, 322454, 'ACTIVITY_STARTED', 991, '2026-11-12T10:15:00Z', undefined]);

  const other = client(R2);                                       // another room hears nothing of it
  await other.open();
  other.send({ t: 'join', rooms: [R2], scout: true });
  await other.next((m) => m.t === 'roster');

  const late = client();
  await late.open();
  late.send({ t: 'join', rooms: [R1], scout: false });
  const rep = await late.next((m) => m.t === 'hint');
  assert.equal(rep.replay, true);
  assert.equal(rep.a, 991);

  a.send({ t: 'ping' });
  await a.next((m) => m.t === 'pong');                            // (Cloudflare answers pings without the room)
  await delay(100);
  assert.equal(a.msgs.filter((m) => m.t === 'hint').length, 0, 'sender got no echo');
  assert.equal(other.msgs.filter((m) => m.t === 'hint').length, 0, 'other room got nothing');

  for (const c of [a, b, late, other]) c.ws.close();
  await Promise.all([a.closed, b.closed, late.closed, other.closed]);
});

test('oversized and malformed frames get err bad; binary frames close', async () => {
  const a = client();
  await a.open();
  a.send('{"t":"ping","pad":"' + 'x'.repeat(700) + '"}');
  assert.deepEqual(await a.next((m) => m.t === 'err'), { t: 'err', code: 'bad' });
  a.send('hello');
  a.send({ t: 'ping' });
  await a.next((m) => m.t === 'pong'); // still served; second err suppressed
  assert.equal(a.msgs.filter((m) => m.t === 'err').length, 0);
  a.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  assert.equal(await a.closed, 4002);
});

test('all connections gone after clients close', async () => {
  for (let i = 0; i < 50; i++) {
    const s = await health();
    if (s.connections === undefined || s.connections === 0) return;   // (Cloudflare's /health has no counts)
    await delay(50);
  }
  assert.fail('connections did not drop to 0');
});
