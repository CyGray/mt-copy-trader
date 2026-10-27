# LUCAS GOLD LEGEND (channel -1002371904451): data audit, pilot, sizing, limits

**Verdict: Unknown, insufficient data (2 signals from one day).** This verdict was fixed in advance by the
pre-registration (`PREREGISTRATION_LUCAS.md`, sha256 `54ee1ee7310b20d9699f4f209eb75e082b139fd4457a5413c2e32210eec328e1`).
Do not trade it. Labels: **Verified** (observed), **Modeled** (simulated on Dukascopy ticks), **Inferred**, **Unknown**.

## 1. Data audit

| Item | Value | Label |
|---|---|---|
| Source | Go forwarder SQLite store, `telegram_messages`, read-only (`mode=ro`) | Verified |
| Window | 2026-10-26 01:44Z to 17:56Z (one trading day) | Verified |
| Messages / revisions | 50 messages (ids 23203-23252, no gaps), 83 revisions | Verified |
| Earlier history | Firestore: 3 docs (edit events, 2026-10-02/09); Node forwarder journal: the same 3 events; no export on disk | Verified |
| Public mirror | `t.me/s/lucas_gold_legend` is a different public channel (ids ~974, bulk-posted media, text similarity to these messages at most 0.36); not used | Verified |
| Channel role | The provider's **free** channel ("all shared right here in the FREE channel"), funnelling to a paid "LUCAS MASTERMIND" | Verified (own words) |
| Instrument | XAUUSD (levels about 3,990-4,030; the channel calls 0.10 USD a "pip") | Verified |

Message classes (hand-labelled, every message):

| Class | Messages |
|---|---|
| signal (1 message carrying 2 signals: "SIGNAL 3" BUY, "SIGNAL 4" SELL) | 1 |
| management (entry hit, close bad entries, move stop, TP reached) | 15 |
| result claim (pips / "TP hit" / "completed" / member feedback) | 6 |
| analysis (text) / analysis with levels but no stop | 1 / 1 |
| marketing / engagement ("tap tap", greetings) | 2 / 8 |
| media only (photo or video without text) | 16 |

Signal format: `SIGNAL n (date)` / `BUY ZONE: 3992 - 3990` / `STOPLOSS: 3984 (60pips - 80pips)` /
`TAKE PROFIT: 3998 - 4006 - 4014 - open`. The repo parser (`vipSignalParser.ts`) and the **live Go parser**
reject it (`missing_entry`). The research parser `analysis/a1/parser_multi.py` reads it.

Parser check (Verified): signal-message precision 1.0 and recall 1.0. Both signals' levels are exact in every
revision. No management, claim or zone-map message was parsed as a signal. Message-class accuracy is 0.92
(4 misses, all among non-signal classes). With one signal message, precision and recall cannot be estimated
meaningfully. On the earlier provider's 3,317 messages the new parser matches the repo parser exactly
(415/415 signals identical, 0 extra accepts).

Edits (Verified): 11 of 50 messages were edited (median lag 152 s, maximum 1,615 s); 1 was first seen as an edit.
The signal message was edited once: SIGNAL 4's stop changed 4028 → 4018 at 14:20:03Z, 27 minutes after posting.
The stop's own annotation "(50pips - 70pips)" matches 4018 (5-7 USD from the zone), not 4028 (15-17 USD).
So this was most likely a typo fix (Inferred), but it came 48 s **after** price first reached the sell zone.
The parser flags this case (`sl_annotation_mismatch`).
Observation delay (message time to stored): median 5 s, p90 20 s.

## 2. Pilot performance (Modeled, descriptive only, n = 2)

Pre-registered fixed set, no selection. Dukascopy XAUUSD ticks (26 of 27 hours present; the empty hour is the
normal 21:00Z daily break). Horizon truncated at 2026-10-27 02:00Z (about 12 h, not 72 h). Both signals closed
before that.

| Entry model | Fills | Why |
|---|---|---|
| E1 market within 2.0 USD of the zone | 0 / 2 | price 3.6 USD and more away at posting (`price_outside_range`) |
| E2 project `pending_at_range` | 2 / 2 | limit at the zone edge, filled after 1 and 26 minutes |
| E3 strict market inside the zone | 0 / 2 | as E1 |

E2, R per trade (MID costs; BASE and PESS differ by at most 0.02 R):

