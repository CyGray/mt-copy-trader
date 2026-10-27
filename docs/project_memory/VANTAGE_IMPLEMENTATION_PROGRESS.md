# Vantage AutoTrader — Implementation Progress

Started 2026-10-18 on branch `feature/mt5-autotrader` @ `435466f`.
Interface spec: `VANTAGE_DESIGN_CONTRACTS.md`.

## Host safety notes (read first)

- `bytrader-worker.service` and `bytrader-autotrader.service` are **running on
  this host** from `worker/dist/` (since 2026-09-24, `Restart=always`). Writing
  `worker/dist/` (e.g. `npm run build` in the worker) would put unreviewed code
  into production at the next restart. During this work the worker is
  type-checked with `--noEmit` or built into a scratch `--outDir`. Services
  are not restarted.
- No MT5 terminal process was running at the time of review, so the deployed
  AutoTrader cannot currently reach the bridge.
- MetaEditor exists at `~/.wine-mt5/drive_c/Program Files/MetaTrader 5/`.

## Phase 0 — baseline (before changes)

| Command | Result |
|---|---|
| `npm test` | PASS — 9 files, 37 tests |
| worker `tsc --noEmit` | PASS |
| worker `npm run lint` | FAIL — 9 errors (unused vars, `any` in tradeEngine.ts) |
| web `npm run lint` / `next build` | FAIL — 15 `no-unused-vars` errors |
| root `npm run lint` / `npm run build` | FAIL (short-circuit at web) |

Key defects confirmed in reconnaissance (file:line as of `435466f`):

1. Legacy Bybit execution invoked from `telegramListener.ts:374` with no source gate.
2. Pending orders never placed (`mt5TradeEngine.ts:190` drops `orderType`).
3. Only TP3 attached at full volume; no partial closes (`mt5TradeEngine.ts:199`).
4. Risk sizing unreachable (`mt5Secrets.ts:49-52` rejects 0 → fixed 0.05 lots).
5. Break-even/trailing can never trigger (`lifecycleManager.ts:163-168` uses `open_price`).
6. Order symbol ignores signal symbol (`mt5TradeEngine.ts:194`).
7. `mt5Send` re-sends `ORDER_SEND` after timeout → duplicate entries possible.
8. One REQ socket shared without serialization.
9. Signal feed advances cursor before dispatch → failed events lost.
10. EA processes requests only in `OnTick`; no ownership check on modify/close; IOC hardcoded.
11. Kill switch / paper mode / close-all are UI-only; no worker consumer.
12. Worker HTTP endpoints unauthenticated and bound to all interfaces; web telegram proxies unauthenticated.
13. CI triggers on `main`; default branch is `master`. docker-compose has no AutoTrader.

## Work plan

| ID | Workstream | Files (ownership) | Status |
|---|---|---|---|
| A1 | Execution profile + sizing + TP planner (pure) | `executionProfile.ts`, `positionSizing.ts`, `entryPolicy.ts`, `OPTIMAL_REPORT_SCHEMA.md` | in progress |
| A2 | Trade-set types, trade events, execution control, `initFirestore` never-throw | `tradeSetTypes.ts`, `tradeEvents.ts`, `executionControl.ts`, `firestoreAdmin.ts`, `systemLog.ts` | in progress |
| B | EA protocol v2 hardening | `mql5/*` | in progress |
| C | Broker layer: client queue, adapter, simulated broker, router | `brokerTypes.ts`, `mt5Client.ts`, `mt5Broker.ts`, `simulatedBroker.ts`, `brokerRouter.ts` | in progress |
| D | Forwarder: disable Bybit, cancel intent, listener race | `telegramListener.ts`, `vipSignalParser.ts`, `signalEvents.ts` | in progress |
| E1 | Web: lint, server auth, control APIs | `web/**` | in progress |
| E2 | Infra: worker HTTP binding/auth, CI, compose, rules | `worker/src/index.ts`, `.github/`, `docker-compose.yml`, `firestore.rules`, Dockerfiles | in progress |
| F | Trade engine + durable signal feed | `mt5TradeEngine.ts`, `signalFeed.ts` | pending (needs A, C) |
| G | Lifecycle, reconciler, admin commands | `lifecycleManager.ts`, `reconciler.ts`, `adminCommands.ts` | pending (needs A, C) |
| H | Web profile management + trade history | `web/src/app/profiles/**`, `api/profiles/**`, trades page | pending (needs A1, E1) |
| I | AutoTrader wiring + end-to-end simulated tests | `autotrader.ts`, `pipeline.e2e.test.ts` | pending |
| J | Docs + final validation | `docs/**` | pending |

