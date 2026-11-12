// Runs the hint relay hub on Cloudflare Workers.
//
// All traffic goes to ONE Durable Object instance ("hub"), which holds every
// room in memory. WebSockets use plain `accept()` (no hibernation): the object
// stays in memory while any socket is open, so the in-memory Hub is the whole
// state. When the last socket closes the object may be evicted, which only
// forgets dedupe/replay data; that is fine for a relay.
import { Hub, ALLOWED_ORIGINS } from './hub.js';

const TICK_MS = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isHealth = url.pathname === '/health' && request.method === 'GET';
    const isSocket = url.pathname === '/v1';
    if (!isHealth && !isSocket) return new Response('not found', { status: 404 });
    if (isSocket) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const origin = request.headers.get('Origin');
      if (origin !== null && !ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });
    }
    const stub = env.HUB.get(env.HUB.idFromName('hub'));
    return stub.fetch(request);
  },
};

export class RelayHub {
  constructor(state) {
    this.state = state;
    this.hub = new Hub();
    this.timer = null;
    this.nextId = 1;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, ...this.hub.stats() }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const conn = {
      id: this.nextId++,
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
      send: (text) => server.send(text),
      close: (code, reason) => server.close(code, reason),
    };
    const gone = () => {
      this.hub.disconnect(conn);
      this.maybeStopTimer();
    };
    server.addEventListener('message', (ev) => this.hub.message(conn, ev.data)); // string, or ArrayBuffer (binary -> closed)
    server.addEventListener('close', () => {
      try {
        server.close(1000, 'bye'); // complete the close handshake
      } catch {}
      gone();
    });
    server.addEventListener('error', gone);
    if (this.hub.connect(conn)) this.startTimer();
    return new Response(null, { status: 101, webSocket: client });
  }

  startTimer() {
    if (!this.timer) this.timer = setInterval(() => this.hub.tick(), TICK_MS);
  }

  maybeStopTimer() {
    // No sockets left: nothing to flush or time out. Remaining dedupe data is
    // pruned on the next tick after someone connects again.
    if (this.timer && this.hub.stats().connections === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
