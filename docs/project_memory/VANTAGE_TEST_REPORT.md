# Vantage AutoTrader — Test Report

Date: 2026-10-21 (hardening pass; the first implementation pass was 2026-10-18).
Branch `feature/mt5-autotrader`, uncommitted working tree on top of `435466f`.

Everything below was verified **offline**: a simulated broker
(`worker/src/lib/simulatedBroker.ts`), an in-memory Firestore
(`worker/src/lib/testing/fakeFirestore.ts`), a fake GramJS client, a token table
for Firebase Auth (web), the **local Firestore emulator** (rules, project
`demo-bytrader`), and sandboxed shell runs of the deploy scripts. No order was
sent to Vantage, no ZeroMQ connection was opened, no real Firebase project was
read or written, and production (`worker/dist/`, PIDs 824/827) was not touched.

## 1. Commands and results

| Command (from repo root unless noted) | 2026-10-18 | 2026-10-21 |
|---|---|---|
| `npm run lint` (web, then worker) | PASS | **PASS** (exit 0; 8 pre-existing web warnings: `<img>`, react-hooks) |
| `npx tsc -p worker/tsconfig.json --noEmit` (strict) | PASS | **PASS** |
| `npx tsc -p web/tsconfig.json --noEmit` (includes web tests) | n/a | **PASS** |
| `cd worker && npx vitest run` | 34 files, 626 tests | **42 files, 764 tests, 0 failed** (2026-10-23) |
| `cd web && npx vitest run` (`npm run test:web`) | no tests | **5 files, 67 tests, 0 failed** (2026-10-23) |
| `bash tests/firestore-rules/run.sh` (`npm run test:rules`; emulator, Java 21) | no tests | **1 file, 10 tests, 0 failed** |
| `npm run build --workspace web` | PASS | **PASS** (new routes `/alerts`, `/signals`, `/api/alerts*`, `/api/signal-events*`, `/api/trades/[id]/resolve`) |
| `npx tsc -p worker/tsconfig.json --outDir <scratch>` | PASS | **PASS** (`worker/dist/` untouched) |
| Real preflight from the scratch build, `--stage pre` with a fake env file and the installed units (read-only) | n/a | **12 checks, 0 failed, 1 warning** (`WORKER_API_TOKEN` not set in the fake env) |
| MetaEditor compile of `mql5/VantageBridgeEA.mq5` | 0 errors, 0 warnings | not re-run (EA unchanged in this pass) |

Root `npm run build` was **not** run: it writes `worker/dist/`, which the
production services load.

## 2. Test files

### Worker (`worker/src/**/*.test.ts`)

