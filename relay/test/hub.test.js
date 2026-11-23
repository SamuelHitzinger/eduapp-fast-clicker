// Unit tests of the Hub with a fake clock and fake connections.
import { test, assert } from './lib.js';
import { Hub, CLOSE, DEFAULT_LIMITS } from '../src/hub.js';

const R1 = 'a'.repeat(16);
const R2 = 'b'.repeat(32);
const R3 = 'c'.repeat(64);

function setup(limits = {}) {
  const clock = { t: 1_000_000 };
  const hub = new Hub({ now: () => clock.t, limits });
  let ids = 0;
  const conn = (ip = `10.0.0.${++ids}`) => {
    const c = {
      id: ++ids,
      ip,
      out: [],
      closed: null,
      send(text) {
        if (this.closed) throw new Error('closed');
        this.out.push(JSON.parse(text));
      },
      close(code, reason) {
        this.closed = { code, reason };
      },
      take(t) {
        const got = this.out.filter((m) => !t || m.t === t);
        this.out = this.out.filter((m) => t && m.t !== t);
        return got;
      },
    };
    hub.connect(c);
    return c;
  };
  const say = (c, obj) => hub.message(c, typeof obj === 'string' ? obj : JSON.stringify(obj));
  const join = (c, rooms, scout = false) => say(c, { t: 'join', rooms, scout });
  let nextA = 1000;
  const hint = (c, room, extra = {}) =>
    say(c, { t: 'hint', room, k: 322454, e: 'ACTIVITY_STARTED', a: nextA++, c: '2026-11-12T10:15:00.000Z', ...extra });
  const advance = (ms) => {
    clock.t += ms;
    hub.tick();
  };
  return { hub, clock, conn, say, join, hint, advance };
}

/** Structural invariants that must hold after anything. */
function check(hub) {
  let ipTotal = 0;
  for (const n of hub.ipCounts.values()) ipTotal += n;
  assert.equal(ipTotal, hub.conns.size, 'ip counts match connections');
  for (const st of hub.conns.values()) {
    assert.ok(st.rooms.size <= hub.L.MAX_ROOMS_PER_CONN);
    for (const id of st.rooms) {
      const room = hub.rooms.get(id);
      assert.ok(room, 'joined room exists');
      assert.ok(room.members.has(st), 'member listed in room');
      assert.equal(room.scouts.includes(st), st.scout, 'scout flag matches room scout list');
    }
  }
  for (const room of hub.rooms.values()) {
    for (const st of room.members) {
      assert.ok(hub.conns.has(st.conn), 'room member is connected');
      assert.ok(st.rooms.has(room.id), 'room listed in member');
    }
    assert.equal(new Set(room.scouts).size, room.scouts.length, 'no duplicate scouts');
    for (const st of room.scouts) assert.ok(room.members.has(st), 'scout is member');
    assert.ok(room.members.size <= hub.L.MAX_MEMBERS_PER_ROOM);
  }
  assert.ok(hub.rooms.size <= hub.L.MAX_ROOMS);
}

// ------------------------------------------------------------------ join / roster

test('join sends one roster per room with the documented fields', () => {
  const { hub, conn, join, clock } = setup();
  const a = conn();
  join(a, [R1, R2]);
  const r = a.take('roster');
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { t: 'roster', room: R1, n: 0, slot: -1, m: 1, every: 1000, now: clock.t });
  assert.equal(r[1].room, R2);
  check(hub);
});

test('scout slots are dense in join order and shift when a scout leaves', () => {
  const { hub, conn, join, advance } = setup();
  const [a, b, c, x] = [conn(), conn(), conn(), conn()];
  join(x, [R1]);
  join(a, [R1], true);
  advance(400);
  join(b, [R1], true);
  advance(400);
  join(c, [R1], true);
  advance(400);
  const last = (k) => k.take('roster').at(-1);
  assert.deepEqual([last(a).slot, last(b).slot, last(c).slot], [0, 1, 2]);
  const rx = last(x);
  assert.deepEqual([rx.n, rx.slot], [3, -1]);

  join(a, []); // a leaves: b and c shift down
  advance(400);
  const [rb, rc] = [last(b), last(c)];
  assert.deepEqual([rb.n, rb.slot], [2, 0]);
  assert.deepEqual([rc.n, rc.slot], [2, 1]);
  assert.equal(last(x).n, 2);
  assert.equal(a.take('roster').length, 0, 'a left, gets nothing for R1');
  check(hub);
});

