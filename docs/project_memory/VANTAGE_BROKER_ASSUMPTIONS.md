# Vantage broker assumptions

What the AutoTrader assumes about Vantage MT5. For each assumption the table
says which code relies on it, what is covered by simulated tests, what happens if
Vantage behaves differently, and how to verify it on the demo account.

Apart from the demo evidence table below, **nothing in this document is verified on Vantage.** Every check marked
"simulated" runs against `simulatedBroker.ts` or a fake transport. It shows the
code's reaction to each possible broker answer, not which answer Vantage gives.
The demo checklist (`VANTAGE_EXECUTION_GUIDE.md` §16) collects the real evidence.

Audit date: 2026-10-21. Sources: `worker/src/lib/mt5Client.ts`, `mt5Broker.ts`,
`mt5TradeEngine.ts`, `reconciler.ts`, `lifecycleManager.ts`,
`mql5/VantageBridgeEA.mq5` v2.0.0 and `mql5/PROTOCOL.md`.

## Demo evidence (2026-10-23, VantageMarkets-Demo, hedging)

Collected during the owner-authorized demo run (`VANTAGE_TEST_REPORT.md` §6).

| # | Evidence | Verdict |
|---|---|---|
| A1 | Position, pending order and IN deal kept the comment exactly (`BT-3c0e440409a2`, `BT-78e76615905d`). Closing deals carry broker comments (`""`, `[sl 4003.01]`); the code matches only IN deals and open positions/orders | **Holds** on this server |
| A2 | `ACCOUNT_INFO.margin_mode = HEDGING`; journal "demo account - hedging mode" | **Holds** for this account |
| A3 | `expiration_applied: true` for a BUY LIMIT; `time_expiration` was **rounded down to the minute** (requested 16:32:53 UTC, set 16:32:00) — earlier, so safe | **Holds** (with minute rounding) |
| A4 | ORDER_SEND `position` = order ticket = GET_POSITIONS `ticket` = deal `position_id`; partial close kept the ticket | **Holds** |
| A5 | `TimeGMT()` skew 0 s; server offset +10 800 s (UTC+3); broker ping ≈ 209 ms | **Holds** |
| A6 | XAUUSD: min 0.01, step 0.01, max 100, volume limit 0, stops level 20, freeze 0; a 0.01 partial close of 0.02 succeeded | **Holds** |
| A7 | `filling_fok false`, `filling_ioc true`; market entry and closes filled (IOC) | **Holds** (IOC) |
| A10 | Terminal killed and restarted: the AutoTrader raised the bridge alerts, read broker state again after recovery, nothing was resent. The terminal itself does **not** keep the password: `deploy/mt5-start.sh` re-logs in | **Holds** (with the launcher) |
| A12 | `tick_time_msc` converted with the PING offset gave a fresh tick (age 0 s) during the session | **Holds** |
| A8, A9, A11 | Not exercised (7-day history, a real ambiguous timeout, 10018 outside the session) | Open |

## Summary

| # | Assumption | If wrong | Current safeguard | Simulated tests | Needs Vantage evidence |
|---|---|---|---|---|---|
| A1 | Order comments are stored unchanged (`BT-<12 hex>`, 15 characters) | Duplicate guard and SUBMIT_UNKNOWN resolution stop matching | Post-fill comment check → critical `correlation_mismatch`; reconciler never concludes "not executed" while an unlinked look-alike exists; operator resolution route | `brokerAssumptions.test.ts` A1 | **Yes**: comment on position, order, IN deal |
| A2 | Account is hedging | A second entry on the symbol merges into one position | Entries refused unless `margin_mode` is `HEDGING` (`account_netting`) | A2 | **Yes**: `ACCOUNT_INFO.margin_mode` |
| A3 | `ORDER_TIME_SPECIFIED` is accepted for XAUUSD pending orders | Order becomes good-till-cancelled | `expiration_applied` recorded; worker cancels a pending entry still working 30 s after its expiry | A3 | **Yes**: `expiration_applied` on a demo pending order |
| A4 | Position, order and deal ids map as in hedging MT5 (`DEAL_POSITION_ID` = position ticket) | Lifecycle cannot find the position by ticket | Reconciler and lifecycle also match by comment; unexplained cases raise alerts and are never touched | `mt5Broker.test.ts`, `reconciler.test.ts` | **Yes**: compare ORDER_SEND `position` with GET_POSITIONS |
| A5 | EA `TimeGMT()` is within a few seconds of the VPS clock | Request expiry window is wrong; late fills after a "not found" verdict | `clock_skew` gate (>5 s refuses entries), alert, reconciler waits for an EA clock that runs behind | A5, `mt5Client.test.ts` | **Yes**: `PING.gmt_time` vs worker clock |
| A6 | Volume min/step/max and `SYMBOL_VOLUME_LIMIT` are as reported by `SYMBOL_INFO` | Partial closes or entries rejected (5004 / broker) | Planner and EA pre-checks; `symbol_volume_limit` gate; rejected partial closes retried 5 times, then `partial_close_failed` alert | A6, `positionSizing.test.ts`, `lifecycleManager.test.ts` | Yes: read the spec; one partial close |
| A7 | The symbol supports FOK or IOC for market orders | Market orders rejected | EA falls back FOK → IOC → RETURN; rejection is a definite `REJECTED` | `simulatedBroker.test.ts` (validation only) | **Yes**: `filling_fok`, `filling_ioc` |
| A8 | Deal history covers at least 7 days and today's deals | Duplicate guard misses old deals; daily-loss gate under-counts | Daily loss reads from 00:00 UTC (converted to server time); engine idempotency does not depend on history | `mt5Broker.test.ts` (window conversion) | Yes: GET_DEALS over 7 days |
| A9 | A mutation that times out may or may not have executed | (This is the assumption that keeps it safe) | Never retried; `SUBMIT_UNKNOWN` / checkpoint `closing`; resolved from broker state after expiry | `mt5Client.test.ts`, `pipeline.e2e.test.ts` 8 and 13 | No (design) |
| A10 | After an EA restart, broker state is the truth; the EA keeps no state except its replay cache | A request resent after a restart would execute again | Node never resends; the comment duplicate guard covers new requests for the same signal | `mt5Client.test.ts` (no mutation retry) | Yes: restart the EA during the demo |
| A11 | `10018` means the market is closed | Lifecycle burns retries during session breaks | 10018 on a partial close does not count as an attempt; retried once a minute; stops tolerate it too | `lifecycleManager.test.ts` | Yes: a close attempt outside the session |
| A12 | `SYMBOL_TIME_MSC` is server time; with the PING offset it converts to GMT | Stale-quote gate misjudges quote age | Tick time 0 (unknown) when the offset is unknown; `quote_stale` only judges a known tick time | `mt5Broker.test.ts`, `mt5TradeEngine.test.ts` | Yes: compare tick time with the terminal |