| File | Tests | Area |
|---|---|---|
| `signalFeed.test.ts` | 30 | **Durable queue**: claim/lease, renewal, crash recovery with fencing, lease expiry on last attempt, backoff schedule, dead letters + alert, per-trade-set ordering, reply-cancel ordering, two workers, intake adoption, persisted cursor across a 45-min outage, cursor read failure, missing-index fallback, backlog alert, stats |
| `signalQueue.test.ts` | 17 | Pure queue rules: claim decisions, backoff/jitter, eligibility, history, requeue/discard rules |
| `signalOutbox.test.ts` | 9 | Forwarder spool: 0600 file, FIFO behind outbox, flush stop-at-failure, ALREADY_EXISTS after crash, restart, full outbox, corrupt lines, disabled |
| `alerts.test.ts` | 14 | Dedupe, coalescing, subjects, escalation re-opens ack, resolve/re-open, Firestore down, redaction, notifications off by default, webhook/Telegram bot, rate limit, https only |
| `alertMonitor.test.ts` | 10 | Bridge down (per mode), EA v1, terminal/AutoTrading, invalid config, live without flag, REAL account in demo, no broker use outside demo/live |
| `serviceHealth.test.ts` | 7 | Heartbeat sanitizing, stale/missing/degraded peer, Firestore outage recorded after recovery |
| `brokerAssumptions.test.ts` | 11 | Comment format, rewritten comment detected, ambiguous + rewritten comment stays SUBMIT_UNKNOWN (read-only), netting refused, expiry not applied → worker cancel, clock skew gate and reconciler wait, volume limit |
| `simulatedBroker.paper.test.ts` | 12 | Spec TTL, spec change applied and logged, refresh failure fails closed, legacy state refresh, quote outage, disconnect/recover, stale quote = market closed, no fills/SL on stale quotes, close-only session, partial closes and min-volume |
| `pipeline.e2e.test.ts` | 16 | +4: ambiguous entry across restart and expired lease; crash mid-gates; two workers; 30-min Firestore outage with forwarder outbox |
| `reconciler.test.ts` | 28 | +6 alert hooks: submit_unknown resolve/escalate/stale submitting, reconciliation_failed (mode, listing), unknown_position open/resolve |
| `lifecycleManager.test.ts` | 30 | +2: sl_modify_failed after 3, 10018 does not burn close attempts |
| `mt5TradeEngine.test.ts` | 46 | +3: submit_unknown and protection alerts, `quote_stale` |
| `mt5Client.test.ts` | 17 | +1: clock skew from PING |
| `mt5Broker.test.ts` | 37 | +1: GMT tick time, unknown offset → 0; `expirationApplied` |
| `brokerRouter.test.ts` | 22 | +1: paper only ever reads `SYMBOL_INFO` |
| `autotrader.test.ts` | 8 | +1: `/health` not ok for an EA v1; new health fields |
| `adminCommands.test.ts` | 18 | close_all_failed alerts asserted |
| `telegramListener.legacy.test.ts` | 3 | +1: Bybit modules are gone |
| `tools/preflight.test.ts` | 15 | Env key names only, live flag, loopback bridge/bind, build v2, units, control state, post health (DEMO vs REAL, EA, skew, loops), sandbox run changes nothing |
| `tools/deployScripts.test.ts` | 12 | Sandbox: dry runs change nothing, preflight abort, typed confirmations, backup + manifest, stop/start order, safe stop, EA abort, rollback, tampered backup, missing v1 dependency |
| Unchanged | | `executionProfile` 64, `positionSizing` 46, `entryPolicy` 31, `executionControl` 28, `lifecycleRules` 56, `simulatedBroker` 55, `tradeSetStore` 17, `tradeEvents` 10, `tradeSetTypes` 5, `firestoreAdmin` 6, `httpAuth` 17, `vipSignalParser` 16, `signalEvents` 7, `mt5TradeEngine.revision` 17, `telegramListener.{forward,edit,cancel,startup}` 1+1+7+2, `signalForwarding{.flow,}` 5+3, `telegramParser` 4, `crypto` 2 |

Removed with the Bybit engine: `tradeSizing.test.ts` (6).

### Web (`web/test/*.test.ts`)

| File | Tests | Area |
|---|---|---|
| `auth.test.ts` | 19 | No token / malformed header / invalid / revoked (checkRevoked) → 401; verification outage → 503; cookie path; **ALLOWED_EMAILS unset or blank → everyone refused, including admin, session and first sign-in**; unverified email; email case; viewer cannot mutate; no users doc ≠ admin; role lookup failure → 503; ensure creates viewer only |
| `profiles.test.ts` | 14 | Draft create (server version, audits), viewer refused, bad ids, invalid draft saved, edit only drafts, validate read-only with field/value/limit, approval refuses invalid / over-safety, activation typed confirm, activate + supersede + keep mode + rollback, tightened safety blocks activation, viewer read-only |
| `control.test.ts` | 14 | Kill switch (siblings kept, audit, boolean only, failed write no audit), modes with typed confirms, safety ceilings (field/value/limit), close-all exact confirm + command + audit + status, settings: telegram only, legacy trading keys refused |
| `operations.test.ts` | 11 | Alerts list order, unauth/outsider refused, ack/resolve audited, viewer refused; dead-letter list, requeue (role, confirm, reset, audit), superseded refusal, other trade set not blocking, discard; SUBMIT_UNKNOWN resolution (role, confirm, timing, event, audit, alert resolved, wrong state) |
| `views.test.ts` | 8 | Trade rows (schema 2 and legacy Bybit-era history), PnL, issue/active/closed filters, event mapping and timeline order, alert normalisation and counts |

