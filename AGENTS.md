# ETH Clicker (EduApp Fast Clicker)

A replacement for the clicker section of ETH EduApp (eduapp.ethz.ch): it looks like EduApp's own clicker pages, but is faster and more reliable. Every way to install it (iPhone app, Android app, bookmarklet, browser add-on) uses one script:

- `fast-clicker/eduapp-fast-clicker.user.js`: the core script. It is the only place to change behaviour. `fast-clicker/README.md` has the API notes, the design and the known limits.
- `node tools/build.js` builds everything else from it:
  - `site/`: install page, bookmarklet, pinned SRI script, browser add-on zip.
  - `ios/FastClicker/Resources/fast-clicker.js` and `android/app/src/main/assets/fast-clicker.js`: the copies the apps use.
- `ios/`: an iPhone app (a WKWebView shell, XcodeGen `project.yml`). GitHub Actions (`.github/workflows/ios.yml`) builds an unsigned `.ipa` and a simulator smoke test on every push to `ios/**`. `tools/get-ipa.ps1` copies the latest build to the Desktop for Sideloadly, using a free Apple ID that must re-sign the app every 7 days.
- `android/`: the Android/Samsung app (Kotlin WebView shell with the same hooks as the iPhone app). GitHub Actions (`.github/workflows/android.yml`) builds a signed APK and runs an emulator smoke test on every push to `android/**`. The signing key is in GitHub secrets and in `android/keystore/` (gitignored, never commit or print it). `tools/get-apk.ps1` copies the latest APK to the Desktop; it installs directly on the phone, with no expiry.
- `relay/`: the optional hint relay (a small WebSocket service, Cloudflare Worker or Node; `relay/README.md` has the protocol). The students of one lecture share the work of noticing a new question through it. Its public address goes into `relay/relay-url.txt`, and `tools/build.js` puts it into every build. Without that file each client checks for itself.

## Workflow

1. Edit the core script (or `ios/` Swift, or `relay/`), then run `node tools/build.js`.
2. Run the tests: `node tools/test-mock.js`, `test-tabs.js`, `test-v3.js`, `test-chaos.js`, `test-bookmarklet.js`, `verify-site.js`, the relay's `node relay/test/run.js`, and `node tools/test-relay-e2e.js` (real clients against the real relay on a local port; needs `npm install` in `relay/` once). They use a mock server and never contact ETH. Bump `VERSION` in the core script, plus `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in `ios/project.yml` and `versionName` in `android/app/build.gradle.kts`, for user-visible changes. To test the Cloudflare relay locally: `npx wrangler dev --port 8799` in `relay/`, then `RELAY_URL=http://127.0.0.1:8799 node test/integration-only.js`.
3. Commit and push to `origin` (private GitHub repo). The iPhone and Android builds run automatically.

The reference for the look is EduApp itself: `hermes_out/v3/ui/` holds phone screenshots, HTML and style sheets of its clicker pages (local only).

## Rules

- Never send a clicker vote, post anything, or change settings on the user's behalf. Live checks against eduapp.ethz.ch are read-only.
- Never print or commit passwords, cookies or session values. ETH's public bundle embeds its build tokens: never print or use them.
- Never commit `hermes_out/` or `data/`. They hold captured ETH data, and `hermes_out/cookies.json` holds a session secret. Tests read `data/` locally.
- No separate-origin website or credential proxy: login must stay on ETH's own pages (same-origin oauth2-proxy + Keycloak).
- The relay may only ever carry "clicker N changed" hints. It must never receive ETH logins, cookies, question text or answers, and nothing it sends may make a client do more than read one question from ETH.
- No settings drawer (removed in v3.2 at the user's request): keep the screen to the app bar, the list and the question page. The timing recorder and the "peek next id" experiment were removed too; don't bring back reads of question ids the feed has not announced.
- Do not increase the load on ETH: one feed request at a time per client, never faster than every 4 s, and never download the semester list automatically during a lecture.
- Publishing anything publicly (GitHub Pages, stores) needs the user's explicit OK. Hosting the relay was approved on 2026-11-12.
- "Authentication failed" on the login page is ETH's wrong-credentials message, not an app bug. A cookie or flow problem shows HTTP 500 instead.