## Architecture decisions

- **AD-1 Bybit:** the Telegram path no longer calls `handleParsedSignal`. Legacy
  files remain on disk per AGENTS.md; deletion is an owner decision (backlog A1).
- **AD-2 Broker correlation:** each trade set gets `correlation_comment =
  BT-<12 hex of sha256(trade_set_id)>`, sent as the MT5 order comment. The EA
  refuses a second `ORDER_SEND` with the same comment + magic (duplicate guard),
  and the reconciler resolves ambiguous submissions by that comment.
- **AD-3 Request expiry:** mutating requests carry `expires_at`; the EA rejects
  expired requests, which bounds when an ambiguous request can still execute.
- **AD-4 No mutation retries in the client.** Ambiguity is surfaced as
  `SUBMIT_UNKNOWN` / checkpoint `closing` and resolved from broker state.
- **AD-5 Checkpoint idempotency by target remaining volume.** A checkpoint is
  done when position volume ≤ its target remaining volume; the close amount is
  computed from current volume, never a fixed delta.
- **AD-6 Partial closes on a single position** via `PositionClosePartial`
  (works on hedging and netting accounts); broker-side TP set to the final
  checkpoint so the last leg closes even if the AutoTrader is down.
- **AD-7 Claim by atomic `create()`** of `trade_sets/{chatId}_{messageId}`;
  stale claims re-taken by transactional compare-and-set on the same document
  (idempotency by document id, no separate lock collection).
- **AD-8 Profile snapshot** is embedded in each trade set; activation of a new
  profile never changes open trades.
- **AD-9 Fail closed:** unreadable execution config → mode `disabled` + kill
  switch; missing mode → `disabled`; missing profile → no entries.
- **AD-10 Kill switch** blocks new entries only; protective management continues.
- **AD-11 Strict profile validation (owner decision 2026-10-18):** fixed lots
  above the allowed maximum is an error (`volume_exceeds_max`, never clamped);
  any profile value above a hard ceiling or the current safety limits is a
  validation error with field, value and limit. Invalid profiles cannot be
  activated, and the engine re-validates at runtime and refuses new entries
  (fail closed). Risk-derived sizing may still clamp *down* to the lot maximum
  (that only lowers risk) and records `clampedBy`. Open trades keep being
  managed under their frozen snapshot.
- **AD-12 Persistence required for execution:** if Firestore is unavailable,
  execution control fails closed (no new entries); the broker is never called
  for an entry without a persisted `SUBMITTING` intent.

## Wave 1 results

- **A1 done** — `executionProfile.ts` (strict validation, hard ceilings as
  errors with value/limit, `validateProfileAgainstSafety`), `positionSizing.ts`
  (`volume_exceeds_max`, `volume_not_step_aligned`, integer step arithmetic),
  `entryPolicy.ts`, example profile + `OPTIMAL_REPORT_SCHEMA.md`. 141 tests.
- **A2 done** — `tradeSetTypes.ts`, `tradeEvents.ts`, `executionControl.ts`
  (fail closed), `initFirestore()` never throws (60 s failure cache, key
  redacted), `writeSystemLog` cannot throw. Integration fix by lead:
  `executionControl` now rejects an active profile that violates the current
  safety limits (`validateProfileAgainstSafety`), +2 tests.
- **B done** — EA protocol v2 (`mql5/VantageBridgeEA.mq5`, `PROTOCOL.md`).
  **Compiled with MetaEditor on this host: 0 errors, 0 warnings** (copy under a
  temporary folder/name, deleted afterwards; deployed v1 `.mq5/.ex5` untouched).
  Runtime behaviour on Vantage is **unverified**. Side effect: MetaEditor
  rewrote its own config files (`Config/metaeditor.ini`, `Config/jupyter.ini`,
  profile notes) in `~/.wine-mt5`. Note: `ORDER_SEND.expiration` and
  `GET_DEALS` times are broker **server time**; the client converts using the
  `PING` server/GMT offset. v2 EA refuses v1 requests → worker and EA must be
  deployed together.
- **D done** — Bybit call removed from the Telegram path (static guard test),
  `detectCancelIntent`, cancel events with `cancel_reason`/`trigger_message_id`
  (reply-targeted explicit cancels), idempotent `publishSignalEvent` with
  retries + double logging, single-flight listener startup.
- **E2 done** — forwarder binds `WORKER_HOST` (127.0.0.1), bearer/loopback
  auth on `/telegram/*`, phone masked, CI on `master`+`main`, compose with
  forwarder + autotrader (no host ports for workers), `firestore.rules`
  (deny all client writes), `.dockerignore`s, unit files (repo copies only).
