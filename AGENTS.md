# ETH Clicker (unofficial clicker for EduApp)

A replacement for the clicker section of ETH EduApp (eduapp.ethz.ch). It looks like EduApp's own clicker pages, but is
faster and more reliable. Every way to install it (iPhone app, Android app, bookmarklet, browser add-on) uses one
script. Overview: `README.md`. Release, remote control, monitoring and incidents: `docs/OPERATIONS.md`.

- `fast-clicker/eduapp-fast-clicker.user.js`: the core script. It is the only place to change behaviour. `fast-clicker/README.md` has the API notes, the design and the known limits.
- `node tools/build.js` builds everything else from it:
  - `site/`: the install page, the bookmarklet, the pinned SRI script, and the browser add-on with its zip;
  - `ios/FastClicker/Resources/fast-clicker.js` and `android/app/src/main/assets/fast-clicker.js`: the copies the apps inject.

  The build is reproducible. CI fails if the committed copies don't match the sources.
- `ios/`: the iPhone app (a WKWebView shell, XcodeGen `project.yml`). It reaches testers through TestFlight (`ios-testflight.yml`, `ios/TESTFLIGHT.md`). `ios.yml` is an unsigned compile check.
- `android/`: the Android app (a Kotlin WebView shell with the same hooks as the iPhone app, plus `StartReport.kt` start-up diagnostics). `android.yml` builds a signed APK and runs an emulator smoke test. The signing key is in GitHub secrets and in `android/keystore/` (gitignored, never commit or print it).
- `relay/`: the optional hint relay, a Cloudflare Worker with one Durable Object per lecture room (`relay/README.md` has the protocol). It also serves `POST /v1/report` (metrics into D1, `relay/migrations/`) and runs a daily cleanup cron. Its address is in `relay/relay-url.txt`, and `tools/build.js` puts it into every build.
- `install/`: what `tools/publish-site.js` publishes besides `site/`:
  - `site-url.txt`;
  - `control.json`, the remote control: pause, slow, minimum version, "update available";
  - `contact.txt`;
  - every pinned script ever published (`pins/`, `published-pins.txt`).
- `version.json`: the one version. `node tools/version.js x.y.z` sets it in the script, `ios/project.yml` and the Android `versionName`.

## Workflow

1. Edit the core script (or `ios/`, `android/`, `relay/`), then run `node tools/build.js`.
2. Run `npm test` (every suite, about 3 minutes) or `npm run test:quick`. The tests use synthetic EduApp data (`tools/fixtures/`) and a mock server, and never contact ETH. For a user-visible change, run `node tools/version.js x.y.z`. To test the Cloudflare relay locally: run `npx wrangler dev --port 8799` in `relay/`, then `RELAY_URL=http://127.0.0.1:8799 node test/integration-only.js` (CI does this too).
3. Commit and push to `origin`, a public GitHub repo, so Actions minutes are free. `test.yml` runs on every push. Release steps follow `docs/OPERATIONS.md` (`node tools/release.js check|android|apk|ios`).

The reference for the look is EduApp itself: `hermes_out/v3/ui/` holds phone screenshots, HTML and style sheets of its clicker pages (local only).

## Rules

- Never send a clicker vote, post anything, or change settings on the user's behalf. Live checks against eduapp.ethz.ch are read-only.
- Never print or commit passwords, cookies or session values. ETH's public bundle embeds its build tokens: never print or use them.
- Never commit `hermes_out/` or `data/`. They hold captured ETH data, and `hermes_out/cookies.json` holds a session secret. Tests use the synthetic `tools/fixtures/` (`FC_DATA=data` runs them against the local capture). Never put captured texts, answers or results into fixtures.
- No separate-origin website or credential proxy: login must stay on ETH's own pages (same-origin oauth2-proxy + Keycloak).
- The relay may only ever carry "clicker N changed" hints. It must never receive ETH logins, cookies, question text or answers. Nothing it sends may make a client do more than read one question from ETH.
- The remote control (`install/control.json`) may only make clients do less (pause, slow, stop old versions, "update available"). It never carries text, links or code.
- Beta monitoring (approved by the user on 2026-11-24): apps send anonymous diagnostics to the relay's `POST /v1/report`.
  - Allowed: numbers and booleans only (timings, counts, error classes, relay state), plus a random per-install id.
  - Never: names, logins, courses, question ids, texts or answers.
  - Storage: Cloudflare D1 `clicker-metrics` for 90 days, together with relay room snapshots. Read with `node tools/monitor.js [hours]`.
  - Keep it numbers-only, sampled where volume demands, and disclosed on the install and privacy pages.
- App builds are started by hand (`node tools/release.js android` / `ios`, or `gh workflow run …`). Only the tests run on push.
- No settings drawer (removed in v3.2 at the user's request): keep the screen to the app bar, the list and the question page. The timing recorder and the "peek next id" experiment were removed too; don't bring back reads of question ids the feed has not announced.
- Question/answer HTML from ETH is always shown through `clean()` (never raw `innerHTML`). Apps load only https `*.ethz.ch` pages (main view and login window); keep it that way.
- The user-facing name is "ETH Clicker" (the user's choice on 2026-11-24).
  - Always mark it unofficial / not made by ETH Zurich, and never use ETH's logo.
  - Keep EduApp's look, including the EduApp-style clicker icon (restored 2026-11-24).
  - A store release under this name and look needs ETH's permission.
  - App ids: Android `ch.students.clicker`, iOS `ch.students.clicker`.
- Beta install page: `node tools/publish-site.js` publishes it to https://clicker.fast-clicker-relay.workers.dev/ (approved by the user on 2026-11-23).
  - Pinned scripts listed in `install/published-pins.txt` must stay online.
  - App Store / Play Store publication still needs the user's explicit go and ETH's answer (`fast-clicker/README.md`, "Store release"; `docs/OPERATIONS.md`, "Scaling up").
- Do not increase the load on ETH: one feed request at a time per client, never faster than every 4 s, and never download the semester list automatically during a lecture. Budgets per lecture: `docs/OPERATIONS.md`.
- Publishing anything publicly (GitHub Pages, stores) needs the user's explicit OK.
  - Hosting the relay was approved on 2026-11-12.
  - The GitHub repo was made public on 2026-11-24 at the user's request (author email in history accepted by the user). Everything committed is public: never commit secrets, captured ETH data or personal details.
- "Authentication failed" on the login page is ETH's wrong-credentials message, not an app bug. A cookie or flow problem shows HTTP 500 instead.