test('dropping the scout flag frees the slot; regaining it appends at the end', () => {
  const { hub, conn, join, advance } = setup();
  const [a, b, c] = [conn(), conn(), conn()];
  join(a, [R1], true);
  join(b, [R1], true);
  join(c, [R1], true);
  advance(400);
  for (const k of [a, b, c]) k.take();

  join(a, [R1], false); // e.g. tab hidden
  const own = a.take('roster');
  assert.deepEqual([own.at(-1).n, own.at(-1).slot], [2, -1]);
  advance(400);
  assert.deepEqual(b.take('roster').map((m) => [m.n, m.slot]), [[2, 0]]);
  assert.deepEqual(c.take('roster').map((m) => [m.n, m.slot]), [[2, 1]]);
  assert.equal(a.take('roster').length, 0, 'no duplicate roster for unchanged state');

  join(a, [R1], true); // tab visible again: last in scout order
  assert.deepEqual(a.take('roster').map((m) => [m.n, m.slot]), [[3, 2]]);
  advance(400);
  assert.deepEqual(b.take('roster').map((m) => [m.n, m.slot]), [[3, 0]]);
  check(hub);
});

test('roster broadcasts are coalesced to one per room per 300 ms (latest state wins)', () => {
  const { hub, conn, join, advance } = setup();
  const x = conn();
  join(x, [R1]);
  advance(400); // (x's own arrival is a change too)
  x.take();
  const scouts = [conn(), conn(), conn(), conn()];
  join(scouts[0], [R1], true); // first change: broadcast immediately
  assert.deepEqual(x.take('roster').map((m) => m.n), [1]);
  advance(50);
  join(scouts[1], [R1], true);
  advance(50);
  join(scouts[2], [R1], true);
  advance(50);
  join(scouts[3], [R1], true);
  advance(100); // t = +250: still inside the window
  assert.equal(x.take('roster').length, 0);
  advance(60); // t = +310
  assert.deepEqual(x.take('roster').map((m) => m.n), [4]);
  advance(1000);
  assert.equal(x.take('roster').length, 0, 'nothing more without changes');
  check(hub);
});

test('re-join replaces the room set (left rooms forget the connection)', () => {
  const { hub, conn, join, hint, advance } = setup();
  const a = conn();
  const b = conn();
  join(a, [R1, R2], true);
  join(b, [R1, R2, R3]);
  advance(400);
  join(a, [R2, R3], true);
  advance(400);
  assert.deepEqual([...hub.conns.get(a).rooms].sort(), [R2, R3].sort());
  assert.equal(hub.rooms.get(R1).members.size, 1);
  assert.equal(hub.rooms.get(R1).scouts.length, 0);
  assert.equal(hub.rooms.get(R3).scouts.length, 1);
  b.take();
  hint(a, R1);
  assert.deepEqual(a.take('err'), [{ t: 'err', code: 'room' }]);
  assert.equal(b.take('hint').length, 0);
  a.take();
  join(a, []);
  assert.equal(hub.conns.get(a).rooms.size, 0);
  assert.equal(a.take('roster').length, 0, 'empty join sends no roster');
  check(hub);
});

test('duplicate room ids in one join are collapsed', () => {
  const { hub, conn, join } = setup();
  const a = conn();
  join(a, [R1, R1, R1], true);
  assert.equal(a.take('roster').length, 1);
  assert.equal(hub.rooms.get(R1).scouts.length, 1);
  check(hub);
});

// ------------------------------------------------------------------ hints

test('hint fans out to every member except the sender, with server time', () => {
  const { hub, conn, join, hint, clock } = setup();
  const [a, b, c] = [conn(), conn(), conn()];
  for (const k of [a, b, c]) join(k, [R1]);
  for (const k of [a, b, c]) k.take();
  hint(a, R1, { a: 77, e: 'ACTIVITY_STARTED', k: 5 });
  const expect = { t: 'hint', room: R1, k: 5, e: 'ACTIVITY_STARTED', a: 77, c: '2026-11-12T10:15:00.000Z', now: clock.t };
  assert.deepEqual(b.take(), [expect]);
  assert.deepEqual(c.take(), [expect]);
  assert.deepEqual(a.take(), [], 'sender gets nothing back');
  check(hub);
});

