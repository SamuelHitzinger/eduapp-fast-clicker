// Runs the hint relay on Cloudflare Workers: one Durable Object per room.
//
// A room is one course's lecture (its id is a hash the clients make; the relay never learns the course). Each
// room is its own Durable Object, so rooms never compete with each other and there is no global connection cap:
// the relay grows with the number of lectures, not the number of students.
//
// The objects use the WebSocket Hibernation API: between messages a room is evicted from memory while its
// sockets stay connected, so it costs nothing while idle. Keep-alive pings are answered by the platform without
// waking it. Everything the hub needs after a wake-up is kept outside memory: each socket's rooms and scout
// order in its attachment, and the room's recent hints (dedupe, 30 s replay) in storage, written only when a
// hint is accepted (a few times per lecture).
import { DurableObject } from 'cloudflare:workers';
import { Hub, ALLOWED_ORIGINS, ROOM_LIMITS, ROOM_ID_RE } from './hub.js';

const PING = '{"t":"ping"}';
const PONG = '{"t":"pong"}';
const SNAPSHOT_MS = 5 * 60_000; // a busy room writes one line of numbers to the metrics database every 5 minutes

// ---------------------------------------------------------------- anonymous beta diagnostics (POST /v1/report)
// The apps report numbers about themselves (timings, counts) every ~10 minutes and when a question opens: no names,
// logins, questions or answers. Stored in D1 (`clicker-metrics`), read with `node tools/monitor.js`.
const REPORT_MAX_BYTES = 4096;
const PLATFORMS = new Set(['ios', 'android', 'web', 'addon']);
const KINDS = new Set(['period', 'question', 'start']);   // start: how an app's attempt to open EduApp ended
const recent = new Map(); // ip -> [window start, count] (best effort, per Worker instance)
function cleanData(o, depth = 0) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (!/^[A-Za-z0-9_]{1,24}$/.test(k) || ++n > 60) return null;
    if (typeof v === 'number') { if (!Number.isFinite(v)) return null; out[k] = Math.round(v * 1000) / 1000; }
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else if (v && typeof v === 'object' && depth === 0) { const c = cleanData(v, 1); if (!c) return null; out[k] = c; }
    else return null;                                       // no strings: nothing but numbers can be stored
  }
  return out;
}
async function report(request, env) {
  const cors = { 'access-control-allow-origin': 'https://eduapp.ethz.ch', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const origin = request.headers.get('Origin');
  if (origin !== null && !ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });
  const ip = request.headers.get('CF-Connecting-IP') || '?';
  const now = Date.now();
  const r = recent.get(ip);
  if (r && now - r[0] < 60_000) { if (++r[1] > 30) return new Response(null, { status: 429, headers: cors }); } else recent.set(ip, [now, 1]);
  if (recent.size > 5000) recent.clear();
  const text = await request.text();
  if (!env.METRICS || text.length > REPORT_MAX_BYTES) return new Response(null, { status: 413, headers: cors });
  let m;
  try { m = JSON.parse(text); } catch { return new Response(null, { status: 400, headers: cors }); }
  const data = m && cleanData(m.data);
  if (!data || !/^[0-9a-f]{16}$/.test(m.install) || !PLATFORMS.has(m.platform) || !KINDS.has(m.kind) || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(m.version)) {
    return new Response(null, { status: 400, headers: cors });
  }
  await env.METRICS.prepare('INSERT INTO reports (ts, day, install, platform, version, kind, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(now, new Date(now).toISOString().slice(0, 10), m.install, m.platform, m.version, m.kind, JSON.stringify(data)).run().catch(() => {});
  if (Math.random() < 0.01) {                                  // kept 90 days, then deleted
    const old = now - 90 * 86400e3;
    await env.METRICS.batch([env.METRICS.prepare('DELETE FROM reports WHERE ts < ?').bind(old), env.METRICS.prepare('DELETE FROM rooms WHERE ts < ?').bind(old)]).catch(() => {});
  }
  return new Response(null, { status: 204, headers: cors });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/v1/report' && (request.method === 'POST' || request.method === 'OPTIONS')) return report(request, env);
    const m = /^\/v1\/room\/([^/]+)$/.exec(url.pathname);
    if (!m || !ROOM_ID_RE.test(m[1])) return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const origin = request.headers.get('Origin');
    if (origin !== null && !ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(request);
  },
};

export class RelayRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = null;
    this.room = null;
    this.conns = new Map(); // WebSocket -> conn handed to the hub
    this.memory = null; // the room's recent hints, as last stored
    this.alarmAt = null; // when the next alarm is set for (null: none)
    this.snap = { at: 0, hints: 0 }; // last metrics snapshot, hints accepted since
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    ctx.blockConcurrencyWhile(async () => {
      this.memory = (await ctx.storage.get('mem')) || null;
      this.alarmAt = await ctx.storage.getAlarm();         // a roster broadcast was pending when the room went to sleep
      this.snap = (await ctx.storage.get('snap')) || { at: 0, hints: 0 };
    });
  }

  /** The hub for this room, rebuilt silently from the sockets' attachments after a wake-up. */
  ensureHub(room, { quiet = true } = {}) {
    if (this.hub) return this.hub;
    if (this.alarmAt != null) quiet = false;               // something was still to be told: tell everyone their slot
    this.room = room;
    this.hub = new Hub({
      limits: ROOM_LIMITS,
      onConnState: (conn, s) => {
        try { conn.ws.serializeAttachment({ ...conn.att, ...s }); conn.att = { ...conn.att, ...s }; } catch {}
      },
      onRoomMemory: (id, mem) => {
        this.memory = mem;
        this.snap.hints++;
        this.ctx.storage.put({ mem, snap: this.snap }).catch(() => {});
      },
      loadRoomMemory: () => this.memory,
    });
    const entries = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = safeAttachment(ws);
      if (!att || att.room !== room || att.dead) continue;
      entries.push({ conn: this.connFor(ws, att), rooms: att.rooms, scout: att.scout, seq: att.seq, joined: att.joined });
    }
    this.hub.restore(entries, { quiet });
    return this.hub;
  }

  connFor(ws, att) {
    let conn = this.conns.get(ws);
    if (conn) return conn;
    conn = {
      id: att.id,
      ip: att.ip,
      since: att.since,
      onlyRoom: att.room,
      att,
      ws,
      send: (text) => ws.send(text),
      close: (code, reason) => {
        // closed by the relay (full, rate, never joined): never restored after a wake-up, even if still closing
        try { ws.serializeAttachment({ ...att, dead: true }); } catch {}
        this.conns.delete(ws);
        ws.close(code, reason);
      },
    };
    this.conns.set(ws, conn);
    return conn;
  }

  async fetch(request) {
    const room = /^\/v1\/room\/([0-9a-f]{32})$/.exec(new URL(request.url).pathname)?.[1];
    if (!room) return new Response('not found', { status: 404 });
    const hub = this.ensureHub(room);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const att = { room, id: crypto.randomUUID(), ip: request.headers.get('CF-Connecting-IP') || 'unknown', since: Date.now(), rooms: [], scout: false, seq: 0, joined: false };
    server.serializeAttachment(att);
    hub.connect(this.connFor(server, att)); // over capacity: it is told `full` and closed
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const att = safeAttachment(ws);
    if (!att) return;
    const hub = this.ensureHub(att.room);
    const conn = this.conns.get(ws);
    if (!conn) return;
    hub.message(conn, typeof message === 'string' ? message : new Uint8Array(message));
    await this.schedule();
  }

  async webSocketClose(ws) {
    this.gone(ws);
    try { ws.close(1000, 'bye'); } catch {}  // completes the close handshake (a no-op if already closed)
    await this.schedule();
  }

  async webSocketError(ws) {
    this.gone(ws);
    await this.schedule();
  }

  gone(ws) {
    const att = safeAttachment(ws);
    // woken by this departure: the socket may already be missing from the restore, so tell everyone their slot
    if (!this.hub && att) this.ensureHub(att.room, { quiet: false });
    const conn = this.conns.get(ws);
    if (conn && this.hub) this.hub.disconnect(conn);
    this.conns.delete(ws);
  }

  /** A coalesced roster broadcast is due, or a connection that never joined has to go. */
  async alarm() {
    this.alarmAt = null;
    if (!this.hub) {
      // woken only for this: rebuild, and tell every member its slot (what was pending is not known any more)
      const att = this.ctx.getWebSockets().map(safeAttachment).find(Boolean);
      if (!att) return;
      this.ensureHub(att.room, { quiet: false });
    }
    this.hub.tick();
    await this.snapshot();
    await this.schedule();
  }

  /** One line of numbers for the metrics database, every 5 minutes while the room is in use. */
  async snapshot() {
    const room = this.hub && this.room && this.hub.rooms.get(this.room);
    const now = Date.now();
    if (!room || !room.members.size || now - this.snap.at < SNAPSHOT_MS - 1000) return;
    const active = this.hub._slots(room).size;
    const hints = this.snap.hints;
    this.snap = { at: now, hints: 0 };
    await this.ctx.storage.put('snap', this.snap);
    if (this.env.METRICS) {
      await this.env.METRICS.prepare('INSERT INTO rooms (ts, day, room, members, scouts, standby, hints) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(now, new Date(now).toISOString().slice(0, 10), this.room.slice(0, 8), room.members.size, active, room.members.size - active, hints).run().catch(() => {});
    }
  }

  async schedule() {
    let due = this.hub && this.hub.nextDueAt();
    const room = this.hub && this.room && this.hub.rooms.get(this.room);
    if (room && room.members.size) {                       // the next metrics snapshot while the room is in use
      if (!this.snap.at) this.snap.at = Date.now() - SNAPSHOT_MS + 60_000;   // the first one a minute after the room opens
      const snapDue = Math.max(this.snap.at + SNAPSHOT_MS, Date.now() + 1000);
      due = due == null ? snapDue : Math.min(due, snapDue);
    }
    if (due == null) return;
    const at = Math.max(Date.now() + 10, due);
    if (this.alarmAt != null && this.alarmAt <= at) return;   // an earlier alarm is set already (no write per join)
    this.alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }
}

function safeAttachment(ws) {
  try {
    const a = ws.deserializeAttachment();
    return a && typeof a.room === 'string' ? a : null;
  } catch {
    return null;
  }
}