## Details

### A1 Correlation comment

- Sent: `BT-` + first 12 hex digits of `sha256(trade_set_id)` (`tradeSetTypes.ts`).
  Deterministic, 15 characters, inside MT5's 31-character limit; `mt5Broker`
  refuses anything longer.
- Relied on by: the EA duplicate guard (identical comment + EA magic over open
  positions, pending orders and 7 days of deals), `reconciler.resolveUnknown`,
  `lifecycleManager.managePending` (fill detection), orphan detection.
- Known broker behaviours to look for: truncation, a broker prefix or suffix,
  replacement on partial fills or closes (closing deals commonly read
  `[tp ...]`/`[sl ...]`; only IN deals and open positions/orders are matched),
  and comments dropped on stop-out.
- Detection now in code:
  1. After each fill the engine compares the position comment with what it sent.
     A difference records `comment_not_preserved` and raises a critical
     `correlation_mismatch` alert.
  2. The reconciler checks the comment of every linked open position.
  3. Before concluding `not_found_after_expiry`, the reconciler looks for an
     unlinked EA-magic position, order or IN deal on the same symbol and side
     inside `[submitted − 10 s, expiry + 60 s]`. If any exists it records
     `correlation_candidates`, raises a critical alert listing the tickets, and
     leaves the trade `SUBMIT_UNKNOWN`. It never links automatically.
  4. An admin can resolve a stuck `SUBMIT_UNKNOWN` from the Trades page
     (`POST /api/trades/[id]/resolve`, typed confirmation, only 120 s after
     expiry). It changes the record only, never broker state.

#### Fallback correlation strategy (prepared, not implemented)

Use only if the demo shows that Vantage does not preserve comments. Keep
execution `disabled` until one of these is implemented and re-verified.

1. **Persistent request ledger in the EA (preferred).** After every
   `ORDER_SEND` the EA appends `request_id → {order, deal, position, time}` to a
   file under `MQL5/Files` and flushes it. A new read-only action
   `QUERY_REQUEST {request_id}` returns the entry. Node already stores
   `submission.request_id` on ambiguous sends (`BrokerAmbiguousError.requestId`);
   the reconciler would query by request id first and by comment second. This
   survives EA restarts, unlike the in-memory replay cache, and does not depend
   on any broker field. Cost: EA change + recompile, file rotation, tests.
2. **Magic-number correlation.** Allocate each trade set a magic inside an
   owned range (`base + (hash mod 2^20)`), change EA ownership checks (5006) and
   the duplicate guard to "magic in range" and "identical magic". Magic numbers
   are preserved by MT5 itself, not the broker. Cost: bigger EA change, a
   collision rule, migration of open trades.
3. **Heuristic match with operator confirmation.** Already used as a safety
   stop (detection 3 above). Never acceptable as automatic linking.

Do not compensate by retrying sends: without correlation a retry cannot tell
whether the first order executed.

### A2 Netting versus hedging