test('rooms are isolated', () => {
  const { conn, join, hint } = setup();
  const [a, b, c] = [conn(), conn(), conn()];
  join(a, [R1, R2]);
  join(b, [R1]);
  join(c, [R2]);
  for (const k of [a, b, c]) k.take();
  hint(a, R2);
  assert.equal(b.take('hint').length, 0);
  assert.equal(c.take('hint').length, 1);
});

test('hint for a room not joined is rejected with err room', () => {
  const { conn, join, hint } = setup();
  const [a, b] = [conn(), conn()];
  join(a, [R1]);
  join(b, [R2]);
  a.take();
  b.take();
  hint(a, R2);
  assert.deepEqual(a.take(), [{ t: 'err', code: 'room' }]);
  assert.equal(b.take().length, 0);
});

test('dedupe: same activity id in a room is dropped for 10 minutes', () => {
  const { conn, join, hint, advance } = setup({ IDLE_MS: 1e9 });
  const [a, b, c] = [conn(), conn(), conn()];
  for (const k of [a, b, c]) join(k, [R1]);
  for (const k of [a, b, c]) k.take();
  hint(a, R1, { a: 5, e: 'ACTIVITY_STARTED' });
  advance(2000);
  hint(b, R1, { a: 5, e: 'ACTIVITY_STARTED' }); // second scout saw it too
  hint(a, R1, { a: 5, e: 'OTHER_EVENT' }); // dedupe key is `a` alone
  assert.equal(c.take('hint').length, 1);
  assert.equal(b.take('err').length + a.take('err').length, 0, 'dropped silently');
  advance(DEFAULT_LIMITS.DEDUPE_MS);
  hint(b, R1, { a: 5 });
  assert.equal(c.take('hint').length, 1, 'accepted again after expiry');
});

test('dedupe memory is capped per room', () => {
  const { hub, conn, join, hint, advance } = setup({ DEDUPE_MAX: 5, ROOM_HINTS_PER_MIN: 1000, CONN_HINTS_PER_MIN: 1000, CONN_MSGS_PER_MIN: 1000 });
  const a = conn();
  join(a, [R1]);
  for (let i = 1; i <= 8; i++) {
    hint(a, R1, { a: i, k: i });
    advance(1);
  }
  assert.deepEqual([...hub.rooms.get(R1).dedupe.keys()], [4, 5, 6, 7, 8]);
});

test('replay: new joiners get the last 30 s of hints, oldest first, marked replay', () => {
  const { conn, join, hint, advance, clock } = setup();
  const a = conn();
  join(a, [R1, R2]);
  const t0 = clock.t;
  hint(a, R1, { a: 1, k: 1 });
  advance(10_000);
  hint(a, R1, { a: 2, k: 2 });
  advance(15_000);
  hint(a, R2, { a: 3, k: 3 });
  const b = conn();
  join(b, [R1]);
  const got = b.take('hint');
  assert.deepEqual(got.map((h) => [h.a, h.replay, h.room]), [[1, true, R1], [2, true, R1]]);
  assert.equal(got[0].now, t0, 'replayed hint keeps its accept time');

  // Already in R1: a re-join (e.g. scout toggle) must not replay R1 again,
  // but newly added R2 is replayed.
  join(b, [R1, R2], true);
  assert.deepEqual(b.take('hint').map((h) => h.a), [3]);

  advance(21_000); // hint 1 is now 46 s old, hint 2 36 s, hint 3 21 s
  const c = conn();
  join(c, [R1, R2]);
  assert.deepEqual(c.take('hint').map((h) => h.a), [3]);
});

// ------------------------------------------------------------------ rate limits

test('per-connection hint limit: 10 per rolling minute', () => {
  const { conn, join, hint, advance } = setup();
  const [a, b] = [conn(), conn()];
  join(a, [R1]);
  join(b, [R1]);
  b.take();
  a.take();
  for (let i = 0; i < 11; i++) hint(a, R1, { k: i + 1 });
  assert.equal(b.take('hint').length, 10);
  assert.deepEqual(a.take('err'), [{ t: 'err', code: 'rate' }]);
  advance(60_000);
  hint(a, R1, { k: 999 });
  assert.equal(b.take('hint').length, 1, 'window rolls');
});

