# EduApp Fast Clicker

A faster, more reliable client for the ETH EduApp clicker (eduapp.ethz.ch). It has three ways to install it, all using one script:

- `fast-clicker/eduapp-fast-clicker.user.js`: the core script. It is the only place to change behaviour. `fast-clicker/README.md` has the API notes and design.
- `node tools/build.js` builds everything else from it:
  - `site/`: install page, bookmarklet, pinned SRI script, browser add-on zip.
  - `ios/FastClicker/Resources/fast-clicker.js`: the copy the iPhone app uses.
- `ios/`: an iPhone app (a WKWebView shell, XcodeGen `project.yml`). GitHub Actions (`.github/workflows/ios.yml`) builds an unsigned `.ipa` and a simulator smoke test on every push to `ios/**`. `tools/get-ipa.ps1` copies the latest build to the Desktop for Sideloadly, using a free Apple ID that must re-sign the app every 7 days.

## Workflow

1. Edit the core script (or `ios/` Swift), then run `node tools/build.js`.
2. Run the tests: `node tools/test-mock.js`, `test-tabs.js`, `test-chaos.js`, `test-bookmarklet.js`, `verify-site.js`. They use a mock server and never contact ETH. Bump `VERSION` in the core script, plus `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in `ios/project.yml`, for user-visible changes.
3. Commit and push to `origin` (private GitHub repo). The iPhone build runs automatically.

## Rules

- Never send a clicker vote, post anything, or change settings on the user's behalf. Live checks against eduapp.ethz.ch are read-only.
- Never print or commit passwords, cookies or session values.
- Never commit `hermes_out/` or `data/`. They hold captured ETH data, and `hermes_out/cookies.json` holds a session secret. Tests read `data/` locally.
- No separate-origin website or credential proxy: login must stay on ETH's own pages (same-origin oauth2-proxy + Keycloak).
- Publishing anything publicly (GitHub Pages, stores) needs the user's explicit OK.
- "Authentication failed" on the login page is ETH's wrong-credentials message, not an app bug. A cookie or flow problem shows HTTP 500 instead.
