# ByTrader — Repository Map

> Verified against commit `435466f`, branch `feature/mt5-autotrader`.
> Generated/vendored directories (`node_modules/`, `.next/`, `dist/`) are
> described but not enumerated.

---

## 1. Top-level layout

```
ByTrader/
├── web/                     Next.js dashboard + proxy API routes (npm workspace)
├── worker/                  Trading engine: Telegram + Firestore + MT5 (npm workspace)
├── deploy/                  systemd units, VPS scripts, service/GUI documentation
├── mql5/                    MetaTrader 5 Expert Advisor source
├── docs/project_memory/     ← AI-oriented project memory (this document set)
├── .github/workflows/       CI
├── .vscode/                 Editor auto-approve settings (committed)
├── .commandcode/            Local agent tooling state (currently untracked)
├── .data/                   Local runtime artifacts (git-ignored)
├── package.json             Workspace root + orchestration scripts
├── tsconfig.base.json       Shared compiler options for the web workspace only
├── docker-compose.yml       web + worker services, .env-driven
├── .env / .env.local        Live secrets — NEVER read, print, or commit
├── .env.example             Variable template (incomplete — see §7)
└── *.MD, *.md               Project documentation (see PROJECT_CONTEXT.md §12)
```

**Directories that exist but are excluded above:**
`node_modules/` (root, hoisted — 658 entries), `web/node_modules/`,
`worker/node_modules/`, `web/.next/` (prior local build),
`worker/dist/` (prior `tsc` output), `worker/worker/data/` (stray tracked session
copy), `.git/`.

---

## 2. `worker/` — the trading engine

```
worker/
├── package.json             Scripts: dev, build, start, start:forwarder,
│                            start:autotrader, lint, test, seed:firestore
├── tsconfig.json            CommonJS/Node16, rootDir src → outDir dist
├── Dockerfile               Multi-stage; CMD = scripts/run-with-backoff.sh
├── .eslintrc.cjs            eslint + @typescript-eslint
├── scripts/
│   ├── initFirestore.js         Seeds settings/default + a system_logs entry
│   ├── inspectTelegramSettings.js  Read-only chat-ID diagnostic
│   └── run-with-backoff.sh      Docker CMD: 3 attempts with 5/15/60 s backoff
├── worker/data/
│   └── telegram.session.enc  ⚠ TRACKED IN GIT — encrypted session blob
└── src/
    ├── index.ts             ★ ENTRY POINT — Forwarder (:4000)
    ├── autotrader.ts        ★ ENTRY POINT — AutoTrader (:4001)
    └── lib/
        ├── telegramClient.ts      Telegram login/status/logout state machine
        ├── telegramSession.ts     Encrypted session file read/write
        ├── telegramListener.ts    Event handlers, filtering, dedupe, dispatch
        ├── vipSignalParser.ts     Gold/XAUUSD signal parser (current)
        ├── telegramParser.ts      Crypto signal parser (message history only; never executes)
        ├── signalForwarding.ts    Telegram→Telegram repost + revision tracking
        ├── signalEvents.ts        Producer: signal_events collection
        ├── signalFeed.ts          Consumer: polls signal_events
        ├── mt5TradeEngine.ts      Signal → MT5 order + trade_sets persistence
        ├── mt5Client.ts           ZeroMQ REQ client to the EA
        ├── mt5Secrets.ts          settings/default → mt5 config (30 s TTL cache)
        ├── lifecycleManager.ts    Break-even / trailing / cancel polling loop
        │   (tradeEngine / bybitClient / bybitSecrets / tradeSizing / tradingSettings: deleted 2026-10-21)
        ├── crypto.ts              AES-256-GCM encrypt/decrypt
        ├── firestoreAdmin.ts      Lazy Admin SDK init (returns null if unset)
        ├── logger.ts              stdout JSON logger
        ├── systemLog.ts           Firestore `system_logs` writer
        └── *.test.ts              9 Vitest files (co-located with sources)
```

