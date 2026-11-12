// Runs the hint relay hub on Node (local tests, self-hosting).
//   PORT=8787 node src/node-server.js        (PORT=0 picks a free port)
//   TRUST_PROXY=1 -> take the client IP from CF-Connecting-IP / X-Forwarded-For
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Hub, ALLOWED_ORIGINS } from './hub.js';

const MAX_BUFFERED = 64 * 1024; // a client this far behind is dropped, never queued for
const TICK_MS = 100;

export function startServer({ port = 8787, host, trustProxy = false, hub = new Hub() } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 }); // >600 B still gets `err bad`
  let nextId = 1;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && pathOf(req) === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ...hub.stats() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (pathOf(req) !== '/v1') return reject(socket, 404, 'Not Found');
    if (origin !== undefined && !ALLOWED_ORIGINS.includes(origin)) return reject(socket, 403, 'Forbidden');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = {
        id: nextId++,
        ip: clientIp(req, trustProxy),
        send(text) {
          if (ws.readyState !== ws.OPEN) return;
          if (ws.bufferedAmount > MAX_BUFFERED) throw new Error('slow consumer');
          ws.send(text);
        },
        close(code, reason) {
          ws.close(code, reason);
          // Do not wait for a misbehaving peer to finish the close handshake.
          setTimeout(() => ws.terminate(), 2000).unref();
        },
      };
      ws.on('message', (data, isBinary) => hub.message(conn, isBinary ? data : data.toString('utf8')));
      ws.on('close', () => hub.disconnect(conn));
      ws.on('error', () => {
        hub.disconnect(conn);
        ws.terminate();
      });
      hub.connect(conn);
    });
  });

  const timer = setInterval(() => hub.tick(), TICK_MS);
  server.on('close', () => clearInterval(timer));

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, hub, port: server.address().port, wss }));
  });
}

function pathOf(req) {
  const q = req.url.indexOf('?');
  return q < 0 ? req.url : req.url.slice(0, q);
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (h) return h;
  }
  return req.socket.remoteAddress || 'unknown';
}

function reject(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// Run directly: start and log counts only (never room ids, IPs or hints).
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const port = process.env.PORT === undefined ? 8787 : Number(process.env.PORT);
  const { server, hub, port: actual, wss } = await startServer({ port, trustProxy: process.env.TRUST_PROXY === '1' });
  console.log(`relay listening on :${actual}`);
  const statsTimer = setInterval(() => {
    const s = hub.stats();
    console.log(`connections=${s.connections} rooms=${s.rooms}`);
  }, 5 * 60_000);
  const stop = () => {
    clearInterval(statsTimer);
    for (const ws of wss.clients) ws.close(1001, 'shutdown');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

