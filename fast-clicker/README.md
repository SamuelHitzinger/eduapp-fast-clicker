# EduApp Fast Clicker v2.1

Shows ETH EduApp clicker questions within seconds and gets your answer through, even on bad lecture-hall Wi-Fi. **Nothing to install:** it's a bookmark you tap while EduApp is open. Desktop users can also use an optional browser add-on.

- **Install page:** `../site/index.html` (self-contained; shows the right steps for iPhone, Android or a laptop).
- **Source:** `eduapp-fast-clicker.user.js`. The same file works as a userscript, a bookmarklet (focus mode) and an add-on (panel mode).

## How it gets to you

| Way | Install | Starts | Notes |
|---|---|---|---|
| **Bookmark** (recommended) | Drag a button (laptop), or copy-paste into a bookmark (phone) | Tap it on EduApp | Works in Safari, Chrome, Firefox, Edge. All code is inside the bookmark, so it doesn't depend on any website. |
| Short bookmark (only when the install page is hosted) | Same | Same | ~500 characters; loads a pinned, integrity-checked (SRI) copy from the install site. |
| Browser add-on (laptops) | Developer mode → Load unpacked (until published to the Chrome/Firefox stores) | Automatically, as a small panel | Same code; a "Focus mode" button. |

A separate website or app can't work without your ETH password. Browsers only let code use the EduApp login when it runs on eduapp.ethz.ch itself.

## What it does (and why it's faster)

Reverse-engineered facts (measured): EduApp has **no push**: Firebase is disabled and there's no WebSocket. It only refetches when you navigate or focus the tab. Each refresh of the clicker page downloads the **whole semester** (2.6 MB, 1.1 MB gzip, ~1 s). The dashboard re-fetches ~25 questions (~1 MB) on every focus. Sending is never retried, and an expired login (after a few hours) reloads the whole page, losing your answer.

Fast Clicker:
- **Detection:** it polls the ~2 KB activity feed, one request at a time. That's every ~4 s from 10 min before to 15 min after each of your lectures (from your timetable), every 15 s in a background tab, and every 50 s otherwise. It backs off when the server or network struggles. Then it downloads only the question that changed (~25 ms on the server). Typical time from "lecturer opens" to the question on screen: about 2–5 s.
- **Focus mode** (bookmark): stops EduApp's own background traffic (dashboard refreshes, ~1 MB on every refocus, the 5-minute service-worker check), so your answer doesn't compete with it. It also keeps the screen on around lectures.
- **Sending:** one request per question at a time, on the already-open HTTP/2 connection. It retries with backoff for up to 2 minutes, waits through offline periods and login renewal, and never carries an answer into a new round. It shows **"Sent ✓"** the moment the server accepts, then re-reads the question in the background to show **"✓ Confirmed"**. If a late older request overwrote your answer, it automatically re-sends the newest one.
- **Login:** an expired session is renewed silently by following the ETH login redirects in the background, which works while ETH single sign-on is still valid (verified on the real site). Otherwise a **Log in** button opens the login once, and your chosen answer is kept and sent right after.
- **Several tabs:** only one tab polls (Web Locks); the others get its updates (BroadcastChannel) and can still answer.
- Every request carries a unique `_fc` parameter (ignored by the server), so EduApp's service-worker cache can never hand back stale data. Those entries are swept away every minute.

## Verified

- `tools/test-mock.js`: **39** functional and regression checks: detection, vote format, retries, round changes, out-of-order and stale responses, typing during polls, login expiry and silent renewal, offline queueing, focus mode, and late verification with repair.
- `tools/test-tabs.js`: **9** checks: one poller across tabs; failover when that tab closes or is paused; answers from two tabs are serialized so the newest wins; the Log in button appears in every tab.
- `tools/test-chaos.js`: simulated terrible Wi-Fi. 12% of requests hang, 8% fail, 10% get 503, and 25% of vote replies are lost after the server applied them. Plus a login expiry, a changed mind mid-send and a round restart. Pass criterion: the server ends with exactly the student's latest answer, confirmed, with no overlapping polls and no parallel votes. 20/20 runs pass.
- `tools/test-bookmarklet.js`: the built bookmark, decoded exactly as a browser does.
- Every bug found by the two independent reviews (Sol/OpenAI) and by the chaos test has a regression test that fails on the old code and passes now.
- **Real browser** (via Hermes, read-only, no answers sent): focus mode replaced the live EduApp page; polling and question display worked; there were no console errors; dark mode was readable; formulas showed once; the silent-renewal redirect chain returned 200 JSON same-origin; pausing released the polling lock (real Web Locks API) and resuming reacquired it.
- **Not yet verified live:** an actual vote on the real server (the format matches EduApp's own code exactly), and the bookmark on real iOS/Android devices.

## Server load (honest numbers)

Each feed request is small (~2 KB), but the server needs ~1.2 s to answer it. One student in a lecture makes ~1 request per 4 s, so a full lecture hall of 400 would add ~100 requests/s, which is a noticeable load. The client therefore polls one request at a time, only around your lectures, slows to every 15 s in background tabs, and backs off to 3× the observed response time as soon as EduApp answers slower than ~2.5 s. Don't lower the interval. If this spreads widely, ETH enabling push (below) is the right fix.

## Build

`node tools/build.js` builds `site/`: `index.html`, the pinned `fast-clicker.<hash>.js`, the add-on folder and zip. `node tools/verify-site.js` checks the bookmark encoding and the SRI hash.

## Real fix (for ETH)

EduApp already contains Firebase push code (`firebase-messaging-sw.js`, `notifications/subscribe`), but `/config.json` has it disabled. Enabling push, or adding a cheap "anything new?" endpoint, would give every student instant clicker notifications with less server load than any polling client.
