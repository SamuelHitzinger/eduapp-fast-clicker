# Operations runbook

How to release, watch and, if needed, stop ETH Clicker once hundreds of students in many courses use it. The
design is in `../fast-clicker/README.md` (client) and `../relay/README.md` (relay). The rules in `../AGENTS.md` are binding.

## What runs where

| Part | Where | Updated by |
| --- | --- | --- |
| Core script (all four channels) | `fast-clicker/eduapp-fast-clicker.user.js` | `node tools/build.js` copies it into every channel |
| Install page, bookmark, pinned script, add-on zip, `control.json` | Cloudflare static assets, https://clicker.fast-clicker-relay.workers.dev/ | `node tools/publish-site.js` |
| Relay (one Durable Object per lecture room) and `POST /v1/report` | Cloudflare Worker `fast-clicker-relay` | `cd relay && npx wrangler deploy` |
| Metrics | Cloudflare D1 `clicker-metrics` (90 days, daily cleanup by cron) | `cd relay && npx wrangler d1 migrations apply clicker-metrics --remote` |
| Android app | APK on the install page (sideloaded) | `node tools/release.js android` then `apk`, then publish |
| iPhone app | TestFlight, public link | `node tools/release.js ios` |
| Tests | GitHub Actions `test.yml` on every push | automatic |

Secrets: the Android release key is in GitHub secrets and `android/keystore/` (never commit it). The App Store
Connect key `.p8` is in GitHub secrets. Cloudflare login (`npx wrangler login`) and GitHub CLI (`gh auth login`) are
on the owner's PC.

## Release

1. **Change and test.** Edit the core script (or `ios/`, `android/`, `relay/`), then run `node tools/build.js` and `npm test`.
2. **Version.** For a change users see, run `node tools/version.js 3.7.0`. It sets `version.json`, the script, `ios/project.yml`
   and the Android `versionName`, and `build.js` refuses to build if they disagree. CI numbers the native builds.
3. **Commit and push.** CI checks that the committed build matches the sources and runs every test.
4. **Pre-flight.** `node tools/release.js check` must say `ready`.
5. **Channels:**
   - **Web bookmark and add-on:** `node tools/publish-site.js` (after step 6, so the APK is the same version).
   - **Android:** `node tools/release.js android` (build and emulator test, about 15 min). Then `node tools/release.js apk` fetches the
     APK built from exactly this commit. A failed *smoke* job can be the emulator's own Google services crashing:
     look at `smoke.png` and the log in the run's `android-smoke` artifact before ignoring it. The *build* job must pass.
   - **iPhone:** `node tools/release.js ios` uploads to TestFlight. External testers get it after Apple's beta review (usually under a day).
     TestFlight builds expire after **90 days**: upload one at least every two months.
6. `node tools/publish-site.js` publishes the page, every pinned script ever published, the APK and `control.json`.
7. **Tell old clients.** Raise `latest` in `install/control.json` for each channel once its new build is out there, then publish again.
   Clients older than that show a small "update available" note.

Old pinned short bookmarks and old full bookmarks run their version forever, and sideloaded APKs don't update by
themselves. From 3.6.0 on, `control.json` can at least tell them to update, or stop them (`min`). Versions before
3.6.0 don't read it: replace them by asking those testers to reinstall.

## Remote control (`install/control.json`)

Every client from 3.6.0 reads this file at start and every 6 hours (every 10 minutes while paused). It can only
make clients do less, and it carries no text, links or code:

```json
{ "pause": false, "slow": 1, "min": "0.0.0", "latest": { "web": "3.6.0", "addon": "3.6.0", "ios": "3.6.0", "android": "3.6.0" } }
```

| Field | Effect |
| --- | --- |
| `pause: true` | No automatic feed checks, no relay, no hint reads. A note tells students to use EduApp meanwhile. Opening a question and sending an answer still work. |
| `slow: 2…10` | Every automatic check is that many times further apart (ETH slow or overloaded). |
| `min: "x.y.z"` | Versions below it stop checking and show "out of date, Update". Raise it only once the fixed version is available on every channel. |
| `latest.<platform>` | Versions below it show "A new version is available". |

Edit the file, then run `node tools/publish-site.js`, which checks the file before publishing. Clients pick it up
within 6 hours, or at their next start. For anything urgent, also tell the testers.

## Watching (`node tools/monitor.js [hours]`)

