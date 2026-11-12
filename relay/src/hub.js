// Fast Clicker hint relay: the platform-neutral core.
//
// The Hub does no I/O of its own. A host (node-server.js, worker.js, or a test)
// hands it connections `{ id, ip, send(text), close(code, reason) }` and their
// text frames, and calls `tick()` about every 100 ms. Time comes from an
// injectable `now()` so tests can drive the clock.
//
// The relay only ever sees opaque room ids and tiny "clicker K changed" hints.
// It stores nothing durable and logs nothing about rooms, IPs or hints.

/** Defaults; every one can be overridden with `new Hub({ limits: { ... } })`. */
export const DEFAULT_LIMITS = Object.freeze({
  MAX_FRAME_BYTES: 600,
  MAX_ROOMS_PER_CONN: 8,
  POLL_EVERY_MS: 1000, // `every` in roster: target aggregate ETH poll interval

  DEDUPE_MS: 10 * 60_000, // same activity id `a` in a room is dropped for 10 min
  DEDUPE_MAX: 300, // ...remembering at most this many ids per room
  REPLAY_MS: 30_000, // hints replayed to a connection that newly joins a room

  RATE_WINDOW_MS: 60_000, // all rate limits below are per rolling minute
  CONN_HINTS_PER_MIN: 20,
  CONN_MSGS_PER_MIN: 60,
  CONN_CLOSE_FACTOR: 3, // more than 3x CONN_MSGS_PER_MIN -> connection closed
  ROOM_HINTS_PER_MIN: 30,
  SAME_EVENT_MS: 1000, // per room+clicker: one accepted hint per event type per second
  ERR_EVERY_MS: 10_000, // each `err` code is sent at most once per 10 s per connection

  // A lecture hall on campus Wi-Fi can sit behind one or a few shared addresses, so this cannot be small:
  // it only stops a single address from taking the whole relay. Abuse is held back by the rate limits.
  MAX_CONNS_PER_IP: 700,
  MAX_CONNS: 2000,
  MAX_MEMBERS_PER_ROOM: 600,
  MAX_ROOMS: 200,

  IDLE_MS: 120_000, // nothing received for this long -> closed
  ROSTER_COALESCE_MS: 300, // at most one roster broadcast per room per 300 ms
  SWEEP_MS: 5_000, // how often tick() runs the (O(connections + rooms)) sweep
});

/** WebSocket upgrades with an Origin header must carry one of these. */
export const ALLOWED_ORIGINS = Object.freeze(['https://eduapp.ethz.ch']);

/** Close codes (4000-4999 is the application range, valid in every runtime). */
export const CLOSE = Object.freeze({
  FULL: 4000,
  RATE: 4001,
  BINARY: 4002,
  IDLE: 4003,
  SEND_FAILED: 4004,
  INTERNAL: 4005,
});

const ROOM_RE = /^[0-9a-f]{16,64}$/;
const EVENT_RE = /^[A-Z_]{1,32}$/;
// "ISO timestamp, at most 32 chars". We only allow the characters an ISO date
// can contain (plus space) so the relay never fans out arbitrary text.
const TS_RE = /^[0-9A-Za-z:.+\- ]{1,32}$/;

const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const utf8 = new TextEncoder();

/** Timestamps of recent events inside a rolling window, capped in length. */
class RollingWindow {
  constructor(windowMs, cap) {
    this.windowMs = windowMs;
    this.cap = cap;
    this.times = [];
  }
  count(now) {
    const t = this.times;
    let i = 0;
    while (i < t.length && now - t[i] >= this.windowMs) i++;
    if (i) t.splice(0, i);
    return t.length;
  }
  add(now) {
    this.times.push(now);
    if (this.times.length > this.cap) this.times.shift();
  }
}

export class Hub {
  constructor({ now = () => Date.now(), limits = {} } = {}) {
    this.now = now;
    this.L = { ...DEFAULT_LIMITS, ...limits };
    this.conns = new Map(); // conn object -> ConnState
    this.ipCounts = new Map(); // ip -> open connections
    this.rooms = new Map(); // room id -> Room
    this.dirty = new Set(); // rooms whose roster broadcast is pending
    this.lastSweep = now();
    this.failed = []; // connections whose send() threw; closed after the current step
    this.internalErrors = 0;
  }

  /** Counts only; safe to expose on /health. */
  stats() {
    return { connections: this.conns.size, rooms: this.rooms.size };
  }

  // ---------------------------------------------------------------- lifecycle