`brokerRouter.verifyAccountForMode` refuses `margin_mode` other than `HEDGING`
for demo and live (`account_netting`). Paper mode always simulates hedging.
On a netting account the engine's one-position-per-trade-set model, partial
closes by ticket and ownership checks would not hold.

### A3 Pending-order expiration

The engine sends `expiration = now + pending_expiry_minutes` (GMT), converted to
server time by `mt5Broker`. The EA uses `ORDER_TIME_SPECIFIED` only when
`SYMBOL_EXPIRATION_MODE` allows it and reports `expiration_applied`. The trade
set stores `submission.pending_expires_at` and `broker_refs.expiration_applied`;
`expiration_applied: false` records `pending_expiry_not_applied`. In all cases
the lifecycle manager cancels a pending entry still working 30 s after
`pending_expires_at` (`pending_order_expired_by_worker`). A cancel that fails is
retried; one that races a fill is refused by the broker and the fill is picked up.

### A4 Identifier mapping

ORDER_SEND returns `order`, `deal` and `position` (`DEAL_POSITION_ID` of the
deal). In hedging accounts the position ticket equals the opening order ticket;
the code does not rely on that equality, only on `position` and on
`GET_POSITIONS.ticket`. Partial closes keep the position ticket. Verify on demo
that `position` from ORDER_SEND equals the `ticket` in GET_POSITIONS.

### A5 Clocks

Three clocks: the VPS (Node), the terminal's `TimeGMT()` (an MT5 estimate from
the broker offset, not NTP), and broker server time. `expires_at` is judged on
`TimeGMT()`. `mt5Client` measures `gmt_time − now` on each PING; the engine
refuses entries when it exceeds `MAX_CLOCK_SKEW_SEC` (default 5), the monitor
raises `clock_skew`, and the reconciler adds any "EA behind" skew to its wait
before concluding. Server-time conversions (positions, orders, deals,
expiration) use `server_time − gmt_time` from PING.

### A6 Volumes

`planCheckpoints` splits volume on `volume_step` and keeps every remainder at or
above `volume_min`; the EA re-checks (5004). `SYMBOL_VOLUME_LIMIT` (when > 0) is
checked against the bot's own open and pending volume on the symbol
(`symbol_volume_limit`); positions of other EAs or manual trades are invisible to
the bot, so the broker may still refuse.

### A7 Filling

Market orders: FOK if allowed, else IOC, else RETURN. Closes use the same rule.
Pending orders: RETURN. A partial fill (10010 or a smaller volume) re-plans the
checkpoints for the filled size. `CLOSE_POSITION` uses the EA input
`InpDeviation`, not a per-request deviation.

### A8 History

The duplicate guard reads 7 days of deals (`DUP_LOOKBACK_SEC`). Daily realized
loss sums OUT/OUT_BY/INOUT deals since 00:00 UTC. Reconciler and lifecycle read
deals from 60 s before a trade set's creation. Verify that GET_DEALS returns
deals older than a day and that the terminal's history is not truncated.

### A9–A10 Ambiguity and EA restarts

`mt5Client` never retries a mutation. A timeout after hand-off is ambiguous and
becomes `SUBMIT_UNKNOWN` (entries) or a `closing` checkpoint with an ambiguity
window (closes). The EA refuses requests past `expires_at` (5009), so the window
is bounded. The replay cache (256 entries) is in memory and is lost on EA
restart; Node does not rely on it because it never resends. After an EA restart
the reconciler and lifecycle read broker state as usual.

### A11–A12 Market sessions and quotes

`10018` (market closed) on a partial close is not counted as an attempt and is
retried once a minute. The engine refuses entries when the symbol's last tick is
older than `MAX_QUOTE_AGE_SEC` (default 60; `quote_stale`). Paper mode refuses
trading on a stale quote, does not fill pending orders or trigger SL/TP on it,
and re-reads symbol specs from the bridge at least every `PAPER_SPEC_TTL_MS`
(15 min), failing closed when the refresh fails.

## Demo evidence to collect

Record each item in `VANTAGE_EXECUTION_GUIDE.md` §16's evidence table:

1. Comment on the position, the pending order and the IN deal equals `BT-…`.
2. `ACCOUNT_INFO.trade_mode = DEMO`, `margin_mode = HEDGING`.
3. `SYMBOL_INFO` for XAUUSD: `filling_fok`, `filling_ioc`, `volume_min`,
   `volume_step`, `volume_limit`, `stops_level`, `freeze_level`, `trade_mode`.
4. A pending order with expiry: `expiration_applied` value, and the order's
   `time_expiration` in GET_ORDERS.
5. `/health` → `bridge.gmtSkewSec` and `serverOffsetSec` over an hour.
6. ORDER_SEND `position` equals GET_POSITIONS `ticket`; after a partial close the
   ticket is unchanged.
7. GET_DEALS over 7 days returns the expected deals.
8. EA restart while idle: the AutoTrader recovers with no alerts beyond the
   expected bridge outage.
9. A close attempt while the market is closed returns 10018.
