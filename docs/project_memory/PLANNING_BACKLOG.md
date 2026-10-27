# ByTrader — Planning Backlog

> **This is a reference, not a commitment.** Nothing here is approved, scheduled,
> or prioritised by the project owner. Items are separated into work that is
> **confirmed outstanding** (evidenced by source, TODOs, or existing
> requirements) and **suggested improvements** (my own observations).
>
> Verified against commit `435466f`. No deadlines are implied.

---

## 00. Status after the hardening pass (2026-10-21)

Closed in this pass (offline evidence in `VANTAGE_TEST_REPORT.md`):

| Item | Status | Closed by |
|---|---|---|
| A1 Legacy Bybit modules | **Closed** (owner decision in the hardening mission): modules and `bybit-api` removed; `node_modules` keeps the package until the v1 rollback window passes | `telegramListener.legacy.test.ts` |
| A7 `ALLOWED_EMAILS` | **Closed**: unset or empty refuses everyone; `email_verified` required; rules require role admin/viewer | `serverAuth.ts`, `firestore.rules`, `web/test/auth.test.ts`, `tests/firestore-rules` |
| A10 Settings validation | **Closed**: only telegram keys accepted; Bybit-era `trading.*` knobs refused and removed from the page | `/api/settings`, `web/test/control.test.ts` |
| A12 Web tests | **Closed**: 66 route/view tests + 10 emulator rules tests | `web/test`, `tests/firestore-rules` |
| Alerting | **Closed** (dashboard); external channel optional, off by default | `alerts.ts`, `alertMonitor.ts`, `serviceHealth.ts` |
| Signal-feed retry queue in memory | **Closed**: durable Firestore queue + forwarder outbox | `signalQueue.ts`, `signalFeed.ts`, `signalOutbox.ts` |
| Paper spec TTL | **Closed** | `simulatedBroker.ts` |

### Prioritized remaining work (updated 2026-10-23, after the deploy and demo run)

Done on 2026-10-23: indexes deployed, v2 + EA v2 deployed, demo checklist
passed, MT5 auto-start unit installed (`VANTAGE_TEST_REPORT.md` §6).

1. **Watch real signals on demo** next week (mode `demo` is on): forwarding,
   parsing and execution of real channel messages end to end.
2. **Deploy the web dashboard** (needs a host decision) with `ALLOWED_EMAILS`,
   then **deploy the Firestore rules** (`firebase deploy --only firestore:rules`).
3. Set `WORKER_API_TOKEN` (worker and web) once the dashboard calls the workers.
4. Optional external alerts (`ALERT_NOTIFICATIONS` + webhook or Telegram bot);
   today alerts are only in Firestore/dashboard and the logs.
5. Exercise the open assumptions: A11 (a close attempt outside the session),
   A8 (history depth after a week), A9 (only if a real timeout occurs).
6. Upgrade Wine to 10 (needs sudo): MT5 flags Wine 9.0 as unsupported, and a
   pending terminal update (build 6230) is held back.
7. After the rollback window (≥ 1 day of clean v2): `npm ci` to prune
   `bybit-api`; remove `worker/.dist-prev-*` when no longer needed.
8. Before any live trading: a REAL account review, profile sizing decision, and
   `BYTRADER_LIVE_TRADING=enabled` (owner decision only).

## 0. Status after the Vantage completion work (2026-10-18)

Sections A–D below are the original backlog, kept for history. Their status:

| Item | Status | Closed by |
|---|---|---|
| A1 Dual execution path | **Mostly closed.** Bybit no longer invoked from the Telegram path. Deleting the legacy files is still an **owner decision** | `telegramListener.ts`, `telegramListener.legacy.test.ts` |
| A2 Kill switch / paper / close-all | Closed | `executionControl.ts`, `simulatedBroker.ts`, `adminCommands.ts` |
| A3 TP ladder | Closed (real partial closes) | `lifecycleManager.ts`, `lifecycleRules.ts` |
| A4 Lifecycle price | Closed (`priceCurrent`) | `lifecycleManager.ts` |
| A5 `trade_events` never written | Closed | `tradeEvents.ts` |
| A6 Unauthenticated proxies | Closed | `serverAuth.ts`, `httpAuth.ts` |
| A7 `ALLOWED_EMAILS` | Partial: admin routes always need the admin role; rules need an allow-listed `users` doc; unset still admits any verified account as viewer | `serverAuth.ts`, `firestore.rules` |
| A8 Session cookie | Closed (`secure` in production) | `api/session/route.ts` |
| A9 Two `trade_sets` shapes | Closed for new data (schema 2); legacy docs stay readable | `tradeSetTypes.ts`, trades page |
| A10 Settings validation | Partial (server whitelist + types) | `/api/settings` |
| A11 Telegram label field | Closed | `telegram/page.tsx` |
| A12 Web tests | **Open** | — |
| A13 CI on master | Closed | `ci.yml` |
| A14 Compose AutoTrader | Closed | `docker-compose.yml` |
| A15 ZMQ latency validation | Open (needs the VPS) | — |
| B6 Worker HTTP auth boundary | Closed | `httpAuth.ts` |
| B9 MQL5 bridge hardening | Closed in code; **broker-unverified** | `mql5/VantageBridgeEA.mq5` v2 |