**Two entry points, one shared `lib/`.** `index.ts` never imports
`autotrader.ts` and vice versa — the split is enforced by convention, not by
tooling.

**All 9 test files live in `src/lib/`**, next to the modules they cover:
`crypto.test.ts`, `signalFeed.test.ts`, `signalForwarding.test.ts`,
`signalForwarding.flow.test.ts`, `telegramListener.edit.test.ts`,
`telegramListener.forward.test.ts`, `telegramParser.test.ts`,
`tradeSizing.test.ts`, `vipSignalParser.test.ts`.

**Uncovered modules (no direct test):** `mt5Client.ts`, `mt5TradeEngine.ts`,
`tradeEngine.ts`, `lifecycleManager.ts`, `signalEvents.ts`, `tradingSettings.ts`,
`mt5Secrets.ts`, `bybitSecrets.ts`, `telegramClient.ts`, `telegramSession.ts`,
`bybitClient.ts`, `firestoreAdmin.ts`, `logger.ts`, `systemLog.ts`.

---

## 3. `web/` — the dashboard

```
web/
├── package.json             Scripts: dev, build, start, lint (NO test script)
├── Dockerfile               Multi-stage → npm run start on :3000
├── next.config.js           Only reactStrictMode: true
├── middleware.ts            ★ Edge auth gate on the bytrader_session cookie
├── tsconfig.json            @/* → ./src/*, allowJs, noEmit
├── tsconfig.base.json       Duplicate of the root tsconfig.base.json
├── tailwind.config.ts       marine/trade palettes, animations
├── postcss.config.js        tailwindcss + autoprefixer
├── .eslintrc.cjs            next/core-web-vitals
├── public/                  icon.png, logo.png, logo-white.png, logofull.png,
│                            tailwind.css (compiled, unreferenced)
└── src/
    ├── app/
    │   ├── layout.tsx           Root layout, imports globals.css
    │   ├── globals.css          Tailwind directives
    │   ├── error.tsx            Error boundary (renders its own <html>)
    │   ├── page.tsx             ★ Dashboard overview (481 lines)
    │   ├── login/page.tsx       Google sign-in
    │   ├── logs/page.tsx        Telegram / system / error log viewer
    │   ├── settings/page.tsx    Risk + Telegram settings (515 lines)
    │   ├── telegram/page.tsx    MTProto onboarding wizard
    │   ├── trades/page.tsx      Trade cards + event timeline
    │   ├── analytics/page.tsx   Aggregate counters
    │   ├── admin/page.tsx       Kill/paper flags + close-all request
    │   ├── */*.old.tsx          6 DEAD duplicates (see §6)
    │   └── api/
    │       ├── session/route.ts            POST sets cookie, DELETE clears
    │       ├── admin/ping/route.ts         POST admin-only probe
    │       ├── admin/role/route.ts         POST returns caller role
    │       ├── telegram/status|start|verify-otp|verify-password|logout
    │       └── worker/health/route.ts      GET worker health proxy
    ├── components/
    │   ├── DashboardShell.tsx      LEGACY shell (admin + analytics + .old pages)
    │   ├── layouts/DashboardLayout.tsx  CURRENT shell
    │   ├── navigation/{Sidebar,Header,index}.tsx
    │   ├── dashboard/{StatusBar,QuickActionsPanel}.tsx
    │   └── ui/{Button,StatusBadge,MetricCard,ActivityFeed,CollapsibleSection,
    │           CompactTable,FormField,QuickAction,index}.tsx
    ├── hooks/useInfiniteScroll.ts
    └── lib/
        ├── auth.ts            signInWithGoogle, signOutUser
        ├── useAuth.ts         Auth state + role resolution hook
        ├── firebaseClient.ts  Client SDK (browser-only init)
        ├── firebaseAdmin.ts   Server Admin SDK (returns null if unset)
        ├── workerApi.ts       getWorkerUrl() → WORKER_URL ?? localhost:4000
        ├── format.ts          formatTimestamp, isNonEmptyMessage
        ├── mockData.ts        DEAD — zero importers
        └── animations.ts      DEAD — zero importers
```