### Firestore rules (`tests/firestore-rules/rules.test.ts`, emulator)

10 tests: admins and viewers read every dashboard collection; no users doc,
revoked role, unverified email and unauthenticated clients read nothing; users
read only their own users doc; worker-internal and unknown collections denied;
no client write anywhere (set, update, delete) even for admins; no self-created
or self-promoted users doc; kill switch, close-all command, profile status and
alert status cannot be changed from the client.

## 3. Requirement coverage (hardening pass)

| Requirement | Where it is tested |
|---|---|
| Persistent retry status, attempts, terminal states | `signalFeed.test.ts`, `signalQueue.test.ts` |
| Lease/claim for concurrent workers; lease expiry | `signalFeed.test.ts` (two workers, live lease, renewal, crash, fencing), e2e 15 |
| Exponential backoff, max retries, dead letter + visibility | `signalFeed.test.ts`, `operations.test.ts` (web) |
| Restart recovery beyond the 10-minute window | `signalFeed.test.ts` (45-min outage, pending found however old), e2e 13 |
| No duplicate orders after retries/restarts/ambiguity | e2e 13, 14, 15; `brokerAssumptions.test.ts` |
| Ordering of revisions behind their signal | `signalFeed.test.ts` (ordering), `signalOutbox.test.ts` (FIFO), e2e 15, 16 |
| Outage longer than 10 minutes | e2e 16 (30 min, forwarder outbox), `signalFeed.test.ts` |
| Alerts: bridge, unresolved submissions, partial closes, SL moves, unknown positions, reconciliation, Firestore, config, service health | `alertMonitor`, `reconciler`, `lifecycleManager`, `mt5TradeEngine`, `adminCommands`, `serviceHealth` tests |
| Alerts: severity, ack, dedupe, actions, no secrets, notifications off by default | `alerts.test.ts`, `operations.test.ts` (web) |
| Web authorization, viewer failures, unauthorized calls, ALLOWED_EMAILS missing | `auth.test.ts` |
| Profile creation, validation, approval, activation, rollback | `profiles.test.ts` |
| Kill switch, close-all confirmation | `control.test.ts` |
| Firestore access controls | `tests/firestore-rules` (emulator) |
| Dashboard trade events and states | `views.test.ts` |
| Paper spec refresh/changes, quote outage, disconnects, sessions, partial closes, no mutations | `simulatedBroker.paper.test.ts`, `brokerRouter.test.ts` |
| Protocol assumptions that can be simulated | `brokerAssumptions.test.ts`, `mt5Client.test.ts`, `mt5Broker.test.ts` |
| Deployment safety (dry run, backup, rollback, safe stop, account mode) | `preflight.test.ts`, `deployScripts.test.ts` |
| Bybit cannot execute; legacy history still displays | `telegramListener.legacy.test.ts`, `autotrader.test.ts`, `views.test.ts` |

## 4. End-to-end scenarios (`pipeline.e2e.test.ts`)

All 16 pass: (1) BUY through TP1/TP2/TP3 with SL moves; (2) SELL mirror;
(3) duplicate delivery + restart → one position, event not re-dispatched;
(4) edits after fill; (5) kill switch blocks entry, TP1 still closes; (6) paper
never calls MT5; (7) missing mode → disabled, forwarding continues;
(8) ambiguous entry → `SUBMIT_UNKNOWN` → one position; (9) broker rejection;
(10) close-all spares a foreign-magic position; (11) Firestore down → no broker
calls; (12) runtime safety violation → no entry, open trade managed;
**(13)** ambiguous entry never re-sent across a restart and an expired lease;
**(14)** crash mid-gates → stale signal skipped, nothing sent; **(15)** two
workers → one order, edit applied once after its signal; **(16)** 30-minute
Firestore outage → forwarder spools, edit applied afterwards, stale entry refused.

## 5. Not verified

