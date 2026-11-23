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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
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
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    ctx.blockConcurrencyWhile(async () => {
      this.memory = (await ctx.storage.get('mem')) || null;
    });
  }

  /** The hub for this room, rebuilt silently from the sockets' attachments after a wake-up. */
  ensureHub(room, { quiet = true } = {}) {
    if (this.hub) return this.hub;
    this.room = room;
    this.hub = new Hub({
      limits: ROOM_LIMITS,
      onConnState: (conn, s) => {
        try { conn.ws.serializeAttachment({ ...conn.att, ...s }); conn.att = { ...conn.att, ...s }; } catch {}
      },
      onRoomMemory: (id, mem) => {
        this.memory = mem;
        this.ctx.storage.put('mem', mem).catch(() => {});
      },
      loadRoomMemory: () => this.memory,
    });
    const entries = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = safeAttachment(ws);
      if (!att || att.room !== room) continue;
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
      close: (code, reason) => ws.close(code, reason),
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
    if (!this.hub && att) this.ensureHub(att.room);
    const conn = this.conns.get(ws);
    if (conn && this.hub) this.hub.disconnect(conn);
    this.conns.delete(ws);
  }

  /** A coalesced roster broadcast is due, or a connection that never joined has to go. */
  async alarm() {
    if (!this.hub) {
      // woken only for this: rebuild, and tell every member its slot (what was pending is not known any more)
      const att = this.ctx.getWebSockets().map(safeAttachment).find(Boolean);
      if (!att) return;
      this.ensureHub(att.room, { quiet: false });
    }
    this.hub.tick();
    await this.schedule();
  }

  async schedule() {
    const due = this.hub && this.hub.nextDueAt();
    if (due != null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 10, due));
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