**Where to look for a given change**

| I need to change… | File |
|---|---|
| The logged-in user's landing page | `web/src/app/page.tsx` |
| The auth gate / protected routes | `web/middleware.ts` + `web/src/lib/useAuth.ts` |
| Session cookie semantics | `web/src/app/api/session/route.ts` |
| Risk / Telegram settings form | `web/src/app/settings/page.tsx` |
| Telegram onboarding UX | `web/src/app/telegram/page.tsx` |
| Log rendering | `web/src/app/logs/page.tsx` |
| Worker HTTP surface exposed to the browser | `web/src/app/api/telegram/*` |

---

## 4. `deploy/` — VPS operations

| File | Purpose |
|---|---|
| `SERVICES.md` | **Read this first.** Forwarder vs AutoTrader split, `signal_events` contract, env knobs |
| `MT5_GUI.md` | MT5/Wine install state, GUI toggle, Agent Hub preview, remaining manual steps |
| `bytrader-worker.service` | systemd unit → `node dist/index.js`, `EnvironmentFile=.env.local`, user `kyle` |
| `bytrader-autotrader.service` | systemd unit → `node dist/autotrader.js` |
| `mt5-xvfb.service` | Xvfb `:99` + Wine MT5 terminal |
| `install-services.sh` | Copies the three units into `/etc/systemd/system` and enables them (needs sudo) |
| `mt5-gui.sh` | on/off/status toggle for Xvfb + MT5 + x11vnc + websockify, all bound to localhost |
| `mt5-preview.sh` | Agent Hub "Preview" project service; idles out after `MT5_IDLE_SECS` (default 180) |
| `zmq-latency-test.sh` | Standalone REQ/REP RTT benchmark (Python REP + Node REQ); default threshold 0.5 ms |

**Hardcoded absolute paths** in these files target one specific host
(`/home/kyle/projects/ByTrader`, `/opt/bytrader/mt-copy-trader`,
`vmi3564509`, `~/.wine-mt5`). They are not portable.

---

## 5. `mql5/` — the Expert Advisor

| File | Purpose |
|---|---|
| `VantageBridgeEA.mq5` | 398-line MT5 EA. ZeroMQ `REP` socket on `tcp://127.0.0.1:5555`; actions `ORDER_SEND`, `ORDER_MODIFY`, `GET_POSITIONS`, `CLOSE_POSITION`; JSON envelope `{ok, retcode, data|error}` |
| `SETUP_INSTRUCTIONS.txt` | Placeholder note. **The file name is misleading** — it contains setup instructions for the missing third-party `JAson.mqh`, not a copy of it |
| *(missing)* | `JAson.mqh` and the `Zmq/` include folder are **not in this repository** despite the EA's header comment claiming JAson is bundled |

---

## 6. Dead / duplicate files worth knowing about

| Path | Why it matters |
|---|---|
| `web/src/app/*/page.old.tsx` (6 files) | Not routable (App Router uses `page.tsx`) and referenced by nothing, **but compiled** because `web/tsconfig.json` includes `**/*.tsx`. `settings/page.old.tsx` contains validation the live page lacks. |
| `web/src/lib/mockData.ts`, `web/src/lib/animations.ts` | Zero importers |
| `web/src/components/ui/index.ts`, `navigation/index.ts` | Barrel files with zero importers |
| `web/public/tailwind.css`, `logo-white.png`, `logofull.png` | Unreferenced assets (the CSS is a compiled build artifact, and it is tracked by git) |
| `web/tsconfig.tsbuildinfo` | Build artifact, tracked by git |
| `worker/worker/data/telegram.session.enc` | Encrypted session copy, **tracked by git** |
| `web/src/app/api/admin/ping/route.ts` | No caller inside the repo |
| `web/src/lib/auth.ts` → `signOutUser` | Only called by the dead `page.old.tsx`; there is no sign-out button in the live UI |

---

## 7. Configuration files and what they actually cover