### New prioritized remaining work

1. **Vantage demo verification** (owner authorization + DEMO account) —
   `VANTAGE_EXECUTION_GUIDE.md` §16. Blocks any claim of broker correctness.
2. **Coordinated deployment** of the new worker + EA v2 (§17), with mode
   `disabled` first.
3. **Deploy Firestore rules and indexes** (after or together with the new web).
4. **Set `ALLOWED_EMAILS`** in production.
5. **Alerting** for `ERROR`, `SUBMIT_UNKNOWN`, `partial_close_failed`,
   `orphan_position`, bridge unreachable (Telegram message from the forwarder,
   which owns the session, driven by a Firestore collection).
6. Persist the signal-feed retry queue (today in memory; lookback 10 min).
7. TTL for the paper broker's cached symbol specs.
8. Web tests for the API routes (auth gate, profile transitions).
9. Owner decision on deleting the legacy Bybit modules (A1).

---

## A. Confirmed outstanding work

Each item states its evidence, impact, and dependencies. Ordered within each
group by dependency, not by priority.

### A1. Resolve the dual execution path — **do this before anything else**

| | |
|---|---|
| **What** | `worker/src/lib/telegramListener.ts` invokes **both** `handleParsedSignal` (Bybit, `tradeEngine.ts`) and the MT5 path (`publishSignalEvent` → `signalFeed` → `mt5TradeEngine.ts`) for the same Telegram message. |
| **Evidence** | `telegramListener.ts` imports and calls both; `tradeEngine.ts` is fully implemented and unguarded. |
| **Impact** | The forwarder process places real Bybit orders. It needs Bybit credentials. Two incompatible `trade_sets` shapes land in one collection. Any "we migrated to MT5" statement is false while this remains. |
| **Options** | (a) Delete the legacy call + `tradeEngine.ts`/`bybitClient.ts`/`tradeSizing.ts`; (b) gate the legacy call behind an explicit Firestore flag, defaulting off; (c) keep both deliberately and document when each fires. |
| **Blocked by** | A decision only the owner can make (`F` in the handoff). |
| **Acceptance** | A single message from the source chat produces exactly one broker action, and the forwarder needs no Bybit credentials if Bybit is retired. |

### A2. Kill switch, paper mode, and close-all have no consumer

| | |
|---|---|
| **What** | The dashboard writes `settings/default.trading.kill_switch`, `…paper_mode`, and `admin_actions.close_all_requested_at`. No worker code reads any of them. |
| **Evidence** | Repository-wide search: those strings appear only under `web/`. `tradingSettings.ts` reads `mt5_optional` but not `kill_switch`/`paper_mode`. |
| **Impact** | The operator's emergency control does nothing. `README.md` claims it works. This is the most safety-relevant gap in the project. |
| **Work** | Add the fields to `TradingSettings`, check them in `mt5TradeEngine.handleGoldSignal` (and the legacy engine if kept), and implement a close-all consumer — either in `signalFeed`/`lifecycleManager` or as a small poller in `autotrader.ts`. |
| **Depends on** | A1 (which engine to gate). |
| **Acceptance** | Toggling the kill switch in the UI prevents a new trade from being placed and is visible in `system_logs`. |

### A3. MT5 take-profit ladder is incomplete

| | |
|---|---|
| **What** | `mt5TradeEngine.ts` computes and stores `tp1_volume`/`tp2_volume`/`tp3_volume` but submits one order with `tp: takeProfits[2]`. No partial scale-outs occur. |
| **Evidence** | `mt5TradeEngine.ts` step 8; contrast with `tradeEngine.ts` lines 434–456 which place three reduce-only limits. |
| **Impact** | Realised PnL diverges from the provider's stated plan; the 60/25/15 model in the spec is not honoured on the live path. |
| **Work** | Either place three separate positions/orders, or have the EA manage partial closes as TP levels are reached, or use `ORDER_MODIFY` to attach a TP per partial volume. Requires an EA action that does not exist yet. |
| **Depends on** | A decision on the execution model (`F`). |