test('per-connection message limit: 60/min dropped, >180/min closed', () => {
  const { hub, conn, say } = setup();
  const a = conn();
  for (let i = 0; i < 60; i++) say(a, { t: 'ping' });
  assert.equal(a.take('pong').length, 60);
  say(a, { t: 'ping' });
  assert.equal(a.take('pong').length, 0, '61st dropped');
  assert.deepEqual(a.take('err'), [{ t: 'err', code: 'rate' }]);
  for (let i = 62; i <= 180; i++) say(a, { t: 'ping' });
  assert.equal(a.closed, null);
  say(a, { t: 'ping' }); // 181st
  assert.equal(a.closed.code, CLOSE.RATE);
  assert.equal(hub.conns.size, 0);
  check(hub);
});

test('per-room hint limit: 20 accepted per rolling minute', () => {
  const { conn, join, hint } = setup();
  const [a, b, c, x] = [conn(), conn(), conn(), conn()];
  for (const k of [a, b, c, x]) join(k, [R1]);
  x.take();
  for (let i = 0; i < 8; i++) hint(a, R1, { k: 100 + i });
  for (let i = 0; i < 8; i++) hint(b, R1, { k: 200 + i });
  for (let i = 0; i < 8; i++) hint(c, R1, { k: 300 + i });
  assert.equal(x.take('hint').length, 20);
  assert.deepEqual(c.take('err'), [{ t: 'err', code: 'rate' }]);
});

test('per-room+clicker limit: one accepted hint per event type per second', () => {
  const { conn, join, hint, advance } = setup();
  const [a, x] = [conn(), conn()];
  join(a, [R1]);
  join(x, [R1]);
  x.take();
  hint(a, R1, { k: 1, e: 'ACTIVITY_STARTED' });
  hint(a, R1, { k: 1, e: 'ACTIVITY_STARTED' }); // new `a`, same k+e within 1 s
  hint(a, R1, { k: 1, e: 'ACTIVITY_ENDED' }); // other event type: fine
  hint(a, R1, { k: 2, e: 'ACTIVITY_STARTED' }); // other clicker: fine
  assert.equal(x.take('hint').length, 3);
  advance(1000);
  hint(a, R1, { k: 1, e: 'ACTIVITY_STARTED' });
  assert.equal(x.take('hint').length, 1);
});

// ------------------------------------------------------------------ capacity

test('capacity: connections per IP (limit set to 5 here)', () => {
  const { hub, conn } = setup({ MAX_CONNS_PER_IP: 5 });
  const same = Array.from({ length: 5 }, () => conn('1.2.3.4'));
  assert.ok(same.every((c) => !c.closed));
  const sixth = conn('1.2.3.4');
  assert.deepEqual(sixth.out, [{ t: 'err', code: 'full' }]);
  assert.equal(sixth.closed.code, CLOSE.FULL);
  assert.equal(conn('5.6.7.8').closed, null, 'other IPs unaffected');
  hub.disconnect(same[0]);
  assert.equal(conn('1.2.3.4').closed, null, 'slot freed on disconnect');
  check(hub);
});

test('capacity: total connections', () => {
  const { hub, conn } = setup({ MAX_CONNS: 3 });
  conn();
  conn();
  conn();
  const fourth = conn();
  assert.equal(fourth.closed.code, CLOSE.FULL);
  assert.equal(hub.conns.size, 3);
  check(hub);
});

test('capacity: members per room', () => {
  const { hub, conn, join } = setup({ MAX_MEMBERS_PER_ROOM: 2 });
  const [a, b, c] = [conn(), conn(), conn()];
  join(a, [R1]);
  join(b, [R1]);
  join(c, [R2]);
  c.take();
  join(c, [R2, R1]);
  assert.deepEqual(c.take(), [{ t: 'err', code: 'full' }]);
  assert.equal(c.closed.code, CLOSE.FULL);
  assert.equal(hub.rooms.get(R1).members.size, 2);
  assert.equal(hub.rooms.has(R2), false, 'c fully cleaned up');
  check(hub);
});

test('capacity: rooms (idle empty rooms are evicted first)', () => {
  const { hub, conn, join, hint } = setup({ MAX_ROOMS: 2 });
  const [a, b, c] = [conn(), conn(), conn()];
  join(a, [R1]);
  hint(a, R1); // R1 now remembers a hint, so it outlives its members
  join(a, []);
  assert.ok(hub.rooms.has(R1), 'empty room kept for dedupe');
  join(b, [R2]);
  join(c, [R3]); // over the cap, but R1 is empty: evicted
  assert.equal(c.closed, null);
  assert.deepEqual([...hub.rooms.keys()].sort(), [R2, R3]);
  const d = conn();
  join(d, ['d'.repeat(16)]);
  assert.equal(d.closed.code, CLOSE.FULL);
  assert.deepEqual(d.take(), [{ t: 'err', code: 'full' }]);
  check(hub);
});