| File | Covers | Gaps |
|---|---|---|
| `package.json` (root) | Workspaces, `dev`/`build`/`lint`/`test` orchestration, `engines.node >= 20` | No `format`, no `typecheck`, no `clean` |
| `tsconfig.base.json` (root) | Compiler options | **Not referenced by any workspace** — `web/tsconfig.json` extends its own `web/tsconfig.base.json`; `worker/tsconfig.json` extends nothing |
| `worker/tsconfig.json` | `src/**/*.ts` → `dist` | Compiles `*.test.ts` into `dist` as well |
| `.gitignore` | `node_modules`, `.next`, `.env`, `.env.*`, `*.log`, `.DS_Store`, `dist`, `coverage`, `.data` | Does **not** ignore `worker/worker/data/`, `web/tsconfig.tsbuildinfo`, or `web/public/tailwind.css` — all three are committed |
| `.env.example` | 25 variables | Missing `ALLOWED_EMAILS`, `WORKER_HEALTH_URL`, `WORKER_PORT`, `AUTOTRADER_PORT`, `MT5_*`, `SIGNAL_FEED_*`, `LIFECYCLE_INTERVAL_MS`; contains 7 `SMTP_*`/`VAPID_*` variables no code reads |
| `.eslintrc.cjs` (root) | Node ES2022 + `eslint:recommended` | Not wired to any script; no root `eslint` dependency declared |
| `.prettierrc` | Formatting rules | Prettier is not installed and nothing runs it |
| `.vscode/settings.json` | Terminal auto-approve allowlist (developer-specific, includes a sudo apt command) | Committed to the repo |
| `.github/workflows/ci.yml` | lint → build → test on node 20 | Triggers on `main`; default branch is `master` |
| `docker-compose.yml` | `web` (3001→3000) and `worker` (4000) with `env_file: .env` | **Does not define the AutoTrader service**; mounts an unused `telegram_session` volume; no healthchecks |

---

## 8. Fast navigation shortlist

Before touching execution logic, read in this order:

1. `deploy/SERVICES.md` — the two-service contract
2. `worker/src/index.ts` and `worker/src/autotrader.ts` — the two entry points
3. `worker/src/lib/telegramListener.ts` — where signals enter
4. `worker/src/lib/signalEvents.ts` → `signalFeed.ts` — the hand-off
5. `worker/src/lib/mt5TradeEngine.ts` → `mt5Client.ts` → `mql5/VantageBridgeEA.mq5` — the execution chain
6. `worker/src/lib/lifecycleManager.ts` — post-entry management

Before touching the dashboard, read:

1. `web/middleware.ts` and `web/src/app/api/session/route.ts` — auth model
2. `web/src/lib/firebaseClient.ts` — the null-when-unconfigured contract every page depends on
3. The relevant `web/src/app/*/page.tsx` (watch for its `.old.tsx` sibling)

---

## 9. Added by the Vantage completion work (2026-10-18)

### `worker/src/lib/`

| File | Role |
|---|---|
| `executionProfile.ts` | Pure profile + safety schema and validation (imported by web via `@shared/*`) |
| `positionSizing.ts` | Pure lot sizing and TP checkpoint planning |
| `entryPolicy.ts` | Pure market/pending entry decision and SL checks |
| `executionControl.ts` | Mode, kill switch, active profile, safety (fail closed, 5 s cache) |
| `tradeSetTypes.ts` | `trade_sets` schema 2, trade event types, correlation comment |
| `tradeSetStore.ts` | Trade-set persistence (atomic create, CAS transitions) |
| `tradeEvents.ts` | Idempotent `trade_events` writer |
| `brokerTypes.ts` | `BrokerAdapter` interface and error classes |
| `mt5Client.ts` | ZeroMQ protocol v2 client (rewritten) |
| `mt5Broker.ts` | `BrokerAdapter` over the EA |
| `simulatedBroker.ts` | Deterministic broker for paper mode and tests |
| `brokerRouter.ts` | Mode → broker, account-mode verification |
| `mt5TradeEngine.ts` | Engine: gates, sizing, submission, edits, cancels (rewritten) |
| `signalFeed.ts` | Durable `signal_events` consumer (rewritten) |
| `lifecycleRules.ts` | Pure checkpoint / BE / trailing rules |
| `lifecycleManager.ts` | Lifecycle loop (rewritten) |
| `reconciler.ts` | Broker ↔ Firestore reconciliation |
| `adminCommands.ts` | Close-all executor |
| `httpAuth.ts` | Worker HTTP bearer/loopback auth |
| `testing/fakeFirestore.ts`, `testing/e2eHarness.ts` | Test infrastructure |
| `pipeline.e2e.test.ts` | 16 offline end-to-end scenarios |

