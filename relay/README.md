# ETH Clicker hint relay

A small public WebSocket server that lets the students in one lecture share the work of noticing a new clicker question.

Without it, every student's client polls ETH's EduApp endpoint. With it, the clients of a room take turns (the *scouts*, at most 60 of them; together about one feed request per second however big the room). When one of them sees a clicker event, it sends a tiny hint ("clicker 322454 changed") to the relay. The relay passes the hint on to everyone else in the same room, and each client then fetches the question straight from ETH with its own login.

```
src/hub.js          platform-neutral core: rooms, slots, limits (no I/O, injectable clock)
src/node-server.js  the hub on Node + `ws` (local tests, self-hosting)
src/worker.js       the hub on Cloudflare Workers: one Durable Object per room, hibernating between messages
wrangler.toml       Worker + Durable Object config (Free-plan compatible)
test/               `node test/run.js`: unit tests (fake clock) + integration tests (real sockets)
```

## What the relay can and cannot see

| It sees | It never sees |
| --- | --- |
| opaque room ids (16–64 hex chars, which the client derives) | ETH credentials, cookies or tokens |
| hints: clicker id `k`, event type `e`, activity id `a`, timestamp `c` | question text, answer options, answers or votes |
| connection IPs (only to enforce the per-IP cap, held in memory) | who a user is |

It stores nothing durable: no database writes and no files. Everything lives in memory and is gone on restart. It logs counts only (`connections=N rooms=M`), never room ids, IPs or hint contents. Error replies never echo input back.

## Protocol v1

All frames are JSON text frames. Clients connect once per room to `/v1/room/<room id>` (the id: 32 hex digits, a hash the client makes from semester + course number) and join exactly that room. On Cloudflare each room is its own Durable Object; the Node server also still accepts `/v1` for any rooms.

### Client → relay

| Frame | Meaning |
| --- | --- |
| `{"t":"join","rooms":["<id>",...],"scout":true\|false}` | **Replaces** the full room set and the scout flag. A room id is 16–64 chars of `[0-9a-f]`; at most 8 rooms; duplicates are collapsed. `[]` leaves all rooms. If `scout` is missing, it counts as `false`. Can be sent at any time. |
| `{"t":"hint","room":"<id>","k":<int>0>,"e":"<[A-Z_]{1,32}>","a":<int>0>,"c":"<timestamp ≤32 chars>"}` | Only accepted for a joined room. |
| `{"t":"ping"}` (exactly this text) | The relay answers `{"t":"pong"}` (Node adds `"now"`). Send one about every 25–40 s. On Cloudflare the platform answers it without waking the room. |

### Relay → client

| Frame | When |
| --- | --- |
| `{"t":"roster","room","n","slot","m","every","now"}` | Sent right after each `join`, one per room in the request. Also sent to a member whenever its `(n, slot)` in that room changes. `n` = scouts in the room; `slot` = this connection's 0-based index among them (`-1` = not a scout); `m` = members; `every` = target aggregate poll interval in ms (1000). |
| `{"t":"hint","room","k","e","a","c","now"}` | An accepted hint, sent to every member except the sender. `"replay":true` marks hints replayed on join. |
| `{"t":"err","code":"bad"\|"rate"\|"full"\|"room"}` | Diagnostics. Each code is sent at most once per 10 s per connection. |

**Slots.** Scouts are kept in the order they *became* scouts in that room, either by joining with `scout:true` or by switching the flag on later. Slots are dense: when a scout leaves or drops its flag, every later scout shifts down by one and is told. A client that turns `scout` back on goes to the end of the order. Clients can split the polling, for example scout `slot` polls at `t ≡ slot·every (mod n·every)`.

**Coalescing.** Roster broadcasts go out at most once per room per 300 ms. The first change goes out at once; changes within the next 300 ms are merged, and the latest state is sent when the window ends. A member whose `(n, slot)` did not change gets no broadcast, so a change in `m` alone does not trigger one.

## Limits (constants at the top of `src/hub.js`)

