# ETH Clicker v3.2.0

A replacement for the clicker section of ETH EduApp. It looks like EduApp's own clicker pages, but a new question appears by itself within seconds, your answer gets through on bad lecture-hall Wi-Fi, and you see when it really arrived.

- **Source:** `eduapp-fast-clicker.user.js`. The same file is the iPhone app's content, the bookmark (focus mode) and the browser add-on (panel mode).
- **Install page:** `../site/index.html` (self-contained; shows the right steps for iPhone, Android or a laptop).
- **Relay (optional):** `../relay/` lets the students of one lecture share the work of noticing a new question.

## How it gets to you

| Way | Install | Starts | Notes |
|---|---|---|---|
| **iPhone app** | Sideload `FastClicker.ipa` (see `../AGENTS.md`) | Open the app | A web view on eduapp.ethz.ch that shows only this clicker. Native sound, vibration and notification. |
| **Bookmark** | Drag a button (laptop), or copy-paste into a bookmark (phone) | Tap it on EduApp | All code is inside the bookmark (about 70 KB since v3; not yet tried on real phones at that size). |
| Short bookmark (only when the install page is hosted) | Same | Same | ~500 characters; loads a pinned, integrity-checked (SRI) copy from the install site. |
| Browser add-on (laptops) | Developer mode → Load unpacked | Automatically, as a small panel | Same code; a "Focus mode" button. |

Login always happens on ETH's own pages. Code can only use the EduApp login when it runs on eduapp.ethz.ch itself (in a browser tab, an add-on or an app's web view), so an ordinary separate website cannot do this, and nothing here ever sees your ETH password.

## What EduApp does, and what this does instead

Reverse-engineered and measured (November 2026):

- EduApp has **no push**: no WebSocket or event stream, and its Firebase code is for emergency alerts and is switched off. It only refetches when you navigate or re-focus.
- The only signal confirmed to announce a new question is the **activity feed**. It costs ETH 1.3–1.5 s per request whatever is asked (1 event or 100; a HEAD request costs the same; filters are ignored) and the API has no "not changed" shortcut (no ETag).
- Everything else is fast: one question about 35 ms, the timetable about 40 ms, six questions at once about 45 ms each.
- Each visit to EduApp's clicker page downloads the **whole semester** (3 MB, 1.4 MB compressed, about 1.2 s).
- Sending is never retried, and an expired login (after a few hours) reloads the whole page, losing your answer.
- **Why a question can stay invisible for minutes in EduApp:** its service worker answers every data request "network first, but after 10 s from the saved copy" (`NetworkFirst`, `networkTimeoutSeconds: 10`, cache `api-requests`). When a whole lecture hall opens the clicker page at once, each phone downloads the 1.4 MB semester list; the server and the Wi-Fi fall behind, requests take longer than 10 s, and EduApp shows the old saved list without the new question. Reloading or reopening repeats the same, and adds to the overload. EduApp never retries (`retry: false`).

ETH Clicker:

