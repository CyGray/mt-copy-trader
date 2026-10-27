# ByTrader — Development Guide

> Commands are marked **[VERIFIED FROM CONFIG]** (read out of `package.json`,
> Dockerfile, CI, or a service unit) or **[UNVERIFIED — NOT RUN]** (plausible but
> not executed during this review). Nothing in this document was executed.
> Verified against commit `435466f`.
>
> **Update 2026-10-21:** the legacy Bybit engine (`tradeEngine.ts`,
> `bybitClient.ts`, `bybitSecrets.ts`, `tradeSizing.ts`, `tradingSettings.ts`,
> `bybit-api`) was **deleted**, and the Bybit-era `trading.*` settings are no
> longer read or editable. Passages below that describe them are historical.
> Current state: `CURRENT_STATE.md`; operations: `VANTAGE_EXECUTION_GUIDE.md`.

---

## 1. Required tools

| Tool | Version | Evidence | Notes |
|---|---|---|---|
| Node.js | **>= 20** | `package.json` → `engines.node`; CI uses `node-version: 20` | The machine used for this review ran v24.20.0. There is **no `.nvmrc` or `.node-version`** file to pin it. |
| npm | 9+ (README) / 11.19.0 observed | `README.md` prerequisites | Workspaces are used, so npm 7+ is required |
| Git | any recent | — | Default branch is `master`; current work is on `feature/mt5-autotrader` |
| Docker + Compose | optional locally | `docker-compose.yml` (v3.9 schema) | Only covers `web` + `worker` (no AutoTrader) |
| Python 3 + `pyzmq` | optional | `deploy/zmq-latency-test.sh` | Only for the standalone ZMQ latency benchmark |
| Wine 9.0, Xvfb, x11vnc, websockify, noVNC | VPS only | `deploy/MT5_GUI.md` | Required only to run MT5 for real |
| MetaTrader 5 + `JAson.mqh` + `mql5-zmq` includes + `libzmq.dll` | VPS only | `mql5/SETUP_INSTRUCTIONS.txt`, `deploy/MT5_GUI.md` | **Not vendored in this repo** |

---

## 2. Dependency installation

```bash
npm install --no-audit --no-fund     # from the repository root
```
**[VERIFIED FROM CONFIG]** — used by CI (`.github/workflows/ci.yml`) and
documented in `guide.MD` and `README.md`.

- Single lockfile at the root (`package-lock.json`); workspaces are
  `web` and `worker` (`package.json`).
- Dependencies hoist to the root `node_modules` — in this checkout
  `web/node_modules` and `worker/node_modules` contain only tooling stubs.
- `web/` and `worker/` each also carry their own `package.json`; installing from
  inside a workspace directory is not the documented path.
- `worker/package.json` depends on `zeromq@^6.8.0`, which **builds native
  bindings**. A C/C++ toolchain (`build-essential`, `python3`, `make`) may be
  needed on a bare machine. **[UNVERIFIED]**

---

## 3. Environment configuration

```bash
cp .env.example .env          # documented in README.md
```

Both worker entry points load **`.env.local` from the parent directory first**,
then `.env`:

```ts
dotenv.config({ path: '../.env.local' });   // resolved against process.cwd()
dotenv.config();
```

**Consequence:** the `../` only resolves correctly when the process is started
from the `worker/` directory (which the systemd units enforce via
`WorkingDirectory=`). Running `node worker/dist/index.js` from the repository
root will silently load the *root* `.env` instead.

`.env.local` is what the systemd units reference
(`EnvironmentFile=/home/kyle/projects/ByTrader/.env.local`). Both `.env` and
`.env.local` are git-ignored (`.gitignore` has `.env` and `.env.*`).

> **Never print, copy, or commit the contents of `.env` / `.env.local`.**
> `.env.example` is the only safe reference.

### Where secrets are stored