| Limit | Default | Over the limit |
| --- | --- | --- |
| Frame size | 600 bytes UTF-8 | `err bad` (Node closes frames over 4 KiB at the protocol level) |
| Non-JSON, unknown `t`, wrong types | – | `err bad`; still counts toward the message limit |
| Binary frame | – | close `4002` |
| Messages per connection | 60 / rolling min | dropped + `err rate`; more than 180 / min → close `4001` |
| Hints per connection | 20 / rolling min | dropped + `err rate` |
| Accepted hints per room | 30 / rolling min | dropped + `err rate` |
| Same room + clicker `k` + event `e` | 1 / s | dropped + `err rate` |
| Dedupe on activity id `a` | 10 min, ≤300 ids per room | dropped silently |
| Replay on join | hints from the last 30 s, only for rooms not already joined | – |
| Connections per IP | 700 (Cloudflare: 1000 per room; a lecture hall on campus Wi-Fi can share one address) | `err full` + close `4000` |
| Connections in total | 5000 (Cloudflare: 2500 per room, no total) | `err full` + close `4000` |
| Members per room | 2000 | `err full` + close `4000` |
| Scouts with a slot | 60 per room; later scouts get `slot: -1` and move up when one leaves | – |
| Rooms | 200 (empty rooms are evicted first; Cloudflare: one per object) | `err full` + close `4000` |
| Room of a connection | the one in its URL (`/v1/room/<id>`) | `err room` |
| Idle (nothing received) | 120 s (Cloudflare: none; the platform closes dead sockets) | close `4003` |

An empty room is deleted once its dedupe and replay data have expired.

Other close codes: `4004` = the relay could not send to this socket (broken socket, or on Node more than 64 KiB unsent); `4005` = internal error (should never happen). A rejected `join` (bad input, or full) changes nothing.

Design notes:
- Per message, the work is O(1), except a hint, which costs O(room members).
- A roster broadcast costs O(members) at most once per 300 ms per room.
- No per-connection send queues exist: a send that throws drops only that socket, after the current fan-out loop.

## Run locally

```sh
cd relay
npm install
node test/run.js                 # all tests; exits 1 on failure
PORT=8787 node src/node-server.js
curl http://127.0.0.1:8787/health   # {"ok":true,"connections":0,"rooms":0}
```

On PowerShell: `$env:PORT=8787; node src/node-server.js`.

The Node server allows WebSocket upgrades on `/v1/room/<id>` (one room, as the clients use it) and `/v1` (any rooms). An upgrade with an `Origin` header other than `https://eduapp.ethz.ch` gets `403`; a missing Origin, as from native apps and tests, is allowed. When the Node server runs behind a proxy, set `TRUST_PROXY=1` so the IP is taken from `CF-Connecting-IP` / `X-Forwarded-For`.

To test the Worker locally, with no Cloudflare account and no network:

```sh
npx wrangler dev --port 8799
RELAY_URL=http://127.0.0.1:8799 node test/integration-only.js   # in a second terminal
```

## Deploy to Cloudflare

Hosting was approved by the owner on 2026-11-12. One-time login, then deploy:

```sh
cd relay
npm install
npx wrangler login           # opens the browser; one time
npx wrangler deploy          # publishes the Worker and the RelayRoom Durable Object class (migration v1)
# -> https://fast-clicker-relay.<your-subdomain>.workers.dev  (rooms: wss://.../v1/room/<id>, health: /health)
```

Put `wss://fast-clicker-relay.<your-subdomain>.workers.dev/v1` into `relay/relay-url.txt` and run `node tools/build.js`.

How it scales and what it costs (Workers Free plan: 100,000 Durable Object requests and 13,000 GB-s per day):
- **One Durable Object per room.** Rooms never compete; there is no global cap. A big lecture is one object with up to 2000 sockets (the platform allows 32,768).
- **Hibernation.** A room is evicted from memory between messages while its sockets stay open, and is not billed for that time. Keep-alive pings are answered by the platform (`setWebSocketAutoResponse`) without waking it. After a wake-up the hub is rebuilt silently from each socket's attachment (its room, scout flag and scout order); a room's recent hints (dedupe ids, 30 s replay, rate window) are kept in storage, written only when a hint is accepted.
- **Requests:** a connection is one request; incoming messages count 1/20 (a join, a hint, a ping). 1000 students in lectures for 2 hours make roughly 1000 connects + 1000 × 288 pings / 20 ≈ 15,000 requests a day.
- **Duration:** only while a room handles a message or a roster broadcast (milliseconds), not while students sit in the lecture.
- `GET /health` answers `{"ok":true}` from the Worker without touching a room.
- Check the Cloudflare dashboard (Workers & Pages → fast-clicker-relay → Metrics) after the first busy lecture.
