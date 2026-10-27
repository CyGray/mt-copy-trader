# ByTrader — Current State

> Feature-by-feature status of the working tree on branch
> `feature/mt5-autotrader` (on top of `435466f`), updated 2026-10-23 after the
> hardening pass of 2026-10-21. "Implemented" means the code exists, is wired
> and is covered by offline tests — **not** that it has been verified against
> Vantage. Nothing in this work has sent a broker order.
>
> **Production note (2026-10-23):** v2 is **deployed** on the VPS host (worker
> from `worker/dist/`, VantageBridgeEA 2.0.0, MT5 terminal managed by
> `bytrader-mt5.service`), connected to the Vantage **demo** account (hedging).
> Firestore indexes are deployed; rules and the web app are not. The owner
> authorized demo trading: mode `demo` with profile `demo-xauusd-qa__v1`. The
> demo checklist passed (`VANTAGE_TEST_REPORT.md` §6). Live trading remains
> impossible (DEMO account, no `BYTRADER_LIVE_TRADING`).

Related: `VANTAGE_IMPLEMENTATION_PROGRESS.md` (decisions, history),
`VANTAGE_TEST_REPORT.md` (commands and coverage), `VANTAGE_DESIGN_CONTRACTS.md`
(interfaces), `OPTIMAL_REPORT_SCHEMA.md` (profile format),
`VANTAGE_BROKER_ASSUMPTIONS.md` (what still needs Vantage evidence).

---

## 1. How to read this document

| Label | Meaning |
|---|---|
| **Implemented** | Complete, reachable code path with offline tests (simulated broker, fake Firestore, emulator) |
| **Implemented (broker-unverified)** | As above, but correctness also depends on Vantage/MT5 behaviour that has not been observed |
| **Partial** | Works, but a companion piece is missing |
| **Not implemented** | Absent |

---

## 2. Implemented

| Feature | Files | Notes |
|---|---|---|
| Telegram user login, encrypted session, expiry detection | `telegramClient.ts`, `telegramSession.ts`, `crypto.ts` | Unchanged |
| Message capture incl. edits, chat filters, dedupe | `telegramListener.ts` | Single-flight start; message-history write failures no longer stop forwarding/publishing |
| Gold signal parsing + cancel intent | `vipSignalParser.ts` | `detectCancelIntent` |
| Legacy crypto parse for message history | `telegramParser.ts` | Fills `telegram_messages.parsed`; never executed |
| Telegram → Telegram forwarding | `signalForwarding.ts` | Unchanged format; happens regardless of execution mode |
| **Bybit execution removed** | — | `tradeEngine`, `bybitClient`, `bybitSecrets`, `tradeSizing`, `tradingSettings` deleted; `bybit-api` out of `package.json` (still in `node_modules` for v1 rollback). Legacy trade records still display |
| Idempotent signal hand-off + local outbox | `signalEvents.ts`, `signalOutbox.ts` | `create()`; events written with `autotrader.status = pending`; Firestore failures spooled to a 0600 JSONL file, FIFO, flushed every 15 s |
| **Durable signal queue** | `signalQueue.ts`, `signalFeed.ts` | Per-event status, transactional claim with renewed lease, fenced completion, exponential backoff, 8 attempts → dead letter, per-trade-set ordering, persisted intake cursor, multi-worker safe |
| Dead-letter recovery | `/signals`, `/api/signal-events/**` | Requeue (refused when superseded) / discard, typed confirmation, audited |
| Execution modes `disabled` / `paper` / `demo` / `live` | `executionControl.ts`, `brokerRouter.ts` | Missing mode → disabled; demo requires DEMO; live requires REAL **and** `BYTRADER_LIVE_TRADING=enabled`; netting accounts refused |
| Kill switch | `executionControl.ts`, `mt5TradeEngine.ts` | Blocks new entries (gates + fresh re-check before send); protective management continues |
| Fail-closed configuration | `executionControl.ts`, `firestoreAdmin.ts` | Unreadable config → disabled + kill switch; `initFirestore()` never throws |
| Execution profiles (Optimal Report target) | `executionProfile.ts`, `OPTIMAL_REPORT_SCHEMA.md` | Strict validation; ceilings and current safety limits are errors (field, value, limit) |
| Profile lifecycle | `web/src/app/api/profiles/**`, `web/src/app/profiles/` | Draft → validate/preview → approve → activate (typed confirm) → rollback; audit trail; web-tested |
| Risk sizing / entry policy | `positionSizing.ts`, `entryPolicy.ts` | Unchanged |
| Safety gates | `mt5TradeEngine.ts` | + `clock_skew`, `quote_stale`, `symbol_volume_limit`, `account_netting` |
| Order submission with broker correlation | `mt5TradeEngine.ts`, `tradeSetTypes.ts` | Intent persisted first; comment `BT-<12 hex>`; ambiguous → `SUBMIT_UNKNOWN`, never resent; post-fill comment check |
| Partial take-profits | `lifecycleManager.ts`, `lifecycleRules.ts` | Idempotent by target remaining volume; 10018 does not burn attempts |
| Break-even, trailing, SL after checkpoints | `lifecycleRules.ts` | Current price, tighten-only |
| Pending-order expiry | `mt5TradeEngine.ts`, `lifecycleManager.ts` | `expiration_applied` recorded; worker cancels a pending entry 30 s past its expiry |
| Edits and cancellations | `mt5TradeEngine.ts` | Per frozen profile snapshot |
| Reconciliation | `reconciler.ts` | Waits for a lagging EA clock; never concludes "not executed" while an unlinked look-alike fill exists |
| Operator resolution of stuck `SUBMIT_UNKNOWN` | `/api/trades/[id]/resolve`, Trades page | Record only, 120 s after expiry, typed confirmation, audited |
| Emergency close-all | `adminCommands.ts`, `/api/admin/close-all` | Typed confirm, kill switch first, owned only, two sweeps; failure alert |
| **Operator alerts** | `alerts.ts`, `alertTypes.ts`, `alertMonitor.ts`, `/alerts`, `/api/alerts/**` | Durable, deduplicated, severity, ack/resolve, auto-resolve, actions, redaction; optional webhook / Telegram-bot notifications off by default |
| Service heartbeats and watchdog | `serviceHealth.ts`, `index.ts`, `autotrader.ts` | `service_status/*` every 15 s; each service alerts on the other; Firestore outage recorded on recovery |
| Trade events | `tradeEvents.ts` | Deterministic ids in `trade_events`; dashboard timeline |
| Paper trading | `simulatedBroker.ts`, `brokerRouter.ts` | Spec TTL (15 min, fail closed), stale quote = closed market, only `SYMBOL_INFO` reads from the bridge |
| AutoTrader service | `autotrader.ts` | `/health`: protocol, EA compatibility, skew, account mode, loops, queue stats, issues |
| Worker HTTP hardening | `index.ts`, `httpAuth.ts` | Loopback binding; bearer token or loopback; phone masked; forwarder `/health` shows outbox depth |
| Web server-side authorization | `web/src/lib/serverAuth.ts` | Verified token (revocation checked), verified email, `ALLOWED_EMAILS` **fail closed**, admin role for mutations |
| Dashboard | `web/src/app/{page,admin,settings,profiles,trades,analytics,telegram,alerts,signals}` | Settings page no longer shows the dead Bybit-era knobs |
| Firestore rules and indexes (written, emulator-tested) | `firestore.rules`, `firestore.indexes.json`, `tests/firestore-rules` | Client writes denied; reads need verified email + role admin/viewer. **Not deployed** |
| Deployment tooling | `deploy/deploy-v2.sh`, `deploy/rollback-v2.sh`, `worker/src/tools/preflight.ts` | Dry run by default, typed confirmations, backup + manifest, safe stop; sandbox-tested only |
| CI | `.github/workflows/ci.yml` | Lint, worker + web tests, type-check, builds, rules emulator job |
| Tests | worker 762, web 66, rules 10 | Incl. 16 end-to-end scenarios |