During lecture weeks, look at least once a day. Watch for:

- **Load on ETH:** feed checks per second in the busiest hours, ETH's average answer time, and the error share (5xx, 429, timeouts).
  Rising answer times or any 429s mean ETH is struggling: set `slow: 2`.
- **By platform and version:** a new version with a higher error share than the old one is a bad release.
- **Questions on screen:** the median delay should stay at a few seconds. In big rooms only a sample of ~20 per question reports.
- **App starts (Android):** phones whose last start failed, with the reason (DNS blocked, proxy, network, WebView).
- **Relay rooms:** rooms with several phones and never a hint may mean the course's hints don't reach its room (course title mismatch).
- **Today against the free plan:** D1 rows written (limit 100,000 a day) and Worker requests (limit 100,000 a day, relay connections included).

Errors from the Worker itself (a failed metrics write, the daily cleanup) are in Cloudflare → Workers → fast-clicker-relay → Logs.

## Incidents

| What you see | What to do |
| --- | --- |
| ETH asks us to stop, or EduApp is down or overloaded | `pause: true`, publish, tell the testers. Lift it when ETH is fine again. |
| ETH slower than usual, 429s, timeouts | `slow: 2` (or more), publish. Back to 1 afterwards. |
| The relay is down or over its free quota | Clients check on their own and **ETH gets more requests** (worst case: phones that never reached the relay, every 8 s each). During lectures set `slow: 3` until the relay is back; check the Cloudflare dashboard; consider Workers Paid (5 USD/month). |
| A release misbehaves | Fix and release. If it is harmful meanwhile: `pause: true`. Once the fix is on every channel: `min` = the fixed version. |
| Metrics stop arriving | Worker logs (D1 errors), Cloudflare status. The apps keep working; only the monitoring is blind. |
| A tester can't get in (Android) | `node tools/monitor.js` → App starts: the check says DNS, proxy, network or WebView. |

## Budgets

**ETH**, per lecture room (`fast-clicker/README.md`, "Detection"):
- With the relay: the scouts make ~1 feed request a second together, and the standby phones' safety checks add up to
  ~3 a second in a big room. So 1–4 a second per lecture, whatever its size.
- Without the relay, each phone checks every 8–30 s: about 10 a second for 300 phones, about 33 for 1,000 (125 if none had ever reached the relay).
- Several lectures at once add up. Agree a budget with ETH before going past one or two courses.

**Cloudflare free plan** (per day):
- 100,000 Worker requests, which includes relay connections and reports; static pages are free.
- 100,000 Durable Object requests (a WebSocket message counts 1/20) and 13,000 GB-s.
- D1: 100,000 rows written and 5 million rows read.

At 1,000 students with two lectures a day, expect about 20,000 period reports, about 6,000 question reports
(sampled) and a few thousand connections. Each report is two D1 rows, so about 50,000 rows written: under the
limits, but not by much. Move to Workers Paid (5 USD/month: 10 million requests, 50 million D1 writes a month) before going past that.
If a quota runs out, the relay stops until midnight UTC and clients fall back to their own checks (see Incidents).

## Scaling up (gates)

1. **Before more than ~30 testers:** ask ETH (EduApp team / IT Services) about API use at this scale, a traffic budget, the name and
   look, and report the readable `DRAFT` questions (`fast-clicker/README.md`, "Store release"). Name one person who may pause
   enrollment (the owner).
2. **Pilot one course.** Then watch `monitor.js` through a full lecture week: ETH load, errors, delays, relay rooms.
3. **Then overlapping courses.** Watch the busiest hours.
4. **Distribution at scale:**
   - iPhone: TestFlight public link (up to 10,000 testers).
   - Android: Google Play *closed* testing (internal testing is capped at 100). It needs a Play Console account, and ETH's answer on the name.
   - Browsers: Chrome Web Store / Firefox add-ons, unlisted (owner's go first).

## Tests and data

`npm test` runs everything (about 3 minutes; `npm run test:quick` about 30 s). The tests use synthetic EduApp data in `tools/fixtures/`
(made by `tools/fixtures/make.js`; no captured ETH data, so they run anywhere). `FC_DATA=data npm test` runs the same tests
against a local capture in `data/`, which is never committed. Read-only probes against the real site are in `tools/research/`
and need a session cookie file; they are never run by CI.