- **Looks like EduApp's clicker section.** EduApp's app bar (clicker icon and "ETH Clicker", a check-now button with a status dot, and the dark-mode button), with no menu or settings to look after; a list by date or by lecture with the same colours, icons and wording, and a question page (options and Send while open; your result and the vote bars once closed). Fixed along the way: it updates by itself, a newly opened question comes on screen by itself (unless you are in the middle of answering another one), a stopped round is shown as "paused", bigger touch targets, formulas in the list preview, pictures readable in dark mode.
- **The semester list is kept on the device.** It is downloaded once (never automatically during a lecture) and patched as questions change, instead of 1.4 MB on every visit.
- **Questions you missed are filled in.** When the app starts, questions that opened and closed while it was not running are read once (a few KB each) from the feed's recent events and added to the list with their results, without an alert. If the app was closed so long that the feed no longer reaches back to the saved list, the list is downloaded again after the lecture.
- **No stale answers, and built for an overloaded server:** every request carries a unique `_fc` parameter, so no cache (including EduApp's service worker) can ever answer it with old data, and the requests are small (about 2 KB to notice, a few KB for the question) instead of 1.4 MB. If ETH answers slower than the time limit, the next request is given longer (up to 30 s) instead of being cut off again; around lectures the pause after failures stays short (at most 10 s). With the relay, one phone in the hall that gets through is enough for everyone.
- **Detection:** it checks the feed one request at a time, never sooner than 4 s after the previous check: every ~4 s from 10 min before to 15 min after each of your lectures (from your timetable) and whenever the iPhone app (or focus mode) is open on screen, every 15 s in a background tab, every 50 s otherwise, backing off when the server or network struggles. Then it downloads only the question that changed.
- **Shared detection (optional relay).** With a relay configured, the clients in one lecture take turns: together they ask the feed about once a second, each one only every n-th time, and the one that sees a clicker event tells the others "question N changed". Everyone then reads the question from ETH directly. A full hall puts about 1 feed request per second on ETH instead of about 100. If the relay is unreachable, each client checks alone again, more slowly the more students were sharing.
- **Fast start on bad Wi-Fi:** the semester is remembered from the last run (and confirmed right after), and the timetable loads alongside the first feed check, so a fresh start asks ETH one thing before it can show a question instead of three in a row. In the iPhone app, pulling down means "check now"; it no longer restarts the page (a restart throws away a check under way and costs seconds).
- **A restarted round cannot be missed.** Lecturers often stop a question, discuss, and restart it for a second vote. The question then shows **"New round: vote again"** until this round's answer is in, and the iPhone alert says "New round: vote again" too; if the app is in the background, a reminder notification follows after 20 s unless you have opened it.
- **Sending:** one request per question at a time. It retries with backoff for up to 2 minutes, waits through offline periods and login renewal, shows **"Sent ✓"** the moment the server accepts, then re-reads the question to show **"✓ Confirmed"**, and re-sends if a late older request overwrote your answer. When a new round is seen, the old answer is dropped and you choose again.
- **Login:** an expired session is renewed silently while ETH single sign-on is still valid; otherwise a **Log in** button opens the login once, and your chosen answer is kept.
- **Several tabs:** only one tab checks (Web Locks) and talks to the relay; the others get its updates (BroadcastChannel) and can still answer.
- **Fixed behaviour, no settings (v3.2).** A new question comes on screen by itself with sound and vibration; you tap an option and then **Send** (a mis-tap can be corrected); the screen stays on while the app is open. Only the list layout (by date / by lecture) and dark mode are remembered. Settings saved by older versions are reset to these, and the old timing recording is deleted from the device.

### Limits you should know

- **A new round cannot be detected with certainty.** ETH's vote request carries no round number. The client stops sending as soon as it sees a round change (from the feed or a hint), but a retry that was already on its way can still land in the next round. After a connection gap it asks you to check your answer.
- **`OPEN` does not mean "accepting answers".** A stopped round still reports `OPEN`; the page shows "paused".
- **No vote has been sent to the real server by us.** The request format is copied from EduApp's own code; its speed is unmeasured.
- **The floor for detection is the feed's own 1.4 s.** See the next section for what was tried to beat it.

## Beating the feed: what was measured (removed in v3.2)

v3.0–v3.1 carried a timing recorder and a "peek next id" experiment (reading the id just above the last question of your own course, read-only). Both were removed in v3.2 at the user's request. What they showed:

- Within one lecture the next question's id is usually the previous one + 1, but the first question of a lecture is not (questions are created in batches ahead of time), and ids +1..+3 often belong to other courses (HTTP 500).
- Before it opens, the next question already returns **200 with state `DRAFT` and its text**: ETH serves unopened questions to students. Nothing was ever shown or kept from it.
- 1.2 s after the feed's "opened" event the question still read `DRAFT` (phone and ETH clocks within 0.2 s), so a direct poll did not clearly beat the feed.
- The timetable's clicker flags stayed off while questions were open: no use as a signal.
- On a phone already on screen, a question showed 3–7 s after it opened: on average half a check interval of waiting, plus the feed (1.5–4 s when the hall is busy) and the question itself.

## The relay

`../relay/` is a small WebSocket service (Cloudflare Worker or Node). It is public and has no accounts.

- It sees: connections (IP address, timing), room names (a hash of semester + course number) and hints (`clicker id`, `event type`, `activity id`, `time`).
- It never sees: ETH logins, cookies, question text, answers, names.
- A hint is an untrusted wake-up call. It can only make a client read `clickers/{id}` from ETH (at most 12 reads a minute, and not at all while ETH has asked for a pause). It cannot make a client vote, navigate or run anything, and it never decides about rounds: a newly open question is shown because ETH says it is open, and a "new round" hint only brings the next feed check forward. Until that check succeeds, automatic retries of an answer wait. Hints are only accepted for the course rooms the client joined from its own timetable.
- What a hostile relay can still do: withhold hints (the client then finds questions at its own, slower pace) or cause a few extra question reads.

The address goes into `relay/relay-url.txt`; `node tools/build.js` puts it into every build. Without that file each client checks for itself.

## Verified

- `tools/test-mock.js`: 48 functional and regression checks: detection, vote format, retries, round changes, out-of-order and stale responses, login expiry and silent renewal, offline queueing, focus mode, verification with repair, question content.
- `tools/test-tabs.js`: 9 checks: one poller across tabs, failover, serialized answers across tabs, login in every tab.
- `tools/test-v3.js`: 77 checks: the list and question pages, questions missed while the app was closed, auto-opening without interrupting an answer, shared detection against a fake relay (slots, hints both ways, de-duplication, junk and foreign hints, relay down, reconnect), what a hostile relay cannot do (hide or fake a round change, push an old answer into a new round, flood ETH, override spacing or ETH's Retry-After), an overloaded EduApp (answers slower than the time limit, many failures in a row, no cached answers), keyboard shortcuts, list freshness, the simple v3.2 screen (no drawer, settings migration, fast pace while on screen), the fast start (remembered semester), "vote again" after a restarted round, "check now".
- `tools/test-relay-e2e.js`: real clients against the real relay on a local port: two and three phones sharing, a question found by one reaching the others, joining late, the relay going away.
- `tools/test-chaos.js`: simulated terrible Wi-Fi (12% of requests hang, 8% fail, 10% get 503, 25% of vote replies lost after the server applied them), plus a login expiry, a changed mind mid-send and a round restart. Pass criterion: the server ends with exactly the student's latest answer, confirmed, with no overlapping polls and no parallel votes.
- `tools/test-bookmarklet.js`, `tools/verify-site.js`: the built bookmark and the pinned file.
- `relay/test/`: the relay's own tests.
- **Real site, read-only** (via the Hermes browser, no answers sent): endpoint costs and headers (`hermes_out/v3/probe.json`), EduApp's phone layout for the look (`hermes_out/v3/ui/`), and for v2.1 focus mode, polling, silent renewal and tab hand-over.
- **Not yet verified live:** a vote on the real server, the v3 pages on a real phone, the relay with more than one real student.

## Build

`node tools/build.js` builds `site/` (`index.html`, the pinned `fast-clicker.<hash>.js`, the add-on folder and zip) and `ios/FastClicker/Resources/fast-clicker.js`.

## Real fix (for ETH)

A cheap "anything new?" endpoint, an ETag on the feed, or clicker events over push would give every student instant questions with less server load than any polling client.
