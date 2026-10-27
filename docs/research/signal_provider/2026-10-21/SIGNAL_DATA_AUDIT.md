# Signal Data Audit

Run: 2026-10-21 .. 2026-10-24 (research run started 2026-10-21 UTC). Read-only research; nothing was
sent to Telegram, Firestore or any broker, and no production service, `worker/dist`, `.env*` or Telegram
session file was touched. All times are UTC unless stated.

Labels: **Verified** (computed from accessible evidence), **Modeled** (verified inputs plus stated
assumptions), **Inferred** (plausible, not established), **Unknown** (insufficient evidence).

Private working data (message text, tick caches, per-trade tables) lives only in a local scratch
directory and is **not** committed. This document contains aggregates and message ids only.

## 1. Channel identity

| Claim | Label | Evidence |
|---|---|---|
| The user-supplied `-3271337051` and the repo's `-1003271337051` refer to the same channel (peer id 3271337051; Bot-API form is `-100` + id). | **Inferred** (strong) | Arithmetic and `telegramListener.ts` `getChatId()` (`-100${channelId}`). The bare form appears nowhere in the repo. A bare negative id is a basic-group form, and basic-group ids are 32-bit while 3271337051 > 2^31-1, so it cannot be a valid group id either. Most likely the `100` prefix was dropped. |
| All stored history records belong to `-1003271337051`. | **Verified** | 3,317 / 3,317 records. |
| It is a broadcast channel that only posts. | **Verified** (`is_post` = true on 3,317 / 3,317); title "VIP group" is **documented only** (`TELEGRAM_CHATS.md`, resolved 2026-09-22). | Stored records carry no title. |
| Live Firestore `settings/default` agrees. | **Unknown** | Firestore unreadable (see 3). If the settings contained the bare id, forwarding would drop every message (exact `includes` match in `signalForwarding.ts`). |

Only `-1003271337051` was analysed. The user's bare form was treated as a typo for it.

## 2. Local data sources

| Source | Result |
|---|---|
| `.data/vip_history.json` | **Only** Telegram export in the repo. 1,387,781 bytes, 3,317 records, 11 keys each (`chat_id`, `message_id`, `date`, `edit_date`, `text`, `reply_to_msg_id`, `is_post`, `grouped_id`, `is_signal`, `signal`, `fetched_at`). Producer script unknown. |
| Firestore export / emulator / logs | None found locally. |
| Price data | None in the repo; MT5 bridge protocol v2 has no historical-price action. |
| Test fixtures with signal text | Synthetic only (parser/pipeline tests). |

### 2.1 `vip_history.json` integrity (Verified, n = 3,317)

- 3,317 unique `(chat_id, message_id)`; duplicate pairs 0; one chat id.
- Span: 2025-10-30T11:12:06Z (message 1) to 2026-09-24T14:34:48Z (message 3678), about 329 days, 243
  active UTC days. Fetched in one batch 2026-09-24T15:06:23Z - 15:06:55Z, so the export is a snapshot
  taken 32 minutes after the last message.
- Message ids 1..3678 with **361 ids missing** (167 gap runs, longest 25 ids: 2163-2187). Whether they were
  deleted, service posts or not fetched is **Unknown**. The largest time gaps are weekend gaps (up to
  3.9 days, 468 to 469).
- Dates are monotone in message id; the file itself is not sorted (12 descents).
- 136 empty-text records (4.1%), none a signal.
- **Edits:** 3,263 messages (98.4%) carry `edit_date`; 411 of 415 signals (99.0%). Median edit delay
  7 s (all messages), 52 s (signals). 25 signals were edited more than 1 h after posting, 5 more than a
  day later (up to 8.1 days). The store keeps **only the final text** and one `edit_date`, so the original
  text of every edited signal is unrecoverable; whether any edit changed an entry, SL or TP is **Unknown**.
- Explicit provider correction statements exist in the chatter (e.g. "misclick", "wrong TP2") for 8
  messages (ids 36, 110, 182, 240, 516, 551, 561, 1513).
- No message contains cancel / delete / ignore / "invalid signal" wording (0 of 3,317), and
  `detectCancelIntent` fires on none: **the history contains no provider cancellations.**

### 2.2 Message classification (Verified counts; classification rules Modeled)

| Class | n | % |
|---|---:|---:|
| New signal (`is_signal`) | 415 | 12.5 |
| Header-only lead-in ("SELL/BUY GOLD NOW", no levels) | 120 | 3.6 |
| Signal-shaped but rejected by the parser | 18 | 0.5 |
| TP-hit outcome posts | 526 | 15.9 |
| Break-even exit posts | 165 | 5.0 |
| Loss / SL posts | 54 | 1.6 |
| Pip-status, exit, close, running posts | 40 | 1.2 |
| Break-even *instructions* ("SL to BE") | 268 | 8.1 |
| Level mentions, tallies | 41 | 1.2 |
| Empty | 136 | 4.1 |
| Commentary | 1,534 | 46.2 |

