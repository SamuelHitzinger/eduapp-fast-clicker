# Fast Clicker hint relay

A small public WebSocket server that lets the students in one lecture share the work of noticing a new clicker question.

Without it, every student's client polls ETH's EduApp endpoint. With it, only one or two clients (the *scouts*) poll at any moment. When one of them sees a clicker event, it sends a tiny hint ("clicker 322454 changed") to the relay. The relay passes the hint on to everyone else in the same room, and each client then fetches the question straight from ETH with its own login.

```
src/hub.js          platform-neutral core: rooms, slots, limits (no I/O, injectable clock)
src/node-server.js  the hub on Node + `ws` (local tests, self-hosting)
src/worker.js       the hub on Cloudflare Workers (one Durable Object)
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

All frames are JSON text frames on the WebSocket at `/v1`.

### Client → relay

| Frame | Meaning |
| --- | --- |
| `{"t":"join","rooms":["<id>",...],"scout":true\|false}` | **Replaces** the full room set and the scout flag. A room id is 16–64 chars of `[0-9a-f]`; at most 8 rooms; duplicates are collapsed. `[]` leaves all rooms. If `scout` is missing, it counts as `false`. Can be sent at any time. |
| `{"t":"hint","room":"<id>","k":<int>0>,"e":"<[A-Z_]{1,32}>","a":<int>0>,"c":"<timestamp ≤32 chars>"}` | Only accepted for a joined room. |
| `{"t":"ping"}` | The relay answers `{"t":"pong","now":<server ms>}`. Send one about every 40 s. |

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
| Connections per IP | 700 (a lecture hall on campus Wi-Fi can share one address) | `err full` + close `4000` |
| Connections in total | 2000 | `err full` + close `4000` |
| Members per room | 600 | `err full` + close `4000` |
| Rooms | 200 (empty rooms are evicted first) | `err full` + close `4000` |
| Idle (nothing received) | 120 s | close `4003` |

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

The Node server allows WebSocket upgrades on `/v1` only. An upgrade with an `Origin` header other than `https://eduapp.ethz.ch` gets `403`; a missing Origin, as from native apps and tests, is allowed. When the Node server runs behind a proxy, set `TRUST_PROXY=1` so the IP is taken from `CF-Connecting-IP` / `X-Forwarded-For`.

To test the Worker locally, with no Cloudflare account and no network:

```sh
npx wrangler dev --port 8799
RELAY_URL=http://127.0.0.1:8799 node test/integration-only.js   # in a second terminal
```

## Deploy to Cloudflare (later, only with the owner's OK)

```sh
cd relay
npm install
npx wrangler login           # opens the browser; one time
npx wrangler deploy          # publishes the Worker and creates the Durable Object class (migration v1)
# -> https://fast-clicker-relay.<your-subdomain>.workers.dev  (WebSocket: wss://.../v1, health: /health)
npx wrangler tail            # optional live logs (counts and errors only)
```

Notes on the Worker:
- **One Durable Object instance** (`idFromName("hub")`) holds every room in memory. The outer Worker rejects bad paths and foreign Origins before they reach it, and the client IP comes from `CF-Connecting-IP`.
- **Plain `server.accept()`, no WebSocket hibernation.** That keeps the state model identical to Node: the object stays in memory while any socket is open, and a 100 ms `setInterval` drives `hub.tick()` while there are connections. The trade-off is that the object is billed for wall-clock time while sockets are open. That fits a few hours of lectures a day, but it is the first thing to revisit (hibernation plus `serializeAttachment`) if usage grows. When the last socket closes the object may be evicted, which only forgets dedupe and replay data.
- The class uses a **SQLite-backed** migration (`new_sqlite_classes`), which the Free plan requires. The relay never writes to storage.
- Free-plan quotas apply (Durable Object requests and duration per day). Check the Cloudflare dashboard after the first busy lecture.
- To allow another origin, edit `ALLOWED_ORIGINS` in `src/hub.js`.