### A4. Lifecycle stop management uses the wrong price

| | |
|---|---|
| **What** | `applyBreakEven` / `applyTrailingStop` derive the "current price" watermark from `pos.open_price` (the position's *entry* price), not the live market price. The unused `profitDist` local in `applyBreakEven` shows this was noticed. |
| **Evidence** | `lifecycleManager.ts` — `updateWatermarks()` compares `pos.open_price` against the stored watermark; `applyBreakEven` computes `moved` from the watermark. |
| **Impact** | Break-even and trailing stops may never trigger, or trigger incorrectly. |
| **Work** | The EA needs to return a current-price field (e.g. `bid`/`ask` or `current_price`) in `GET_POSITIONS`; `Mt5Position` and `updateWatermarks` then use it. |
| **Depends on** | An MQL5 change + EA recompile on the VPS — the only item here that touches the EA. |

### A5. `trade_events` is never written

| | |
|---|---|
| **What** | The dashboard's trade timeline reads `trade_events`; nothing writes it. |
| **Evidence** | Worker-wide search returns no writer. `engineering-spec.MD` §12 and §10 require it; `implementation-plan.MD` Phase 6 is unchecked. |
| **Impact** | Trade drill-down is empty; analytics have no event-level data. |
| **Work** | Add a helper (e.g. `worker/src/lib/tradeEvents.ts`) and call it on each state transition in `mt5TradeEngine.ts` and `lifecycleManager.ts`. |
| **Depends on** | Nothing — can be done independently. |

### A6. Unauthenticated worker proxy routes

| | |
|---|---|
| **What** | `/api/telegram/{status,start,verify-otp,verify-password,logout}` and `/api/worker/health` enforce no authentication, and `/api/*` is excluded from `middleware.ts`. |
| **Evidence** | Route handlers contain no auth code; `web/middleware.ts` returns early for `pathname.startsWith('/api')`. |
| **Impact** | Anyone reaching the dashboard origin can read Telegram status, initiate a login, submit an OTP or 2FA password, and disconnect the session. The 2FA field is also unmasked (`telegram/page.tsx` uses `FormField type="text"`). |
| **Work** | Verify the session cookie inside these handlers (or move them under an authenticated API group), and change the 2FA field type. |
| **Depends on** | Nothing. |

### A7. `ALLOWED_EMAILS` unset ⇒ allow-all, and it is absent from `.env.example`

| | |
|---|---|
| **What** | `getAllowedEmails()` returns `null` when unset, and the caller treats `null` as "allow all". |
| **Evidence** | `web/src/app/api/session/route.ts` (comment: "null means allow all"). `.env.example` does not list the variable. |
| **Impact** | A dashboard with no allow-list accepts any Google account that can complete Firebase sign-in for the project. Discovery is made likely by its absence from the template. |
| **Work** | Document it in `.env.example`; decide whether unset should mean "deny all" instead (a behaviour change — owner decision). |

### A8. Session cookie hygiene

| | |
|---|---|
| **What** | The cookie holds the raw Firebase ID token, is not `secure`, is valid for 1 h, and is validated by **presence only** in `middleware.ts`. Any pathname containing a dot bypasses the gate entirely. |
| **Evidence** | `api/session/route.ts` (cookie options), `middleware.ts` (`PUBLIC_FILE = /\.(.*)$/`). |
| **Impact** | Cookie presence is not authentication. Middleware is a UX gate, not a security control — which is fine only if every real gate lives elsewhere (it does not, today). |
| **Work** | Add `secure` in production; consider verifying the token in middleware or in each handler; narrow the dotted-path exemption. |

### A9. Two incompatible `trade_sets` shapes

| | |
|---|---|
| **What** | MT5 writes `sl`/`take_profits`/`mt5{}`; Bybit writes `sl`/`tp1`/`tp2`/`tp3`/`bybit{}`. The dashboard reads the MT5-ish shape. |
| **Evidence** | Both writers read in full; `web/src/app/trades/page.tsx`. |
| **Impact** | Legacy rows render inconsistently (missing TPs, no ticket). |
| **Depends on** | A1 — resolving that makes this mostly moot. |

### A10. Settings page lost validation its predecessor had

| | |
|---|---|
| **What** | `settings/page.old.tsx` validates chat IDs with `/^-?\d+$/` and asks for confirmation before clearing them. The live page does not, and its `Reset` button repopulates empty lists. |
| **Evidence** | Read both files. |
| **Impact** | An accidental Reset+Save silently disables all chat filtering (`getTelegramChatFilters` treats an empty allow-list as "allow everything"). |
| **Work** | Port the validation and confirmation guard into `settings/page.tsx`. |
| **Note** | The same Reset button also resets risk-mode to a `PERCENT_BALANCE` value that the old page called `PERCENT_AVAILABLE_MARGIN` — check the enum before porting. |

### A11. Telegram settings field mismatch

| | |
|---|---|
| **What** | `telegram/page.tsx` reads `telegram.chat_labels`; everything else writes/reads `telegram.chat_id_labels`. |
| **Evidence** | `telegram/page.tsx` vs `settings/page.tsx`, `logs/page.tsx`, `page.tsx`. |
| **Impact** | Chat names never render in the Telegram onboarding view. |
| **Work** | One-line fix (plus decide which name is canonical). |

### A12. `web/` has no tests

| | |
|---|---|
| **What** | No test script, no test files, no test runner in `web/`. |
| **Evidence** | `web/package.json` scripts are `dev|build|start|lint`; no test files exist under `web/`. |
| **Impact** | Dashboard regressions (e.g. A10, A11) are caught only by eye. The `implementation-plan.MD` Phase 4 and Phase 8 items that claim tests exist are inaccurate. |

### A13. CI never runs on `master`

| | |
|---|---|
| **What** | `.github/workflows/ci.yml` triggers on `push.branches: ["main"]`; the default branch is `master`. |
| **Evidence** | The workflow file; `git symbolic-ref refs/remotes/origin/HEAD` → `origin/master`. |
| **Impact** | Direct pushes to `master` are unverified. |
| **Work** | Change the branch filter to `master` (or `["master","main"]`). One line. |

### A14. Docker Compose does not include the AutoTrader

| | |
|---|---|
| **What** | `docker-compose.yml` defines `web` and `worker` only. |
| **Evidence** | The compose file; `deploy/SERVICES.md` documents the two-service split. |
| **Impact** | `docker-compose up` gives a forwarder without execution — and, per A1, with a Bybit execution path instead. Misleading for anyone reading `README.md`. |
| **Depends on** | A1 (the compose services should mirror whichever engines remain). |

### A15. ZMQ / latency validation is manual

| | |
|---|---|
| **What** | `deploy/zmq-latency-test.sh` is a standalone benchmark with no npm script and no CI integration; `MT5_TIMEOUT_MS` defaults to 5000 ms as the *only* latency guard. |
| **Evidence** | The script; `mt5Client.ts`. |
| **Impact** | The "< 0.5 ms RTT" target quoted in `deploy/MT5_GUI.md` is never re-checked automatically. |

### A16. `implementation-plan.MD` checkboxes are stale

| | |
|---|---|
| **What** | The file marks Phase 5 (Bybit engine) unchecked while the progress log shows `[ ] Phase 5`, yet the code exists; Phase 8 is checked while several of its bullets are not actually met. |
| **Evidence** | Compare the plan with `tradeEngine.ts` / `web/src/app/*/page.tsx`. |
| **Impact** | Anyone (human or AI) treating that file as a status board will be misled. |
| **Work** | Reconcile it against `docs/project_memory/CURRENT_STATE.md`, or mark it historical. |

---

## B. Suggested improvements

> These are my observations. **None are approved or required by the spec.** They
> are ordered so earlier items unblock or de-risk later ones.

### B1. Delete confirmed dead code (low risk, mechanical)

`web/src/lib/mockData.ts`, `web/src/lib/animations.ts`,
`web/src/components/ui/index.ts`, `web/src/components/navigation/index.ts`,
`web/public/{logo-white,logofull}.png`, `web/public/tailwind.css` (compiled
artifact, tracked), `web/tsconfig.tsbuildinfo` (tracked build artifact),
`styled-jsx` from `web/package.json` dependencies.

**Before deleting the six `page.old.tsx` files**, harvest from them — they contain
`AUTH_ERROR_MESSAGES` (`login/page.old.tsx`), chat-ID validation and
clear-confirmation (`settings/page.old.tsx`), and `type="password"` on the 2FA
field (`telegram/page.old.tsx`). See A10/A6.

### B2. Consolidate the two dashboard shells

`DashboardLayout` (new) and `DashboardShell` (legacy) coexist; `/admin` and
`/analytics` use the old one. Neither has a sign-out control, so `signOutUser`
is unreachable from the live UI. Unifying the shell would also give mobile users
access to Analytics/Admin/Settings, which the current mobile bottom nav omits.

### B3. Move the inter-service contract out of implicit typing

`SignalEventDoc` in `signalFeed.ts` and the write shape in `signalEvents.ts` are
duplicated by hand. A shared `worker/src/lib/types/signalEvent.ts` (or a Zod
schema) would let the producer and consumer drift-proof each other. Same for the
`trade_sets` shape.

### B4. Add a Vitest config and cover the untested modules

There is no `vitest.config.*`; discovery relies on defaults. Adding one would make
the intent explicit and allow coverage thresholds. The highest-value untested
modules are `mt5Client.ts` (timeout/retry/`Mt5BridgeError` mapping — testable with
a fake ZeroMQ socket), `signalEvents.ts` (document-id construction),
`mt5Secrets.ts` / `tradingSettings.ts` (default fallbacks), and
`lifecycleManager.ts` (the pip math and tighten-only guards).

### B5. Make config failures loud

Every Firestore-backed loader swallows errors and falls back to defaults, and
`initFirestore()` returns `null` on missing credentials. A misconfigured
deployment therefore runs with `riskValue: 20`, `volume: 0.05`, and a hardcoded
target chat. Consider a startup preflight that logs (or refuses to start) when
required settings are absent — especially before it can trade.

Related: `calcLots` returns the fixed `mt5Config.volume` whenever it is `> 0`
(default `0.05`), which silently disables risk-based sizing. Decide whether the
risk model or the fixed volume is intended to win.

### B6. Give the worker's HTTP surface an auth boundary

Even with A6 fixed at the web layer, ports 4000/4001 are open on the host. A
shared secret header (checked by Express middleware) between the web proxy and the
worker would close the gap. Note `/mt5/config` currently returns symbol and magic
to any caller.

### B7. Prune `telegram_updates_debug`

The `Raw` handler writes one document per raw MTProto update with no retention
policy. On a busy account this grows without bound and costs Firestore reads.
Either make it opt-in via env/settings, or add a TTL policy.

### B8. Housekeeping for reproducibility

`.nvmrc` / `.node-version` (20), `.editorconfig`, `.dockerignore` per workspace,
`npm ci` in the Dockerfiles, `NEXT_PUBLIC_*` build args for the web image,
`LICENSE` (the README says "Private and proprietary"), and either wire the root
`.eslintrc.cjs` into a script or remove it (it is currently unreferenced and its
`eslint` dependency is undeclared).

### B9. MQL5 bridge hardening

From the EA review: enforce the magic number on `ORDER_MODIFY`/`CLOSE_POSITION`;
extend `ValidateStops` to `BUY_STOP`/`SELL_STOP`; stop hardcoding
`ORDER_FILLING_IOC`; check `ACCOUNT_TRADE_ALLOWED` /
`SYMBOL_TRADE_MODE`; use the declared-but-unused `InpPollIntervalMs`, or service
requests from `OnTimer` so the bridge answers when the market is closed. Consider
an idempotency id on `ORDER_SEND`.

### B10. Reconcile the ZMQ round trip with reality

`mt5HealthCheck` issues a real `GET_POSITIONS`, which costs a full REQ/REP
timeout when the market is closed. A cheap `PING` action in the EA (or treating
the EA as healthy when it is bound) would make `/health` meaningful outside
trading hours.

---

## C. Dependency graph

```
A1 (dual path decision) ──┬─> A9  (trade_sets shapes)
                          ├─> A2  (kill switch wiring)
                          └─> A14 (compose services)

A4 (lifecycle price) ─────────> requires MQL5 change + EA recompile

A6 ──> B6      (web auth boundary then worker auth boundary)
A10 ─> B2      (settings validation, then shell consolidation)

A5, A12, A13, B1, B3, B4, B7  ─ independent, no blockers
A3, B5, B9, B10              ─ need owner decisions (section F of the handoff)
```

---

## D. Explicitly **not** on this list

Deliberately excluded, because the spec or the owner's constraints exclude them
(`engineering-spec.MD` §29 "Explicit Non-Goals"):

- Signal interpretation, NLP, or "smart" parsing beyond the current grammars
- Automatic leverage optimisation
- Multi-provider signal switching
- Copy-trading other accounts
- Backtesting
- Multi-tenancy

Also excluded: rewrites. The two-service split, the Firestore queue, and the
document-id idempotency scheme are working designs; the recommended work above
extends them rather than replacing them.