- **No order has been sent through the v2 EA to Vantage**, demo or live. Every
  broker behaviour is simulated. `VANTAGE_BROKER_ASSUMPTIONS.md` lists what needs
  evidence (comment preservation, hedging, expiry support, id mapping, clock skew,
  volume specs, filling, history depth, 10018, tick time).
- The EA was compiled but never attached or run.
- Firestore rules were tested in the emulator but are **not deployed**; indexes
  are not deployed; the web routes have not run against a real Firebase project.
- The deploy and rollback scripts were tested in a sandbox only; they have not
  been run on the production host. The preflight's `--live` and `--firestore`
  checks have not been run against production.
- External alert notifications were tested with a fake `fetch` only.
- Docker images were not built; CI was not run on GitHub (the workflow now has
  web tests and a rules-emulator job).
- Production on this host still runs the v1 build from `worker/dist/`.

## 6. Demo verification log

Run of 2026-10-23 (Friday, from 15:53 UTC), authorized in writing by the owner
("You are authorized to create the demo orders, no limits"). Performed by the
agent on the VPS. Account login not recorded.

### Deployment

| Step | Result |
|---|---|
| Firestore indexes (`gcloud firestore indexes composite create`, project `marine-trader-2db4d`) | 3 created (`trade_events`, `trade_sets`, `signal_events`); built (`/health` → `orderedQuery: true`) |
| Freeze | `execution.mode = disabled`, kill switch engaged (audited) |
| MT5 | Terminal (build 6182, Wine 9.0) did not know Vantage's servers; added through *Open an Account → find "Vantage"*; logged in. Journal: "authorized on VantageMarkets-Demo … trading has been enabled, demo account - hedging mode". Downloaded update to build 6230 held back in `~/bytrader-deploy/liveupdate-6230-held/` |
| `deploy/deploy-v2.sh` dry run | 17 checks, 0 failed |
| `deploy/deploy-v2.sh --execute` (stamp `20261023T160954Z`) | Backup verified (36 files incl. v1 EA and units); services stopped, build swapped; EA v2 compiled (0 errors, 0 warnings) and attached via startup config (EURUSD M1); post preflight **18/18 PASS** incl. `account_mode DEMO`, EA 2.0.0, skew 0 s |

### Broker facts (read-only, through the v2 bridge)

| Fact | Value |
|---|---|
| `ACCOUNT_INFO` | `trade_mode DEMO`, `margin_mode HEDGING`, USD, balance 50 000, trade and expert trading allowed |
| PING | EA 2.0.0, terminal connected, server offset +10 800 s (UTC+3), `TimeGMT()` skew 0 s, broker ping ≈ 209 ms |
| `SYMBOL_INFO XAUUSD` | name `XAUUSD` (no suffix), digits 2, point 0.01, tick value 1, contract 100, volume 0.01–100 step 0.01, volume limit 0, stops level 20, freeze level 0, trade mode FULL, execution MARKET, **FOK no / IOC yes**, spread ≈ 28 points |

### Checklist (§16)