Provider outcome statements total 785 (23.7%). There is **no explicit "SL HIT" statement**; losses are
reported rarely (54 loss-type posts against 526 TP-hit posts) - the provider's own stream is
survivor-biased and was never used as ground truth.

## 3. Live Telegram / Firestore verification: **INCOMPLETE**

- Live Telegram was **not** queried. The production forwarder (`worker/dist/index.js`) owns the only
  session, and no second client, session load, or forwarder HTTP endpoint (several of which would open a
  second MTProto connection) was used.
- Firestore reads (read-only Admin SDK via the repo's `initFirestore()`) failed on all ~15 attempts over
  ~47 minutes with `RESOURCE_EXHAUSTED: Quota exceeded` and were never billed. Even after the owner reported
  quota remaining, the project kept rejecting reads. Settings, newest `telegram_messages`, `signal_events`,
  `trade_sets`, `trade_events`, `execution_profiles` and `system_logs` were therefore **not read**.
- **Latest observed message: 2026-09-24T14:34:48Z (message 3678), from the stored local export, not live.**
  Age at the time of checking (2026-10-21 03:31Z): ~26.5 days. Whether newer messages exist is **Unknown**.
- Consequences: the "recent vs historical" comparison covers only data up to 2026-09-24; no
  broker-confirmed, paper or simulated execution record could be classified. Per repo docs
  (`CURRENT_STATE.md`, `VANTAGE_TEST_REPORT.md`) no order has ever been sent through the v2 EA to Vantage, so
  **no broker-confirmed execution evidence exists**; every performance number in this research is
  reconstructed or simulated from independent prices.
- Operational flag raised to the owner: if the same Firebase project is out of read quota for production,
  the forwarder may be skipping sends and the AutoTrader not processing signals (Inferred from code, not
  observed in logs).
- Once Firestore reads work, the prepared read-only scripts need ~1.6k reads (cap 2.5k, zero writes).

## 4. Signal parsing and data errors

### 4.1 Parser parity (Verified)

The stored `is_signal` / `signal` fields are reproduced exactly (3,317 / 3,317) by the compiled repo
parser (`vipSignalParser.ts`) and by an independent Python port, including a seeded 200-signal sample.
The production `worker/dist` parser matches `src` on 3,317 / 3,317 records.

### 4.2 Accepted and rejected signals

- 415 accepted: all XAUUSD, **all `market` order type**, direction 248 SELL / 167 BUY, TPs per signal
  2:3, 3:72, 4:316, 5:18, 6:5, 7:1. SL and first TP on the correct side of entry in 415 / 415.
- 18 signal-shaped posts rejected (Verified): 10 "SHORT POSITION" wording (ids 24, 33, 53, 67, 78, 80,
  84, 112, 117, 222), 6 "OPEN RANGE / OPEN PRICE" (5, 43, 163, 362, 366, 390), 1 `SL ;` typo (841), 1
  out-of-order TP2 (2437). Their later outcome posts are among the unlinked claims. Recall of real signals is
  about 98%, lowest (88%) in Oct-Dec 2025. The latest format (Jun-Sep 2026) parses 165 of 166 signal-like
  messages.

### 4.3 Data errors to treat as quality flags (Verified text; intent Unknown)

| ids | issue |
|---|---|
| 14, 19, 196, 378 | Decimal commas truncated by the parser (e.g. `SL : 4013,20` stored as 4013); up to 0.5 USD per level |
| 512 | BUY with SL ~403 USD below entry (probable typo) |
| 2141 | TP4 = `400` for a SELL near 4458 (typo) |
| 649 | Duplicate TP4 label (4850 and 4806) |
| 442/445, 1459/1464 | Identical signals reposted ~30 min apart (two message ids each) |
| 9, 14, 19 | First-hour posts 42-282 USD away from the market at their timestamps (cause unknown) |

These 9 signals (14, 19, 196, 378, 445, 512, 649, 1464, 2141) are the "hard-flagged" set; every analysis
uses the 406-signal **clean** universe for optimisation and reports the full 415 as a sensitivity. Nothing
was dropped silently.

### 4.4 Provider format drift (Verified from history, n = 415)

Signals per month rose from 3 (Oct 2025) to 59 (Sep 2026); SL distance median widened from ~3.1 USD
(Nov 2025) to 5-6.75 USD (Feb-Jun 2026) and was 4.5-5 USD in Aug-Sep 2026; TPs per signal went from 3 (late
2025) to mostly 4 (2026). Sell share was 73% in Sep 2026. A "SELL/BUY GOLD NOW" lead-in post appeared
before 94 signals from May 2026. `ENTRY` / `ENTRY ZONE` labels appear from Jul 2026 and parse fine.
Whether the *outcomes* changed after the history cutoff is **Unknown** (no live data).

### 4.5 Signal timing (Verified, n = 415)

Monday-Friday only (Mon 71, Tue 89, Wed 69, Thu 108, Fri 78). All signals fall between 00:00 and 19:59 UTC,
peaking 14:00-15:59 (30%). Median gap between signals 7.0 h; 29 pairs within 30 min; 10 opposite-direction
pairs within 60 min.

## 5. Provider outcome-claim linking (Modeled; unverified)

1,083 claim posts were linked to signals with a heuristic (reply link or most recent open signal within
7 days): 95.2% linked, but **68% of TP-hit links are ambiguous** (more than one candidate open signal).
Per-signal attribution of claims is therefore unreliable and claims were used only for a late sanity
comparison (see `SIGNAL_PERFORMANCE_REPORT.md`).

## 6. Price data

| Item | Value |
|---|---|
| Source | Dukascopy historical XAUUSD ticks (public HTTP feed; plain HTTP, no TLS integrity, verified by plausibility). **Not Vantage.** |
| Coverage | 2025-10-30 00:00 to 2026-09-27 23:59 UTC: 7,992 hourly files, 5,359 with data (83,641,720 ticks), 2,633 known-empty (weekends, daily break, holidays), 0 unresolved after retries. |
| Checks | bid >= ask on 0 ticks; no zero spreads; timestamps monotone; OHLC consistent in 321,261 derived 1-minute bars; prices 3,915 - 5,600 USD |
| Timezone | Provider message times and Dukascopy are UTC-consistent (median entry-vs-market offset minimises sharply at lag 0 of a +/-3 h scan). A fine scan puts the minimum at about -3 min: provider levels track the market 1-3 minutes *before* the message time. |
| Unexpected empties | 10 hours, all US-holiday early closes (e.g. Thanksgiving, Memorial Day). 13 signals have a 72 h window crossing one (276, 292, 294, 428, 433, 442, 445, 787, 2056, 2061, 3331, 3333, 3344); none is a feed outage. |
| Outlier ticks | 749 one-tick mid jumps >= 5 USD (15 >= 20 USD, max 74.5 USD on 2026-01-29 15:28Z); 60% of the >= 5 USD jumps revert within 60 s (Inferred: transient prints) - a false-stop risk that the auditor tests. |
| Spread (Dukascopy, Verified) | median 0.68 USD, p95 1.25, p99 2.25; 7.2% of ticks <= 0.50, 91.5% <= 1.00. Median 0.63 USD at signal message times (n = 415). |
| Vantage costs | **Unknown.** Vantage's site returned 403; only secondary sources (spread-only on Standard STP; ~3 USD/lot/side on Raw ECN) - unverified. |

**Price offset vs the provider (Verified, n = 415):** entry mid minus Dukascopy mid at posting has median
+0.89 USD, median absolute 1.87 USD; for BUYs the posted entry sits a median **1.95 USD below** the market
(n = 167) and for SELLs **1.84 USD above** (n = 248). Both directions are on the *favourable* side, so a
single feed offset cannot explain it: the posted levels behave like limit levels (or are stale), which is
the dominant driver of the results in `STRATEGY_COMPARISON.md`.

## 7. Reconstruction quality

- 415 / 415 signals have a complete tick window; no outcome is `NO_PRICE_DATA` (Verified).
- 1-minute bars would resolve the first SL/TP touch in 385 / 385 entered trades under A3's range-touch
  model (0 same-minute SL+TP minutes); 6 trades have fill and first exit in the same minute (tick data was
  used throughout the final analysis).
- The reconstruction engine passed 35 unit tests and was verified against an independent pure-Python
  tick loop (entry on 415 signals: 0 mismatches; 30 random filled signals: 30 / 30 agreement; 0 look-ahead
  violations in 830 runs). A defect in its pending-order (P2) logic was later found and corrected by
  Agent B2 (see `RESEARCH_VALIDATION.md`); market-entry results were not affected.
- Vantage P&L is **not** reconstructable: no Vantage prices, spread, commission, swap, tick value or margin
  were available.

## 8. What is Unknown

Live/newer messages after 2026-09-24; Firestore config and execution records; original (pre-edit) signal
text; the 361 missing message ids; the producer of the export; Vantage account balance, leverage, symbol name,
contract size, tick value, lot limits, spread and commission; whether an MT5 terminal/bridge now running on the
host (observed by Agent A3 listening on 127.0.0.1:5555 on 2026-10-23, not started by this research) puts the
production AutoTrader in contact with a broker.