// ------------------------------------------------------------------ bad input

test('malformed frames: err bad at most once per 10 s, state untouched', () => {
  const { hub, conn, say, join, advance } = setup();
  const a = conn();
  join(a, [R1], true);
  a.take();
  const junk = [
    'not json',
    '{"t":',
    'null',
    '42',
    '"join"',
    '[]',
    '{}',
    '{"t":"nope"}',
    '{"t":"join"}',
    '{"t":"join","rooms":"' + R1 + '"}',
    '{"t":"join","rooms":["ABCDEFABCDEFABCDEF"]}',
    '{"t":"join","rooms":["abc"]}',
    '{"t":"join","rooms":["' + 'a'.repeat(65) + '"]}',
    JSON.stringify({ t: 'join', rooms: Array.from({ length: 9 }, (_, i) => String(i).repeat(16)) }),
    JSON.stringify({ t: 'join', rooms: [R1], scout: 'yes' }),
    JSON.stringify({ t: 'join', rooms: [R1, 5] }),
    JSON.stringify({ t: 'hint', room: R1, k: '1', e: 'X', a: 1, c: 'x' }),
    JSON.stringify({ t: 'hint', room: R1, k: 1.5, e: 'X', a: 1, c: 'x' }),
    JSON.stringify({ t: 'hint', room: R1, k: -1, e: 'X', a: 1, c: 'x' }),
    JSON.stringify({ t: 'hint', room: R1, k: 1, e: 'lower', a: 1, c: 'x' }),
    JSON.stringify({ t: 'hint', room: R1, k: 1, e: 'X'.repeat(33), a: 1, c: 'x' }),
    JSON.stringify({ t: 'hint', room: R1, k: 1, e: 'X', a: 0, c: 'x' }),
    JSON.stringify({ t: 'hint', room: R1, k: 1, e: 'X', a: 1, c: 'x'.repeat(33) }),
    JSON.stringify({ t: 'hint', room: R1, k: 1, e: 'X', a: 1, c: '<script>' }),
    JSON.stringify({ t: 'hint', room: R1, k: 1, e: 'X', a: 1 }),
    JSON.stringify({ t: 'hint', room: R1, k: 2 ** 60, e: 'X', a: 1, c: 'x' }),
    '{"t":"hint","__proto__":{"room":"' + R1 + '","k":1,"e":"X","a":1,"c":"x"}}',
    '{"t":{"toString":1}}',
  ];
  for (const j of junk) assert.doesNotThrow(() => say(a, j), j);
  assert.deepEqual(a.take(), [{ t: 'err', code: 'bad' }], 'exactly one err in 10 s');
  assert.deepEqual([...hub.conns.get(a).rooms], [R1], 'room set unchanged');
  assert.equal(hub.rooms.get(R1).scouts.length, 1);
  advance(10_000);
  say(a, 'still not json');
  assert.deepEqual(a.take(), [{ t: 'err', code: 'bad' }]);
  check(hub);
});

test('oversized frames (by UTF-8 bytes) are rejected; 600 bytes is fine', () => {
  const { conn, say } = setup();
  const a = conn();
  const pad = (s, n) => s.replace('"t":"ping"', '"t":"ping","x":"' + 'x'.repeat(n - s.length - 7) + '"');
  const ok = pad('{"t":"ping"}', 600);
  assert.equal(Buffer.byteLength(ok), 600);
  say(a, ok);
  assert.equal(a.take('pong').length, 1);
  say(a, pad('{"t":"ping"}', 601));
  assert.deepEqual(a.take(), [{ t: 'err', code: 'bad' }]);
  // 300 UTF-16 units but 900 bytes
  say(a, '{"t":"ping","x":"' + 'é'.repeat(400) + '"}');
  assert.equal(a.take('pong').length, 0);
});

test('binary frames close the connection', () => {
  const { hub, conn, join } = setup();
  const a = conn();
  join(a, [R1], true);
  hub.message(a, new Uint8Array([123, 125]));
  assert.equal(a.closed.code, CLOSE.BINARY);
  assert.equal(hub.conns.size, 0);
  assert.equal(hub.rooms.size, 0);
});