## 3. Broker verification status

Demo evidence (2026-10-23) confirms A1–A7, A10 and A12 on VantageMarkets-Demo
(comments preserved, hedging, expiry accepted (rounded to the minute), ticket
mapping, clock skew 0 s, volume specs, IOC filling, recovery after a terminal
restart, tick time). Still open: A8 (7-day history), A9 (a real ambiguous
timeout), A11 (10018 outside the session). Nothing is verified on a REAL account.

Procedure: `VANTAGE_EXECUTION_GUIDE.md` §16 (requires explicit owner
authorization and a confirmed DEMO account).

## 4. Partial

| Item | Gap |
|---|---|
| Web dashboard | Not deployed (needs a host); Firestore rules not deployed |
| Firestore rules / indexes | Emulator-tested, not deployed |
| Multiple AutoTraders | Safe against duplicate orders, but position/risk limits are per worker; run one |
| Correlation fallback | Detection and safe stop implemented; the fallback (EA request ledger or magic correlation) is designed only (`VANTAGE_BROKER_ASSUMPTIONS.md`) |
| External notifications | Implemented and tested with a fake `fetch`; no real channel configured |
| Docker images | Dockerfiles updated but no image was built |

## 5. Not implemented

| Item | Note |
|---|---|
| E-mail / web push notifications | `SMTP_*` / `VAPID_*` exist only in `.env.example` |
| Duplicate-signal window across messages | Only per-message idempotency |
| PWA manifest / service worker | Absent |
| Drawdown / latency analytics | Analytics shows counts, skip reasons, realized PnL, TP hits |

## 6. Housekeeping notes

- `.env.example` is matched by the `.env.*` ignore rule and is not tracked (it now
  documents the new knobs).
- `worker/worker/data/telegram.session.enc` is committed (historical).
- Six `web/src/app/**/page.old.tsx` files remain (not routed).
- `node_modules/bybit-api` stays until the v2 rollback window has passed; then `npm ci`.

## 7. Suggested reading order

1. `PROJECT_CONTEXT.md`
2. `VANTAGE_EXECUTION_GUIDE.md`
3. `VANTAGE_BROKER_ASSUMPTIONS.md`
4. `ARCHITECTURE.md`
5. `VANTAGE_DESIGN_CONTRACTS.md`
6. `PLANNING_BACKLOG.md`