| Secret | Storage | Protection |
|---|---|---|
| Telegram API id/hash | env (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`) | plain env |
| Telegram session | file at `TELEGRAM_SESSION_PATH` (default `process.cwd()/worker/data/telegram.session.enc`) | AES-256-GCM with `MASTER_KEY` |
| `MASTER_KEY` | env | 32 bytes, base64 or 64-char hex (`crypto.ts`) |
| Firebase service account | env (`FIREBASE_PROJECT_ID`/`CLIENT_EMAIL`/`PRIVATE_KEY`, `\n`-escaped) | plain env |
| Bybit API key/secret | env, then **mirrored into `settings/default.trading.bybit.*Enc`** encrypted with `MASTER_KEY` (`bybitSecrets.ts`) | AES-256-GCM |
| MT5 broker login | **not stored** — typed into the MT5 GUI by hand (`deploy/MT5_GUI.md`) | n/a |

---

## 4. Environment variable reference

Everything the code reads (`process.env.*`), plus what the docs mention.

| Variable | Purpose | Read in | Required? | Example |
|---|---|---|---|---|
| `MASTER_KEY` | AES-256-GCM key for session + Bybit creds | `worker/src/lib/crypto.ts` | **Required** (encryption throws without it) | `<32-byte base64 or 64 hex chars>` |
| `NODE_ENV` | Suppresses dev-only logging | `web/src/lib/auth.ts`, `useAuth.ts` | Optional | `production` |
| `WORKER_PORT` | Forwarder HTTP port | `worker/src/index.ts` | Optional (4000) | `4000` |
| `AUTOTRADER_PORT` | AutoTrader HTTP port | `worker/src/autotrader.ts` | Optional (4001) | `4001` |
| `WORKER_URL` | Forwarder base URL used by web proxies | `web/src/lib/workerApi.ts` | Optional (`http://localhost:4000`) | `http://worker:4000` |
| `WORKER_HEALTH_URL` | Full URL for the health proxy | `web/src/app/api/worker/health/route.ts` | Optional (`http://localhost:4000/health`) | `https://worker.example.com/health` |
| `ALLOWED_EMAILS` | Comma-separated sign-in allow-list | `web/src/app/api/session/route.ts` | Optional — **if unset, ANY Google account is allowed** | `you@example.com` |
| `FIREBASE_PROJECT_ID` | Admin SDK credential | worker `firestoreAdmin.ts`, web `firebaseAdmin.ts`, `scripts/*.js` | **Required** for any Firestore feature | `my-project` |
| `FIREBASE_CLIENT_EMAIL` | Admin SDK credential | same | **Required** | `sa@my-project.iam.gserviceaccount.com` |
| `FIREBASE_PRIVATE_KEY` | Admin SDK credential, `\n`-escaped | same | **Required** | `-----BEGIN PRIVATE KEY-----\n…` |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Client SDK config | `web/src/lib/firebaseClient.ts` | **Required** (build-time inlined) | `AIza…` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Client SDK config | same | Optional (falls back to `<projectId>.firebaseapp.com`) | `my-project.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Client SDK config | same | **Required** | `my-project` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Client SDK config | same | Optional | `my-project.appspot.com` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Client SDK config | same | Optional | `1234567890` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Client SDK config | same | Optional | `1:123:web:abc` |
| `TELEGRAM_API_ID` | MTProto app id | `worker/src/lib/telegramClient.ts` | **Required** for Telegram | `1234567` |
| `TELEGRAM_API_HASH` | MTProto app hash | same | **Required** | `abcdef…` |
| `TELEGRAM_SESSION_PATH` | Encrypted session file location | `worker/src/lib/telegramSession.ts` | Optional (see caveat below) | `/data/telegram/session.enc` |
| `BYBIT_API_KEY` | Legacy Bybit credential | `worker/src/lib/bybitSecrets.ts` | Optional (Firestore may hold it) | — |
| `BYBIT_API_SECRET` | Legacy Bybit credential | same | Optional | — |
| `BYBIT_TESTNET` | `true`/`1` → testnet | same | Optional (false) | `true` |
| `MT5_ZMQ_ENDPOINT` | Bridge endpoint | `worker/src/lib/mt5Client.ts` | Optional (`tcp://127.0.0.1:5555`) | `tcp://127.0.0.1:5555` |
| `MT5_TIMEOUT_MS` | REQ/REP timeout | same | Optional (5000) | `5000` |
| `MT5_ALERT_CHAT_ID` | Logged with bridge alerts | same | Optional | `-100…` |
| `SIGNAL_FEED_INTERVAL_MS` | Poll interval | `worker/src/lib/signalFeed.ts` | Optional (3000) | `3000` |
| `SIGNAL_FEED_LOOKBACK_MS` | Replay window on start | same | Optional (300000) | `300000` |
| `LIFECYCLE_INTERVAL_MS` | Lifecycle poll interval | `worker/src/autotrader.ts` | Optional (2000) | `2000` |

### Declared in `.env.example` but **never read by any code**

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
The notification system does not exist. (Verified by repository-wide search: the
strings appear only in `.env.example`, `README.md`, `engineering-spec.MD`,
`implementation-plan.MD`.)

### Referenced in code but **missing from `.env.example`**

`ALLOWED_EMAILS`, `WORKER_HEALTH_URL`, `WORKER_PORT`, `AUTOTRADER_PORT`,
`MT5_ZMQ_ENDPOINT`, `MT5_TIMEOUT_MS`, `MT5_ALERT_CHAT_ID`,
`SIGNAL_FEED_INTERVAL_MS`, `SIGNAL_FEED_LOOKBACK_MS`, `LIFECYCLE_INTERVAL_MS`.
`NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` appears in `vercel.MD` but is read by no code.

### ⚠️ `TELEGRAM_SESSION_PATH` default is cwd-dependent

`telegramSession.ts` computes the default as
`path.resolve(process.cwd(), 'worker', 'data', 'telegram.session.enc')`.
Starting from the repo root yields `<repo>/worker/data/…`; starting from
`worker/` yields `<repo>/worker/worker/data/…`. Two such files exist in this
checkout, and **`worker/worker/data/telegram.session.enc` is committed to git**
(the root `.data/` copy is ignored). Set `TELEGRAM_SESSION_PATH` explicitly in
any new environment to avoid creating more copies. Do not delete the tracked file
without checking whether it is still in use.

---

## 5. Firestore setup

```bash
npm run seed:firestore --workspace worker
```
**[VERIFIED FROM CONFIG]** — script exists (`worker/scripts/initFirestore.js`,
wired as `seed:firestore`) and is documented in `README.md` and `guide.MD`.

Creates `settings/default` if absent (with empty `trading`, `notifications`, and
`telegram.allowed_chat_ids`/`blocked_chat_ids`) and appends a
`system_logs` entry. Requires the three `FIREBASE_*` variables; the script loads
`../.env.local` and then `.env`, so **it must be run from `worker/`** (which
`--workspace worker` does).

Collections are otherwise created on first write. There is **no migration
system and no schema version** anywhere.

A read-only diagnostic is available but not wired to a script:
```bash
node worker/scripts/inspectTelegramSettings.js    # run from worker/
```
It prints the configured chat IDs and their `-100…`/`-…` variants.

---

## 6. Running locally

### Both services (web + worker) at once
```bash
npm run dev
```
**[VERIFIED FROM CONFIG]** — `concurrently -n web,worker` running
`npm run dev --workspace web` and `--workspace worker`.
Web: <http://localhost:3000> · Worker health: <http://localhost:4000/health>

> This starts the **forwarder only**. The AutoTrader is not part of `npm run dev`.

### Individually
```bash
npm run dev --workspace web        # next dev
npm run dev --workspace worker     # ts-node-dev --respawn --transpile-only src/index.ts   (forwarder)
```
There is **no npm script to run the AutoTrader in dev mode**. The closest option
is to build and run it directly:
```bash
npx tsc -p worker/tsconfig.json   # from the repo root
node worker/dist/autotrader.js    # must be run with cwd=worker/ for dotenv to work
```
**[UNVERIFIED — NOT RUN]**

### Via Docker Compose
```bash
docker-compose up -d --build
docker-compose logs -f
```
**[VERIFIED FROM CONFIG]** (`docker-compose.yml`, `README.md`, `DEPLOYMENT.md`).
Serves web on **port 3001** (mapped to container 3000) and worker on 4000. Does
**not** start the AutoTrader, and has no healthchecks. `guide.MD` notes Docker
was unavailable on the original developer's machine, so compose startup is
effectively untested there.

### Production (VPS, systemd)
```bash
cd ~/projects/ByTrader/worker && npx tsc -p tsconfig.json
systemctl --user restart bytrader-worker.service      # forwarder, :4000
systemctl --user restart bytrader-autotrader.service  # AutoTrader, :4001
```
**[VERIFIED FROM CONFIG]** — documented in `deploy/SERVICES.md` and
`deploy/MT5_GUI.md`. The `npx tsc` build is shared between both services; only the
restart is per-service.

Install the units once with `sudo ./deploy/install-services.sh`
(needs root; the GUI toggle and `systemctl --user` do not).

---

## 7. Build, lint, and test

| Command | Scope | Evidence | Notes |
|---|---|---|---|
| `npm run build` | web then worker | root `package.json` | `next build` then `tsc -p tsconfig.json` |
| `npm run lint` | web then worker | root `package.json` | `next lint` then `eslint . --ext .ts` |
| `npm test` | **worker only** | root `package.json` → `npm run test --workspace worker` → `vitest run` | See §7.1 |
| `npm run test --workspace worker` | worker | `worker/package.json` | Vitest |
| `npm run start:autotrader` | worker | `worker/package.json` | `node dist/autotrader.js` (build first) |

**[UNVERIFIED — NOT RUN]** — none of these were executed during this review; they
are transcribed from configuration only.

### 7.1 Test discovery and known gaps

- There is **no `vitest.config.*` or `vite.config.*` anywhere**, and no `test`
  field in any `package.json`.
- Vitest 2.x therefore uses its defaults: include
  `**/*.{test,spec}.?(c|m)[jt]s?(x)`, excluding `node_modules` and `dist`. The
  nine `worker/src/lib/*.test.ts` files are matched when Vitest runs with
  `cwd = worker/`, which is what the npm workspace script does. **[CONFIRMED by
  reading the config files and the package scripts]**
- **`web/` has no test script and no tests.**
- `worker/tsconfig.json` includes `src/**/*.ts`, so `npm run build` also compiles
  the test files into `worker/dist/lib/` (harmless for Vitest, but they end up in
  the Docker image).
- Coverage gaps are listed in `REPOSITORY_MAP.md` §2.

---

## 8. Development conventions observed in the code

These are the patterns the existing code actually follows — match them.

1. **Firestore access goes through `initFirestore()`**, which returns `null` when
   credentials are absent. Every caller is expected to no-op on `null` rather
   than throw. Follow this contract; do not add throwing variants.
2. **Every module-level config loader has a TTL cache and a hardcoded
   `DEFAULT_*` fallback.** Examples: `signalForwarding.ts` (`CONFIG_TTL_MS =
   30_000`), `mt5Secrets.ts` (`CONFIG_TTL_MS = 30_000`), `telegramListener.ts`
   (`SETTINGS_TTL_MS = 30_000`). `tradingSettings.ts` is the exception — it has a
   `DEFAULT_SETTINGS` fallback but no cache, so it reads Firestore on every call.
3. **Dual logging.** Use `logger.info/warn/error(event, payload)` for stdout and
   `writeSystemLog(level, component, message, details)` for Firestore. Most
   significant code paths write both.
4. **Idempotency by Firestore document id**, not by locking. `trade_sets` is
   keyed `${chatId}_${messageId}`; `signal_events` adds the text hash;
   `telegram_messages` adds the text hash. Always check `doc.exists` before
   acting.
5. **Import style.** Worker uses extensionless CommonJS-style relative imports in
   most files, but test files deliberately import `'./module.js'` so Vitest's
   ESM resolver picks up the TypeScript source. Do not "fix" those `.js`
   specifiers.
6. **Firestore field naming**: settings are snake_case on disk
   (`risk_value`, `mt5_optional`); TypeScript objects are camelCase. Conversion
   happens inside the loader.
7. **No comments policy in practice** — the code is mostly comment-free except
   for file-header docblocks on the newer MT5 modules
   (`signalEvents.ts`, `signalFeed.ts`, `lifecycleManager.ts`, `mt5Client.ts`,
   `mt5TradeEngine.ts`, `mt5Secrets.ts`). Newer files follow that pattern.
8. **Web pages are client components** using `onSnapshot`/`getDocs` directly;
   there is no data-fetching layer, no server components doing DB work, and only
   three API routes that talk to the Admin SDK.
9. **Tailwind only** — no CSS modules, no styled-components, despite
   `styled-jsx` being a declared (unused) dependency.
10. **Formatting**: Prettier is configured (`.prettierrc`) but not installed, so
    formatting is convention-only. Match the existing single-quote,
    semicolon, trailing-comma style.

---

## 9. Git workflow

**[INFERRED — no CONTRIBUTING.md exists]**

- Default branch: `master` (`origin/HEAD`). Work happens on feature branches.
- Commit subjects follow Conventional Commits (`feat:`, `fix:`, `refactor:`,
  `docs:`) with a scope, e.g. `refactor(worker): split forwarder and MT5
  AutoTrader into separate services`.
- 29 commits total; remote `origin` = `https://github.com/CyGray/mt-copy-trader.git`.
- Several `agent/cmd/task-*` branches exist locally — automation artifacts.
  `Revert "…"` commits appear in history, indicating some churn.
- **No PR template, no CODEOWNERS, no branch protection evidence, no git hooks,
  and no `.gitattributes`.**

### ⚠️ CI does not run on the default branch

`.github/workflows/ci.yml` triggers on `push.branches: ["main"]` and on all pull
requests. The repository's default branch is **`master`**, so pushes to `master`
do **not** trigger CI. Only PRs do. **[CONFIRMED]**

---

## 10. Known setup issues and traps

| Issue | Detail |
|---|---|
| `npm run dev` doesn't start the AutoTrader | Only the forwarder runs; MT5 execution requires a built `dist/autotrader.js` |
| `dotenv` uses `../.env.local` | Breaks if the process is not started from `worker/` |
| Session file path is cwd-dependent | Can silently create/read a different session file; set `TELEGRAM_SESSION_PATH` |
| No `ALLOWED_EMAILS` in `.env.example` | Forgetting to set it means the dashboard is open to any Google account in the Firebase project |
| Worker/`web` containers don't receive `NEXT_PUBLIC_*` at build time | Client Firebase init fails silently inside a Docker-built web image |
| No `.dockerignore` in either workspace | `COPY . .` sweeps host `node_modules`/`.next` into the build context |
| `zeromq` native build | Requires a toolchain on a bare machine |
| `web/tsconfig.tsbuildinfo` is committed | Stale incremental-build state can confuse local type checks; delete locally if needed |
| Test files compile into `dist` | Cosmetic, but they ship in the Docker image |
| No `.env.example` entry for MT5/feed/lifecycle knobs | Their defaults live in `deploy/SERVICES.md` and in the source, not in the template |
| Docs disagree on the Node version | `package.json` → `engines.node >= 20` and CI pins node 20, but `README.md` "Prerequisites" says Node 18. Treat **20 as the requirement** and fix the README when next touched. |

---

## 11. Validating a change (recommended sequence)

Nothing below was executed during this review; it is assembled from the scripts
that exist.

```bash
npm install --no-audit --no-fund
npm run lint
npm run build
npm test                     # worker unit tests only
```

Then, for worker changes, a smoke check against a running stack:

```bash
curl -s localhost:4000/health   # {"service":"forwarder","telegram":"authorized",…}
curl -s localhost:4001/health   # {"mt5Bridge":"ok","signalFeed":"running",…}
```

Remember there is **no test coverage for `web/`** and no integration test that
exercises the Telegram → Firestore → MT5 chain end to end.

---

## 12. Vantage AutoTrader additions (2026-10-18)

### ⚠️ `worker/dist/` is the production artifact on the VPS host

The systemd units run `worker/dist/index.js` and `worker/dist/autotrader.js`
with `Restart=always`. **`npm run build` at the root (or in `worker/`) rewrites
`worker/dist/`**, and the next restart would load it. For checks use:

```bash
npm run typecheck                                   # worker tsc --noEmit (strict)
npx tsc -p worker/tsconfig.json --outDir /tmp/worker-dist-check   # emit check
npm run build:web                                   # web only
```

Deploy procedure: `VANTAGE_EXECUTION_GUIDE.md` §17 (worker and EA v2 together).

### New scripts

| Script | Does |
|---|---|
| `npm run dev:autotrader` | AutoTrader with `ts-node-dev` (`npm run dev` still starts only web + forwarder) |
| `npm run typecheck` | Worker strict type-check, no emit |
| `npm run lint:web` / `npm run lint:worker` | One workspace |
| `npm run build:web` | Web build only (safe on the VPS host) |

### New environment variables

| Variable | Default | Read by | Meaning |
|---|---|---|---|
| `WORKER_HOST` | `127.0.0.1` | `index.ts` | Forwarder listen address |
| `AUTOTRADER_HOST` | `127.0.0.1` | `autotrader.ts` | AutoTrader listen address |
| `WORKER_API_TOKEN` | unset | `httpAuth.ts`, web `workerApi.ts` | Bearer token for `/telegram/*`, `/mt5/*`; unset = loopback only |
| `BYTRADER_LIVE_TRADING` | unset | `executionControl.ts`, `brokerRouter.ts` | Must be exactly `enabled` for mode `live` to open trades |
| `MT5_ZMQ_ENDPOINT` | `tcp://127.0.0.1:5555` | `mt5Client.ts` | EA bridge (keep private) |
| `MT5_TIMEOUT_MS` | `5000` | `mt5Client.ts` | Per-request timeout |
| `LIFECYCLE_INTERVAL_MS` | `2000` | `autotrader.ts` | Lifecycle tick |
| `SIGNAL_FEED_INTERVAL_MS` | `3000` | `signalFeed.ts` | Feed poll |
| `SIGNAL_FEED_LOOKBACK_MS` | `600000` | `signalFeed.ts` | Startup re-dispatch window |
| `ALLOWED_EMAILS` | unset | web `serverAuth.ts` | Comma-separated allow-list; set it in production |

Empty strings are treated as unset for the MT5 variables.

### Conventions added

- `worker/tsconfig.json` now has `"strict": true` (it was off despite AGENTS.md).
- Tests never open sockets: inject `setBrokerForTests(mode, broker)` with
  `createSimulatedBroker(...)`, and use `worker/src/lib/testing/fakeFirestore.ts`.
- Broker mutations: persist intent first, never retry on timeout, resolve from
  broker state (`VANTAGE_DESIGN_CONTRACTS.md` §0).
- Web mutations go through API routes guarded by `requireAdmin`
  (`web/src/lib/serverAuth.ts`); pages call them with `authedFetch`
  (`web/src/lib/adminApi.ts`). The web imports pure worker modules through the
  `@shared/*` alias (`next.config.js` `externalDir`).

## 13. Hardening pass additions (2026-10-21)

### Scripts

| Script | Does |
|---|---|
| `npm run test:web` | Web API route and view-model tests (`web/test`, Vitest, fake Firestore + token table) |
| `npm run test:rules` | Firestore rules in the local emulator (`tests/firestore-rules/run.sh`; Java 21 from `PATH` or downloaded into `.cache/`; project `demo-bytrader`, 127.0.0.1:8080) |
| `deploy/deploy-v2.sh` | Deployment dry run (temp build in `worker/.dist-dryrun-*`, read-only preflight, plan). `--execute` deploys (§17 of the guide) |
| `deploy/rollback-v2.sh` | Rollback dry run; `--execute` restores the recorded deployment |

`tests/firestore-rules` is a standalone npm package (not a workspace): install
there with `npm ci --prefix tests/firestore-rules`; it never touches the root
`node_modules`.

### Environment variables

| Variable | Default | Read by | Meaning |
|---|---|---|---|
| `ALLOWED_EMAILS` | unset → **everyone refused** | web `serverAuth.ts`, `/api/session` | Dashboard allow-list (fail closed) |
| `SIGNAL_FEED_MAX_ATTEMPTS` / `_LEASE_MS` / `_RETRY_BASE_MS` / `_RETRY_MAX_MS` | 8 / 120000 / 5000 / 300000 | `signalFeed.ts` | Durable queue |
| `SIGNAL_FEED_LOOKBACK_MS` | 600000 | `signalFeed.ts` | First start without a stored cursor only |
| `SIGNAL_OUTBOX` / `SIGNAL_OUTBOX_PATH` / `SIGNAL_OUTBOX_MAX` | enabled / next to the session / 5000 | `signalEvents.ts` | Forwarder spool |
| `MAX_QUOTE_AGE_SEC` / `MAX_CLOCK_SKEW_SEC` | 60 / 5 | `mt5TradeEngine.ts`, `bridgeHealth.ts` | `quote_stale` / `clock_skew` gates |
| `PAPER_SPEC_TTL_MS` / `PAPER_MAX_QUOTE_AGE_MS` | 900000 / 60000 | `brokerRouter.ts` | Paper broker |
| `ALERT_MONITOR_INTERVAL_MS`, `SERVICE_STALE_MS` | 15000, 180000 | `alertMonitor.ts`, `serviceHealth.ts` | Monitor and heartbeats |
| `ALERT_NOTIFICATIONS`, `ALERT_NOTIFY_MIN_SEVERITY`, `ALERT_WEBHOOK_URL`, `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` | off, `error` | `alerts.ts` | Optional external notifications |

### Conventions added

- Raise operator-visible problems with `raiseAlert` / `resolveAlert` (`alerts.ts`).
- Web tests mock `@/lib/firebaseAdmin` and use the worker's fake Firestore
  (`@shared/testing/fakeFirestore`), which now supports batches, `mergeFields`
  and queries inside transactions; `setOffline(true)` simulates an outage.
- `worker/.dist-*` (deploy staging, previous and failed builds) is git-ignored.