- **E1 done** — `serverAuth.ts` (`requireAdmin` always checks role, fails
  closed), `adminApi.ts`, control routes (`/api/settings`,
  `/api/execution/{mode,kill-switch,safety,status}`, `/api/admin/close-all`),
  Telegram proxies require admin, pages write through the API only, web
  lint/build pass. Paper-mode toggle replaced by execution-mode selector.
- **C done** — `brokerTypes.ts`, protocol-v2 `mt5Client.ts` (FIFO-serialized,
  no mutation retries, ambiguous timeouts carry `expiresAt`), `mt5Broker.ts`
  (server-time conversion), `simulatedBroker.ts`, `brokerRouter.ts`
  (`getBroker` is async). 386 worker tests passing at that point. Follow-up in
  progress: paper broker resolves symbol specs per symbol on demand.

## Wave 2 results

- **F done** — `tradeSetStore.ts`, rewritten `mt5TradeEngine.ts` (full gate
  chain incl. runtime re-validation, intent-before-send, ambiguous →
  `SUBMIT_UNKNOWN`, revisions/cancels from the frozen snapshot), durable
  `signalFeed.ts` (retry queue 5/15/60 s × 5, 10-min startup lookback,
  sequential processing, `autotrader` status on `signal_events`),
  `testing/fakeFirestore.ts`.
- **G done** — pure `lifecycleRules.ts`, rewritten `lifecycleManager.ts`
  (uses `priceCurrent`, target-remaining-volume checkpoint idempotency,
  BE/trailing/after-checkpoint tighten-only), `reconciler.ts`,
  `adminCommands.ts` (close-all). Mutation check: disabling the volume-based
  `mark_done` breaks 3 tests, so the double-close guard is load-bearing.
  Lead fix: `previous_tp` on the first checkpoint now falls back to entry ±
  buffer in the protective direction (was below entry).
- **H done** — profile API (`/api/profiles/**`: create draft, update draft,
  validate + preview, approve, reject, activate with typed confirm, rollback,
  audit), Profiles page, schema-2 trades page with event timeline, analytics,
  `/api/users/ensure` (replaces client `users/{uid}` write),
  `firestore.indexes.json`, Docker web build from repo root. Lead fix:
  `firestore.rules` reads now require a `users/{uid}` doc (created only via the
  allow-listed ensure route), so a Google account outside `ALLOWED_EMAILS`
  cannot read trading data.

## Wave 3 results

- **I1 done** — partial-fill re-plan in the engine; `close_requested_by` typed;
  fresh kill-switch/profile/mode re-check right before persisting intent;
  close-all second sweep after a 10 s settle + in-flight entries flagged and
  closed by the reconciler; `autotrader.ts` rewired (binds `AUTOTRADER_HOST`,
  `/mt5/*` behind token/loopback, no magic exposed, startup reconciliation
  before the feed, all four loops started, graceful shutdown, EA-version
  warning); **`strict: true` enabled** in `worker/tsconfig.json`; worker lint
  clean (legacy `tradeEngine.ts` `any`s typed, behaviour unchanged).
- **I2 done** — `pipeline.e2e.test.ts`: 12 offline end-to-end scenarios
  (Telegram → forward → signal_events → engine → simulated broker → lifecycle
  → CLOSED, BUY/SELL, duplicates + restart, edits, kill switch, paper
  isolation, disabled mode, ambiguous entry, rejection, close-all with foreign
  position untouched, Firestore outage, runtime safety violation).
- **J done** — `VANTAGE_EXECUTION_GUIDE.md` (operator guide incl. demo
  verification §16 and deploy/rollback §17), `VANTAGE_TEST_REPORT.md`;
  `CURRENT_STATE.md` rewritten; `ARCHITECTURE.md` §0 (current implementation)
  added with superseded passages flagged; `PLANNING_BACKLOG.md` status table +
  new priorities; `DEVELOPMENT_GUIDE.md` §12 and `REPOSITORY_MAP.md` §9;
  `AGENTS.md` rules 9–13; `deploy/MT5_GUI.md` / `deploy/SERVICES.md` EA v2
  coordination. (The docs agent stopped after the guide; the lead finished the
  rest.)

## Status: all locally achievable work complete

Nothing is committed. Production (`worker/dist/`, PIDs from 2026-09-24) was not
touched. Remaining work needs the owner: demo verification, coordinated deploy,
Firestore rules/indexes deploy, `ALLOWED_EMAILS`, alerting
(`PLANNING_BACKLOG.md` §0).