test('fuzz: random frames never throw and never corrupt state', () => {
  const { hub, conn, say, advance } = setup({ CONN_MSGS_PER_MIN: 100_000, CONN_HINTS_PER_MIN: 100_000 });
  let seed = 42;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const rooms = [R1, R2, R3, 'f'.repeat(20), 'BAD', 7, null];
  const vals = [0, 1, -1, 2.5, 'x', '', null, true, [], {}, 'ACTIVITY_STARTED', '2026-11-12T10:00:00Z', 1e300];
  const pick = (arr) => arr[rnd(arr.length)];
  const conns = Array.from({ length: 12 }, () => conn());
  for (let i = 0; i < 5000; i++) {
    const c = pick(conns);
    const kind = rnd(6);
    let frame;
    if (kind === 0) frame = { t: 'join', rooms: Array.from({ length: rnd(4) }, () => pick(rooms)), scout: rnd(3) ? !!rnd(2) : pick(vals) };
    else if (kind === 1) frame = { t: 'hint', room: pick(rooms), k: rnd(4) ? rnd(5) + 1 : pick(vals), e: rnd(4) ? 'E' + 'X'.repeat(rnd(3)) : pick(vals), a: rnd(4) ? rnd(50) + 1 : pick(vals), c: rnd(4) ? '2026-11-12T10:00:00Z' : pick(vals) };
    else if (kind === 2) frame = { t: 'ping' };
    else if (kind === 3) frame = String.fromCharCode(...Array.from({ length: rnd(40) }, () => rnd(128)));
    else if (kind === 4) frame = { t: pick(vals), rooms: pick(vals) };
    else frame = rnd(10) ? { t: 'ping' } : new Uint8Array(3);
    if (frame instanceof Uint8Array) hub.message(c, frame);
    else assert.doesNotThrow(() => say(c, frame));
    if (c.closed) conns[conns.indexOf(c)] = conn();
    if (rnd(20) === 0) advance(rnd(400));
    if (i % 250 === 0) check(hub);
  }
  check(hub);
  assert.equal(hub.internalErrors, 0);
});

// ------------------------------------------------------------------ liveness / cleanup

test('idle connections are closed after 120 s; pinging ones stay', () => {
  const { hub, conn, say, join, advance } = setup();
  const [quiet, chatty] = [conn(), conn()];
  join(quiet, [R1], true);
  join(chatty, [R1], true);
  for (let t = 0; t < 4; t++) {
    advance(40_000);
    say(chatty, { t: 'ping' });
  }
  assert.equal(quiet.closed.code, CLOSE.IDLE);
  assert.equal(chatty.closed, null);
  assert.deepEqual(hub.rooms.get(R1).scouts.map((s) => s.conn), [chatty]);
  advance(400);
  assert.deepEqual(chatty.take('roster').map((m) => [m.n, m.slot]).at(-1), [1, 0], 'survivor told its new slot');
  check(hub);
});

test('a connection whose send throws is dropped without affecting others', () => {
  const { hub, conn, join, hint } = setup();
  const [a, bad, c] = [conn(), conn(), conn()];
  for (const k of [a, bad, c]) join(k, [R1], true);
  c.take();
  bad.send = () => {
    throw new Error('socket gone');
  };
  hint(a, R1);
  assert.equal(c.take('hint').length, 1);
  assert.equal(hub.conns.has(bad), false);
  assert.equal(hub.rooms.get(R1).scouts.length, 2);
  check(hub);
});

test('disconnect cleanup: nothing leaks after everyone leaves', () => {
  const { hub, conn, join, hint, advance } = setup();
  const conns = Array.from({ length: 20 }, (_, i) => conn(`9.9.9.${i % 4}`));
  conns.forEach((c, i) => join(c, [R1, i % 2 ? R2 : R3], i % 3 === 0));
  hint(conns[0], R1);
  advance(400);
  for (const c of conns) hub.disconnect(c);
  hub.disconnect(conns[0]); // twice is harmless
  assert.equal(hub.conns.size, 0);
  assert.equal(hub.ipCounts.size, 0);
  assert.deepEqual([...hub.rooms.keys()], [R1], 'only the room with dedupe data remains');
  assert.equal(hub.rooms.get(R1).members.size, 0);
  advance(DEFAULT_LIMITS.DEDUPE_MS + DEFAULT_LIMITS.SWEEP_MS);
  assert.equal(hub.rooms.size, 0);
  assert.equal(hub.dirty.size, 0);
  hub.message(conns[1], '{"t":"ping"}'); // frames from gone connections are ignored
  assert.equal(conns[1].take('pong').length, 0);
});