| # | Result | Evidence |
|---|---|---|
| P3/P4 | PASS | DEMO, HEDGING (above) |
| C1 | PASS | Profile `demo-xauusd-qa__v1`: fixed 0.02 lots, TP1/TP2 50/50, SL → entry + 0.1 after TP1, pending expiry 10 min, explicit cancel closes. Safety = defaults stored explicitly |
| C3/C4 | PASS after a fix | First activation refused with `invalid_profile: updated_by: unknown key` — **bug**: the AutoTrader stripped fewer envelope fields than the web routes write, so every dashboard-activated profile would have been refused at runtime. Fixed (shared `PROFILE_ENVELOPE_FIELDS`, regression tests in worker and web) |
| T1 market entry | PASS | Synthetic signal event 990001 (published to `signal_events` exactly as the forwarder does): BUY 0.02 filled at 4002.91 (ask 4002.89), SL 3999.89 / TP 4005.39 confirmed on the position (`protection_confirmed`), risk $5.22, event `done` in 1 attempt, ≈ 4 s end to end |
| T2 comment | **PASS (A1 evidence)** | Position and IN deal comment exactly `BT-3c0e440409a2`; position ticket = order ticket = deal `position_id` (A4 evidence) |
| T6 edit | PASS | Edit tightening SL to 4000.40 → `sl_modified`, `signal_revision_applied (sl_applied; tp_unchanged)`; broker SL 4000.40; nothing re-sent |
| T7 restart | PASS | `systemctl --user restart bytrader-autotrader`: `autotrader_startup_reconciled` (checked 1, errors 0); same single position; signal events not re-dispatched (attempts 1) |
| T4 partial close | PASS | TP1 4003.89 reached 16:22:05 → `partial_close_confirmed` 0.01 at 4004.02 (+1.11); remaining 0.01; no second close |
| T5 stop move | PASS | 3 s later `sl_modified after_checkpoint` → 4003.01 (entry 4002.91 + 0.10 buffer); the broker SL then closed the rest at 4003.01 (+0.10) → `CLOSED`, close_reason `sl`, realized 1.21 (matches broker deals). Closing deals carry broker comments (`""`, `[sl 4003.01]`) |
| T3 pending + expiry | PASS | BUY LIMIT 0.02 at 3998.37 (`PENDING_ORDER`, comment kept, `expiration_applied: true`); broker set expiry to the **minute** (16:32:00 instead of 16:32:53); expired → `CANCELLED` at 16:32:01 |
| Explicit cancel | PASS | BUY 0.02 opened, cancel event (`explicit_cancel`, profile `close_position`) → `CLOSED`, close_reason `cancel`, −1.16 |
| T10 close-all | PASS | SELL 0.02 opened; `admin_commands` close_all → kill switch engaged first, position closed in sweep 1, `done` after 2 sweeps; `CLOSED` close_reason `close_all` (−0.44); 0 positions on the account |
| T8 EA / terminal restart | PASS after a fix | Terminal stopped: `bridge_disconnected` (critical) within 30 s, `reconciliation_failed__demo`, forwarder watchdog warning; `/health` was slow (> 20 s) during the outage → **fixed** (reuses the monitor's fresh PING). A plain terminal restart does **not** log in (password not kept) and has no EA → **added** `deploy/mt5-start.sh` + user unit `bytrader-mt5.service`; recovery restored login and EA, and all alerts resolved automatically |
| T9 market closed | not exercised | Run ended before the Friday close |
| Fix redeploy | PASS | `deploy-v2.sh --execute` stamp `20261023T164606Z`: post preflight 18/18, 0 warnings; profile with `updated_by` / `activated_by_uid` now accepted; one more market entry + cancel on the new build (`CLOSED`, −0.10) |

### Issues found and fixed during the run

1. Profile envelope fields: the AutoTrader rejected profiles carrying `updated_by` / `*_by_uid`, which the web routes write. Shared `PROFILE_ENVELOPE_FIELDS` in `executionProfile.ts`; regression tests in `executionControl.test.ts` and `web/test/profiles.test.ts` (the latter fails on the old code).
2. Monitor reported the account mode only in demo/live, so the post-deploy check could not confirm DEMO while execution was disabled. Now read whenever the bridge answers.
3. `/health` blocked for > 20 s during a bridge outage. Now reuses the monitor's PING when < 30 s old.
4. MT5 did not restart logged in with the EA. `deploy/mt5-start.sh` + `bytrader-mt5.service` (enabled; lingering is on).
5. Vitest collected compiled tests from `worker/.dist-*`. `worker/vitest.config.mts` restricts tests to `src/`.

### State left in place (owner asked for demo trading)

- Mode `demo`, kill switch released, active profile `demo-xauusd-qa__v1` (0.02 lots fixed, TP1/TP2 50/50, SL to entry after TP1, explicit cancel closes). **Real signals from the source channel now execute on the demo account.**
- Account flat (0 positions, 0 orders) at 16:47 UTC. Demo P&L of the run: +1.21 −1.16 −0.44 −0.10 = −0.49 USD.
- Synthetic test trade sets are `-1003271337051_99000{1..5}`; their `signal_events` have `synthetic: "demo-qa"`.