## Final validation (2026-10-18 08:45, lead)

| Command | Result |
|---|---|
| `npm run lint` (root: web + worker) | PASS (exit 0; web has pre-existing warnings only) |
| `npx tsc -p worker/tsconfig.json --noEmit` (strict) | PASS |
| `cd worker && npx vitest run` | PASS — 34 files, 626 tests |
| `npm run build --workspace web` | PASS |
| worker emit to scratch `--outDir` | PASS; `worker/dist/` untouched |
| MetaEditor compile of EA v2 (temp copy) | 0 errors, 0 warnings |

Root `npm run build` was deliberately **not** run because it writes
`worker/dist/`, which the running production services load.

## Test log

| When | Command | Result |
|---|---|---|
| after A1/A2/D | `npx vitest run` (worker) | 21 files, 267 passed |
| after A2 integration | profile/control/event suites | 7 files, 190 passed |

## Blockers / external verification

- EA compilation and broker behaviour (filling modes, netting vs hedging,
  deal→position ids, comment preservation on Vantage) require the VPS terminal.
- Vantage demo smoke test requires explicit owner authorization and a confirmed
  demo account.
- Firestore rules must be deployed by the owner (`firebase deploy --only firestore:rules`).

## Hardening pass (2026-10-21)

Done offline; nothing deployed, production (`worker/dist/`, PIDs 824/827) untouched.

1. Durable signal queue: per-event status, lease and backoff on `signal_events.autotrader` (`signalQueue.ts`, `signalFeed.ts`), dead letters with requeue/discard, persisted intake cursor, and a forwarder outbox (`signalOutbox.ts`).
2. Operator alerts: `alerts.ts`/`alertTypes.ts`, `alertMonitor.ts`, heartbeats/watchdog (`serviceHealth.ts`), and the Alerts and Signal queue pages. External notifications are off by default.
3. Web tests: 66 Vitest tests in `web/test`. Firestore rules: 10 emulator tests in `tests/firestore-rules`. `ALLOWED_EMAILS` now fails closed and `email_verified` is required. The rules require role admin or viewer.
4. Paper mode: spec TTL, stale quote treated as a closed market, and a check that paper only ever reads from the bridge.
5. Broker safeguards:
   - entry gates: `account_netting`, `clock_skew`, `quote_stale`, `symbol_volume_limit`;
   - comment-preservation alert;
   - the reconciler never concludes "not executed" while a look-alike fill exists;
   - pending orders the broker left without an expiry are cancelled by the worker;
   - a market-closed refusal (10018) does not use up partial-close attempts;
   - operator resolution route for a stuck `SUBMIT_UNKNOWN`.
   See `VANTAGE_BROKER_ASSUMPTIONS.md`.
6. Deployment: `deploy/deploy-v2.sh` and `deploy/rollback-v2.sh` (dry run by default, typed confirmations), plus `worker/src/tools/preflight.ts`. Guide §16–19 rewritten.
7. Bybit execution modules and the `bybit-api` dependency removed. The lockfile changed, `node_modules` did not, so a v1 rollback still works. The legacy trading knobs on the Settings page were removed.

Validation: lint PASS; worker and web strict tsc PASS; worker 762/762, web 66/66, rules 10/10 tests; web build PASS; scratch worker emit PASS.
Docs refreshed 2026-10-23: CURRENT_STATE.md, PLANNING_BACKLOG.md (§00), AGENTS.md, deploy/SERVICES.md, README.md.

## Deployment and demo run (2026-10-23, owner-authorized)

- Firestore indexes created with gcloud; execution frozen; MT5 taught the Vantage servers through the GUI (driven with xdotool on Xvfb) and logged in to `VantageMarkets-Demo` (DEMO, hedging).
- `deploy/deploy-v2.sh --execute` (stamp `20261023T160954Z`): v1 backed up, EA v2 compiled and attached, post preflight 18/18.
- Demo checklist T1–T8 and T10 passed; T9 not exercised (`VANTAGE_TEST_REPORT.md` §6).
- Bugs found and fixed: profile envelope fields (dashboard profiles would never trade), account mode unreported while disabled, slow `/health` during outages, terminal not recovering after restart (`deploy/mt5-start.sh`, `bytrader-mt5.service`), Vitest picking up build copies. Fix redeploy `20261023T164606Z`, post preflight 18/18.
- Left running: mode `demo`, profile `demo-xauusd-qa__v1`, kill switch released; real channel signals trade on the demo account.
- Tests: worker 764, web 67, rules 10 (unchanged rules).