| Strategy | SIGNAL 3 BUY | SIGNAL 4 SELL | Mean (n = 2) |
|---|---|---|---|
| S_TP1\|M0 (all at TP1) | +0.74 | -1.01 (stop) | -0.14 |
| S_TP2\|M0 | +1.73 | -1.01 | +0.36 |
| S_TP3\|M0 | +2.73 | -1.01 | +0.86 |
| Q_25x4\|M0 / M3 (TP4 missing → merged) | +1.98 | -1.01 | +0.49 |
| S_TP4\|M0, S_TP4\|M5 | skipped (no numeric TP4; the 4th target is "open") | | n = 0 |
| D13_50_50\|M1, the provider's own plan (post hoc, see the draft profile) | +1.73 | -1.01 | +0.36 |

A 95% bootstrap CI over two values just spans the two values (for example [-1.01, +2.73]). **These rows prove
the pipeline runs end to end, nothing about profitability.** Using the first-seen stop 4028 changes SIGNAL 4 to
-1.01 R as well: the stop is hit later (minute 200 instead of 45), but each R is measured against its own stop.

## 3. What the provider claimed versus the ticks (Verified on Dukascopy, which is not Vantage)

| Claim (time) | Ticks | Assessment |
|---|---|---|
| "HIT ENTRY BUY" (13:54:14Z) | ask first ≤ 3992 at about 13:54 (+0.8 min) | consistent |
| SIGNAL 3 "REACHED TP1/TP2", "FULL TP", "+360 pips 3990 → 4026" | TP1 3998 at 14:04:39, TP2 4006 at 14:13:26, TP3 4014 at 14:19:45; minimum ask 3989.08 (13:58:46), maximum bid 4026.75 (14:58:26) | touched; "+360 pips" uses the zone's best price and the day's top tick (best case) |
| "HIT ENTRY SELL" (14:21:07Z) | bid first ≥ 4011 at 14:19:15 | consistent |
| SIGNAL 4 "+60 pips", then "returned to breakeven" | best ask 4007.43 at 14:27:21 (about +56 pips from 4013); ask ≥ 4018, the posted stop, at 14:38:10 | the signal as posted lost 1 R; the channel reported it as break-even and advertised "+60 pips" |

Post-hoc observation, not a test: the channel's marketing reports floating best cases and leaves out losses.

## 4. Sizing (Modeled with the `positionSizing.ts` port; specs Verified on the Vantage demo bridge, 2026-10-27)

Bridge, read-only: XAUUSD contract 100, tick 0.01 = 1 USD per lot, volume min/step 0.01, IOC, market execution;
spread 0.29 USD at 02:25Z (Asian session; London and New York spreads still Unknown). 0 positions, 0 orders.

Policy: 0.25% equity risk per trade, `below_min_volume: skip` (never `use_min_if_within_cap`), default safety
(risk cap min(50 USD, 1%)).

| Stop distance | Risk per 1.0 lot | 1,000 USD | 5,000 USD | 50,000 USD | Equity for 0.01 lot |
|---|---|---|---|---|---|
| 8.05 USD (SIGNAL 3, E2 fill) | 805 USD | skip | 0.01 lot (8 USD) | 0.06 lot (48 USD, capped by 50 USD) | 3,220 USD |
| 7.05 USD (SIGNAL 4, final stop) | 705 USD | skip | 0.01 | 0.07 | 2,820 USD |
| 17.05 USD (SIGNAL 4, first-seen stop) | 1,705 USD | skip | skip | 0.02 | 6,820 USD |

A 50/50 split (the draft profile) needs 0.02 lots: from about 7,000 USD for an 8 USD stop (validator:
`tp_split_infeasible` at 5,000). With 1,000 USD every Lucas signal seen so far is skipped. Margin at 1:100
for 0.01 lot ≈ 40 USD (Modeled; Vantage margin factor Unknown).

## 5. Draft profile

`profiles/lucas_gold_legend.draft.json` is an **operations-test template, not a strategy recommendation**. It
encodes the channel's own published plan (50% at TP1 and stop to entry, 50% at TP3). It passes
`validateProfile` (TypeScript) and `ValidateProfile` (a copy of the live Go domain package). Under default safety
both refuse it only for `max_spread_price` 1.0 > 0.5. Activation blockers: live parser support, a positive
pre-registered out-of-sample result, a safety decision, and owner authorization. It carries an `audit_warning`.

## 6. Limits

- n = 2, one day, one market regime. Nothing can be inferred about edge.
- Final text versus first-seen: only one stop edit existed, and it was a typo correction.
- Management messages (close bad entries, move stop to entry or 4000/4005) were not simulated. The engine trades
  the posted levels only, as in the earlier study.
- Dukascopy is not Vantage. Commission, swap and margin are Unknown.
- Signals "1" and "2" of 2026-10-26 do not appear in the free channel (they may be in the paid group): Unknown.
