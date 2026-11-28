# ETH Clicker (unofficial)

A faster, more reliable replacement for the clicker section of ETH EduApp (eduapp.ethz.ch). It looks like EduApp's
own clicker pages. New questions appear by themselves within seconds, and answers get through on bad lecture-hall
Wi-Fi. It is **not made or endorsed by ETH Zurich**.

Install page (beta): https://clicker.fast-clicker-relay.workers.dev/

## How it fits together

```
fast-clicker/eduapp-fast-clicker.user.js   the one core script: all behaviour lives here
        │  node tools/build.js
        ├── ios/       iPhone app (WKWebView shell)                  → TestFlight
        ├── android/   Android app (WebView shell)                   → APK on the install page
        └── site/      install page, bookmarklet, pinned script, browser add-on → Cloudflare static site
relay/      optional hint relay (Cloudflare Worker, one Durable Object per lecture) + anonymous metrics (D1)
install/    what the install site publishes (site URL, control.json, every pinned script ever published)
tools/      build, tests, monitor, release helper
docs/       OPERATIONS.md: release, remote control, monitoring, incidents, budgets
```

The script runs only on eduapp.ethz.ch itself, in a browser tab, the add-on or the apps' web views, so login always
stays on ETH's own pages. The relay only ever passes "question N changed" between the students of one lecture.

## Working on it

```sh
npm run setup          # once: dependencies of tools/ and relay/ (from their lockfiles)
npm run build          # node tools/build.js: every channel from the core script
npm test               # every test (synthetic data, never contacts ETH); npm run test:quick for the short set
npm run monitor        # metrics of the last 24 h (needs `npx wrangler login`)
node tools/release.js  # release helper (see docs/OPERATIONS.md)
```

- Design and measurements: [`fast-clicker/README.md`](fast-clicker/README.md).
- Relay protocol and limits: [`relay/README.md`](relay/README.md).
- Operations runbook: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
- Project rules (binding, also for AI agents): [`AGENTS.md`](AGENTS.md).