test('scale: 600 members in one room stay cheap', () => {
  const { hub, conn, join, hint, advance } = setup({ MAX_CONNS_PER_IP: 10_000 });
  const t0 = performance.now();
  const members = Array.from({ length: 600 }, () => conn('1.1.1.1'));
  members.forEach((c, i) => {
    join(c, [R1], i % 2 === 0);
    if (i % 50 === 0) advance(100);
  });
  advance(400);
  hint(members[0], R1);
  join(members[0], []); // slot 0 leaves: 299 scouts shift
  advance(400);
  const ms = performance.now() - t0;
  assert.equal(members[1].out.filter((m) => m.t === 'hint').length, 1);
  assert.equal(hub.rooms.get(R1).scouts.length, 299);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  check(hub);
});

// ---------------------------------------------------------------- v3.3: rooms on Cloudflare (one per Durable Object)

test('only the first MAX_ACTIVE_SCOUTS scouts get a slot; a standby moves up when one leaves', () => {
  const { hub, conn, join, advance } = setup({ MAX_ACTIVE_SCOUTS: 2 });
  const [a, b, c] = [conn(), conn(), conn()];
  join(a, [R1], true); advance(400);
  join(b, [R1], true); advance(400);
  join(c, [R1], true); advance(400);
  assert.deepEqual([a, b, c].map((x) => [x.out.at(-1).n, x.out.at(-1).slot]), [[2, 0], [2, 1], [2, -1]]);
  join(a, [], false); advance(400);
  assert.deepEqual([b, c].map((x) => [x.out.at(-1).n, x.out.at(-1).slot]), [[2, 0], [2, 1]], 'standby c took the free slot');
  check(hub);
});

test('a connection bound to a room (its URL) cannot join or hint another one', () => {
  const { hub, conn, join, hint } = setup();
  const a = conn();
  a.onlyRoom = R2;
  join(a, [R1], true);
  assert.deepEqual(a.take('err').map((m) => m.code), ['room']);
  assert.equal(hub.rooms.size, 0);
  join(a, [R2], true);
  assert.equal(a.take('roster').length, 1);
  hint(a, R1);
  assert.equal(hub.rooms.has(R1), false, 'nothing reached another room (the error itself is rate-limited)');
  check(hub);
});

test('restore() after an eviction puts members and scout order back without sending anything', () => {
  const states = new Map();
  const first = setup();
  first.hub.onConnState = (c, s) => states.set(c, s);
  const conns = [first.conn(), first.conn(), first.conn()];
  first.join(conns[2], [R1], true); first.advance(400);
  first.join(conns[0], [R1], true); first.advance(400);
  first.join(conns[1], [R1], false); first.advance(400);
  conns.forEach((c) => c.take());
  // a fresh hub (the object was evicted), fed what the host kept
  const again = new Hub({ now: () => first.clock.t });
  again.restore(conns.map((c) => ({ conn: c, ...states.get(c) })).reverse());
  assert.equal(conns.reduce((n, c) => n + c.out.length, 0), 0, 'nothing sent on restore');
  assert.deepEqual(again.rooms.get(R1).scouts.map((s) => s.conn), [conns[2], conns[0]], 'scout order kept');
  // a change afterwards reaches only those whose slot changes
  again.message(conns[2], JSON.stringify({ t: 'join', rooms: [], scout: false }));
  again.tick();
  assert.deepEqual(conns[0].take('roster').map((m) => [m.n, m.slot]), [[1, 0]]);
  assert.deepEqual(conns[1].take('roster').map((m) => [m.n, m.slot]), [[1, -1]], 'members learn the new count once');
  assert.equal(conns[0].take('roster').length, 0, 'no repeats');
  check(again);
});