  /** Registers a connection. Returns false (after `err full` + close) if over capacity. */
  connect(conn) {
    const L = this.L;
    if (this.conns.has(conn)) return true;
    const ip = String(conn.ip || 'unknown');
    if (this.conns.size >= L.MAX_CONNS || (this.ipCounts.get(ip) || 0) >= L.MAX_CONNS_PER_IP) {
      safeSend(conn, '{"t":"err","code":"full"}');
      safeClose(conn, CLOSE.FULL, 'full');
      return false;
    }
    const now = this.now();
    this.conns.set(conn, {
      conn,
      ip,
      lastSeen: now,
      scout: false,
      rooms: new Set(), // room ids
      lastRoster: new Map(), // room id -> "n/slot" last sent to this connection
      msgs: new RollingWindow(L.RATE_WINDOW_MS, L.CONN_MSGS_PER_MIN * L.CONN_CLOSE_FACTOR + 1),
      hints: new RollingWindow(L.RATE_WINDOW_MS, L.CONN_HINTS_PER_MIN),
      lastErr: new Map(), // code -> time
    });
    this.ipCounts.set(ip, (this.ipCounts.get(ip) || 0) + 1);
    return true;
  }

  /** Forgets a connection and leaves all its rooms. Idempotent. */
  disconnect(conn) {
    const st = this.conns.get(conn);
    if (!st) return;
    this.conns.delete(conn);
    const left = (this.ipCounts.get(st.ip) || 1) - 1;
    if (left > 0) this.ipCounts.set(st.ip, left);
    else this.ipCounts.delete(st.ip);
    for (const id of st.rooms) this._leave(st, id);
    st.rooms.clear();
    this._flushDue();
    this._closeFailed();
  }

  /** One incoming frame. `data` is a string for text frames; anything else is binary. */
  message(conn, data) {
    const st = this.conns.get(conn);
    if (!st) return; // unknown or already closed: ignore
    try {
      this._message(st, data);
    } catch {
      // Should be unreachable; never let a frame take the hub down.
      this.internalErrors++;
      this._kick(st, CLOSE.INTERNAL, 'internal');
    }
    this._closeFailed();
  }

  /** Housekeeping: call every ~100 ms. Flushes coalesced rosters; sweeps every SWEEP_MS. */
  tick() {
    this._flushDue();
    const now = this.now();
    if (now - this.lastSweep < this.L.SWEEP_MS) return;
    this.lastSweep = now;
    for (const st of this.conns.values()) {
      if (now - st.lastSeen >= this.L.IDLE_MS) this._kick(st, CLOSE.IDLE, 'idle');
    }
    for (const room of this.rooms.values()) {
      this._prune(room, now);
      this._maybeDrop(room);
    }
    this._closeFailed();
  }

  // ---------------------------------------------------------------- messages

  _message(st, data) {
    const L = this.L;
    const now = this.now();
    st.lastSeen = now;
    if (typeof data !== 'string') return this._kick(st, CLOSE.BINARY, 'binary');

    // Every frame, good or bad, counts toward the message limit.
    const seen = st.msgs.count(now) + 1;
    st.msgs.add(now);
    if (seen > L.CONN_MSGS_PER_MIN * L.CONN_CLOSE_FACTOR) return this._kick(st, CLOSE.RATE, 'rate');
    if (seen > L.CONN_MSGS_PER_MIN) return this._err(st, 'rate');

    // Cheap length check first (UTF-8 bytes >= UTF-16 units), exact bytes after.
    if (data.length > L.MAX_FRAME_BYTES || utf8.encode(data).length > L.MAX_FRAME_BYTES) {
      return this._err(st, 'bad');
    }
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return this._err(st, 'bad');
    }
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return this._err(st, 'bad');