### `web/`

| Path | Role |
|---|---|
| `src/lib/serverAuth.ts`, `src/lib/adminApi.ts`, `src/lib/adminControl.ts` | Server auth gate, client `authedFetch`, admin DB helpers |
| `src/lib/profilePreview.ts` | Pure execution preview for the Profiles page |
| `src/app/api/settings`, `api/execution/*`, `api/admin/close-all` | Control routes |
| `src/app/api/profiles/**`, `src/app/profiles/` | Profile API and page |
| `src/app/api/users/ensure` | First-sign-in user doc (viewer) |

### Root and other

| Path | Role |
|---|---|
| `firestore.rules`, `firestore.indexes.json`, `firebase.json` | Rules (client writes denied) and indexes — not deployed |
| `.dockerignore` | Root build context for the web image |
| `mql5/PROTOCOL.md` | Bridge protocol v2 reference |
| `docs/project_memory/VANTAGE_*.md`, `OPTIMAL_REPORT_SCHEMA.md`, `examples/` | Design, guide, test report, progress, profile schema + example |

## 10. Added by the hardening pass (2026-10-21)

### `worker/src/lib/` and `worker/src/tools/`

| File | Role |
|---|---|
| `signalQueue.ts` | Pure durable-queue rules (status, claim, backoff, ordering, requeue/discard); imported by web |
| `signalFeed.ts` | Durable queue consumer (rewritten again: leases, dead letters, persisted cursor) |
| `signalOutbox.ts` | Forwarder-side local spool for events Firestore refused |
| `alertTypes.ts` | Pure alert types, operator actions, redaction; imported by web |
| `alerts.ts` | `raiseAlert` / `resolveAlert`, optional webhook / Telegram-bot notifications |
| `alertMonitor.ts` | AutoTrader health checks → alerts, AutoTrader heartbeat |
| `serviceHealth.ts` | Heartbeats in `service_status/*` and the peer watchdog |
| `bridgeHealth.ts` | Read-only PING shared by `/health` and the monitor; clock-skew limit |
| `brokerAssumptions.test.ts`, `simulatedBroker.paper.test.ts`, … | Simulated broker-assumption and paper-mode tests |
| `tools/preflight.ts` | Read-only deployment checks (shipped with the build) |

### `web/`

| Path | Role |
|---|---|
| `src/app/alerts/`, `src/app/api/alerts/**` | Alerts page and API (ack / resolve) |
| `src/app/signals/`, `src/app/api/signal-events/**` | Signal queue page and API (requeue / discard) |
| `src/app/api/trades/[id]/resolve` | Operator resolution of `SUBMIT_UNKNOWN` |
| `src/components/dashboard/AlertBanner.tsx` | Overview banner |
| `src/lib/tradeView.ts`, `src/lib/alertView.ts` | Pure view models (tested) |
| `test/`, `vitest.config.mts` | Route and view tests |

### Root and other

| Path | Role |
|---|---|
| `deploy/deploy-v2.sh`, `deploy/rollback-v2.sh` | Coordinated deployment and rollback (dry run by default) |
| `tests/firestore-rules/` | Firestore rules tests in the emulator (standalone package) |
| `docs/project_memory/VANTAGE_BROKER_ASSUMPTIONS.md` | Broker assumptions, safeguards, evidence needed, correlation fallback |