test('a room remembers accepted hints across an eviction: duplicates stay dropped, late joiners get the replay', () => {
  let mem = null;
  const first = setup();
  first.hub.onRoomMemory = (id, m) => { mem = JSON.parse(JSON.stringify(m)); };
  const a = first.conn(), b = first.conn();
  first.join(a, [R1], true); first.join(b, [R1], true);
  first.hint(a, R1, { a: 777 });
  assert.ok(mem && mem.dedupe.length === 1, 'stored after the accepted hint');
  const again = new Hub({ now: () => first.clock.t + 5000, loadRoomMemory: () => mem });
  const c = { ip: '1', out: [], send(t) { this.out.push(JSON.parse(t)); }, close() {} };
  const d = { ip: '2', out: [], send(t) { this.out.push(JSON.parse(t)); }, close() {} };
  again.connect(c); again.connect(d);
  again.message(c, JSON.stringify({ t: 'join', rooms: [R1], scout: true }));
  assert.equal(c.out.filter((m) => m.t === 'hint' && m.replay).length, 1, 'replayed to the late joiner');
  again.message(d, JSON.stringify({ t: 'join', rooms: [R1], scout: true }));
  d.out.length = 0; c.out.length = 0;
  again.message(d, JSON.stringify({ t: 'hint', room: R1, k: 322454, e: 'ACTIVITY_STARTED', a: 777, c: '2026-11-12T10:15:00.000Z' }));
  assert.equal(c.out.filter((m) => m.t === 'hint').length, 0, 'the same activity is still a duplicate');
  check(again);
});

test('nextDueAt() tells a host without a timer when a coalesced roster is due', () => {
  const { hub, clock, conn, join } = setup();
  const [a, b] = [conn(), conn()];
  assert.equal(hub.nextDueAt(), clock.t + DEFAULT_LIMITS.JOIN_DEADLINE_MS, 'not joined yet: closed if they never do');
  join(a, [R1], true);            // first change goes out at once
  join(b, [R1], true);            // within 300 ms: coalesced
  assert.equal(hub.nextDueAt(), clock.t + DEFAULT_LIMITS.ROSTER_COALESCE_MS);
  clock.t = hub.nextDueAt();
  hub.tick();
  assert.equal(hub.nextDueAt(), null);
  assert.deepEqual(a.out.at(-1).n, 2);
});

test('a connection that never joins is closed after JOIN_DEADLINE_MS; a joined one is not', () => {
  const { hub, conn, join, advance } = setup({ IDLE_MS: 1e9 });
  const lazy = conn(), ok = conn();
  join(ok, [R1], false);
  advance(DEFAULT_LIMITS.JOIN_DEADLINE_MS + 10);
  assert.equal(lazy.closed && lazy.closed.code, CLOSE.IDLE);
  assert.equal(ok.closed, null);
  assert.equal(hub.nextDueAt(), null);
  check(hub);
});

test('standby members hear when the room has grown noticeably (they check on their own less often)', () => {
  const { conn, join, advance } = setup();
  const watcher = conn();
  join(watcher, [R1], false);
  advance(400);
  watcher.take();
  for (let i = 0; i < 99; i++) { join(conn(), [R1], false); if (i % 10 === 0) advance(50); }
  advance(400);
  const seen = watcher.take('roster').map((m) => m.m);
  assert.ok(seen.length >= 1 && seen.length <= 15, `told ${seen.length} times`);
  assert.equal(seen.at(-1), 100);
});

test('a scout that enters a room later is restored behind the ones already there', () => {
  const states = new Map();
  const { hub, clock, conn, join, advance } = setup();
  hub.onConnState = (c, s) => states.set(c, s);
  const a = conn(), b = conn();
  join(a, [], true);           // a scout with no room yet
  join(b, [R1], true); advance(400);
  join(a, [R1], true); advance(400);
  assert.deepEqual(hub.rooms.get(R1).scouts.map((s) => s.conn), [b, a]);
  const again = new Hub({ now: () => clock.t });
  again.restore([a, b].map((c) => ({ conn: c, ...states.get(c) })));
  assert.deepEqual(again.rooms.get(R1).scouts.map((s) => s.conn), [b, a]);
});

test('one network gets at most MAX_SCOUTS_PER_NET active slots; others from elsewhere still get theirs', () => {
  const { hub, conn, join, advance } = setup({ MAX_SCOUTS_PER_NET: 2, MAX_ACTIVE_SCOUTS: 4 });
  const squat = [conn('2001:db8:1:2::a'), conn('2001:db8:1:2::b'), conn('2001:db8:1:2:ffff::1')]; // one /64
  for (const c of squat) { join(c, [R1], true); advance(400); }
  const real = [conn('10.1.1.1'), conn('10.2.2.2')];
  for (const c of real) { join(c, [R1], true); advance(400); }
  const slot = (c) => c.out.filter((m) => m.t === 'roster').at(-1).slot;
  assert.deepEqual(squat.map(slot), [0, 1, -1], 'third connection of the same /64 stands by');
  assert.deepEqual(real.map(slot), [2, 3]);
  assert.equal(real[0].out.filter((m) => m.t === 'roster').at(-1).n, 4);
  check(hub);
});