    switch (m.t) {
      case 'ping':
        return this._send(st, JSON.stringify({ t: 'pong', now }));
      case 'join':
        return this._join(st, m, now);
      case 'hint':
        return this._hint(st, m, now);
      default:
        return this._err(st, 'bad');
    }
  }

  _join(st, m, now) {
    const L = this.L;
    const { rooms } = m;
    if (!Array.isArray(rooms) || rooms.length > L.MAX_ROOMS_PER_CONN) return this._err(st, 'bad');
    if (m.scout !== undefined && typeof m.scout !== 'boolean') return this._err(st, 'bad');
    for (const id of rooms) if (typeof id !== 'string' || !ROOM_RE.test(id)) return this._err(st, 'bad');
    const want = [...new Set(rooms)];
    const scout = m.scout === true;

    // Capacity is checked for the whole request before anything changes.
    const entering = want.filter((id) => !st.rooms.has(id));
    let creating = 0;
    for (const id of entering) {
      const room = this.rooms.get(id);
      if (!room) creating++;
      else if (room.members.size >= L.MAX_MEMBERS_PER_ROOM) return this._full(st);
    }
    if (creating && !this._makeRoomFor(creating, want)) return this._full(st);

    // Apply: leave dropped rooms, update the scout flag, enter new rooms.
    const wantSet = new Set(want);
    for (const id of [...st.rooms]) {
      if (!wantSet.has(id)) {
        st.rooms.delete(id);
        this._leave(st, id);
      }
    }
    const scoutChanged = st.scout !== scout;
    st.scout = scout;
    if (scoutChanged) {
      for (const id of st.rooms) {
        const room = this.rooms.get(id);
        if (scout) room.scouts.push(st); // becoming a scout = joining the scout order now
        else removeFrom(room.scouts, st);
        this._markDirty(room);
      }
    }
    for (const id of entering) {
      let room = this.rooms.get(id);
      if (!room) {
        room = newRoom(id, L);
        this.rooms.set(id, room);
      }
      room.members.add(st);
      room.lastActive = now;
      st.rooms.add(id);
      if (scout) {
        room.scouts.push(st);
        this._markDirty(room);
      }
    }

    // Direct reply: one roster per requested room, then replays for new rooms.
    for (const id of want) this._sendRoster(st, this.rooms.get(id), now);
    for (const id of entering) {
      const room = this.rooms.get(id);
      for (const h of room.replay) {
        if (now - h.now <= L.REPLAY_MS) this._send(st, JSON.stringify({ ...h, replay: true }));
      }
    }
    this._flushDue();
  }

  _hint(st, m, now) {
    const L = this.L;
    const { room: id, k, e, a, c } = m;
    if (
      typeof id !== 'string' || !ROOM_RE.test(id) ||
      !isPosInt(k) || !isPosInt(a) ||
      typeof e !== 'string' || !EVENT_RE.test(e) ||
      typeof c !== 'string' || !TS_RE.test(c)
    ) {
      return this._err(st, 'bad');
    }
    if (!st.rooms.has(id)) return this._err(st, 'room');
    if (st.hints.count(now) >= L.CONN_HINTS_PER_MIN) return this._err(st, 'rate');
    st.hints.add(now);

    const room = this.rooms.get(id);
    const seenAt = room.dedupe.get(a);
    if (seenAt !== undefined && now - seenAt < L.DEDUPE_MS) return; // duplicate: silent
    if (room.hints.count(now) >= L.ROOM_HINTS_PER_MIN) return this._err(st, 'rate');
    const evKey = k + ':' + e;
    const lastEv = room.lastEvent.get(evKey);
    if (lastEv !== undefined && now - lastEv < L.SAME_EVENT_MS) return this._err(st, 'rate');

    // Accepted.
    room.hints.add(now);
    room.lastEvent.set(evKey, now);
    room.dedupe.delete(a); // (only present if expired) keep Map order == accept time
    room.dedupe.set(a, now);
    if (room.dedupe.size > L.DEDUPE_MAX) room.dedupe.delete(room.dedupe.keys().next().value);
    room.lastActive = now;
    // `now` on a hint is the relay's accept time, also when replayed later.
    const out = { t: 'hint', room: id, k, e, a, c, now };
    room.replay.push(out);
    pruneReplay(room, now, L);

    const text = JSON.stringify(out);
    for (const member of room.members) if (member !== st) this._send(member, text);
  }

  // ---------------------------------------------------------------- rooms and rosters

  _leave(st, id) {
    const room = this.rooms.get(id);
    st.lastRoster.delete(id);
    if (!room) return;
    room.members.delete(st);
    room.lastActive = this.now();
    if (removeFrom(room.scouts, st)) this._markDirty(room);
    this._maybeDrop(room);
  }

  _markDirty(room) {
    this.dirty.add(room);
  }

  /** Broadcasts rosters for dirty rooms whose coalescing window has passed. */
  _flushDue() {
    if (!this.dirty.size) return;
    const now = this.now();
    for (const room of this.dirty) {
      if (now - room.lastFlush < this.L.ROSTER_COALESCE_MS) continue;
      this.dirty.delete(room);
      room.lastFlush = now;
      // O(members): slot lookup via a Map built once, and members whose
      // (n, slot) did not change are skipped.
      const slots = new Map(room.scouts.map((s, i) => [s, i]));
      for (const member of room.members) this._sendRoster(member, room, now, slots);
    }
  }

  _sendRoster(st, room, now, slots) {
    const n = room.scouts.length;
    const slot = slots ? (slots.has(st) ? slots.get(st) : -1) : room.scouts.indexOf(st);
    const key = n + '/' + slot;
    if (slots && st.lastRoster.get(room.id) === key) return;
    st.lastRoster.set(room.id, key);
    this._send(
      st,
      JSON.stringify({ t: 'roster', room: room.id, n, slot, m: room.members.size, every: this.L.POLL_EVERY_MS, now }),
    );
  }

  /** Ensures `count` new rooms fit, evicting idle empty rooms (oldest first) if needed. */
  _makeRoomFor(count, keep) {
    const over = this.rooms.size + count - this.L.MAX_ROOMS;
    if (over <= 0) return true;
    const keepSet = new Set(keep);
    const empty = [...this.rooms.values()]
      .filter((r) => r.members.size === 0 && !keepSet.has(r.id))
      .sort((x, y) => x.lastActive - y.lastActive);
    if (empty.length < over) return false;
    for (let i = 0; i < over; i++) this._dropRoom(empty[i]);
    return true;
  }

  _prune(room, now) {
    const L = this.L;
    for (const [a, t] of room.dedupe) {
      if (now - t < L.DEDUPE_MS) break; // Map is in accept-time order
      room.dedupe.delete(a);
    }
    for (const [key, t] of room.lastEvent) if (now - t >= L.SAME_EVENT_MS) room.lastEvent.delete(key);
    pruneReplay(room, now, L);
  }

  /** Empty rooms go away once nothing they remember is still needed. */
  _maybeDrop(room) {
    if (room.members.size === 0 && room.dedupe.size === 0 && room.replay.length === 0) this._dropRoom(room);
  }

  _dropRoom(room) {
    this.rooms.delete(room.id);
    this.dirty.delete(room);
  }

  // ---------------------------------------------------------------- output

  _send(st, text) {
    if (st.failed) return;
    try {
      st.conn.send(text);
    } catch {
      // A broken socket must not affect anyone else. It is dropped once the
      // current fan-out loop is done, so loops never see members vanish mid-way.
      st.failed = true;
      this.failed.push(st);
    }
  }

  _closeFailed() {
    while (this.failed.length) {
      const st = this.failed.pop();
      this._kick(st, CLOSE.SEND_FAILED, 'send');
    }
  }

  _err(st, code) {
    const now = this.now();
    const last = st.lastErr.get(code);
    if (last !== undefined && now - last < this.L.ERR_EVERY_MS) return;
    st.lastErr.set(code, now);
    this._send(st, '{"t":"err","code":"' + code + '"}');
  }

  _full(st) {
    safeSend(st.conn, '{"t":"err","code":"full"}');
    this._kick(st, CLOSE.FULL, 'full');
  }

  /** Closes and forgets a connection right away (the host's later disconnect is a no-op). */
  _kick(st, code, reason) {
    if (!this.conns.has(st.conn)) return;
    this.disconnect(st.conn);
    safeClose(st.conn, code, reason);
  }
}

function newRoom(id, L) {
  return {
    id,
    members: new Set(), // ConnState
    scouts: [], // ConnState in scout order; index == slot
    dedupe: new Map(), // activity id -> accept time (insertion order == time order)
    replay: [], // accepted hints from the last REPLAY_MS
    hints: new RollingWindow(L.RATE_WINDOW_MS, L.ROOM_HINTS_PER_MIN),
    lastEvent: new Map(), // "k:e" -> last accept time
    lastFlush: -Infinity,
    lastActive: 0,
  };
}

function pruneReplay(room, now, L) {
  const r = room.replay;
  let i = 0;
  while (i < r.length && now - r[i].now > L.REPLAY_MS) i++;
  if (r.length - i > L.ROOM_HINTS_PER_MIN) i = r.length - L.ROOM_HINTS_PER_MIN;
  if (i) r.splice(0, i);
}

function removeFrom(arr, item) {
  const i = arr.indexOf(item);
  if (i < 0) return false;
  arr.splice(i, 1);
  return true;
}

function safeSend(conn, text) {
  try {
    conn.send(text);
  } catch {}
}

function safeClose(conn, code, reason) {
  try {
    conn.close(code, reason);
  } catch {}
}
