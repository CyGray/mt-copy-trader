# Addendum 2026-10-24: second out-of-sample test and live-system cross-check

Status: research, nothing approved or activated. No broker order was sent, no Firestore write was made, no
profile was activated, no `.env*` file was modified. Supersedes the parts of `OPTIMAL_REPORT.md` it names below.

## 1. What was added since the main report

| Item | Result | Label |
|---|---|---|
| Vantage demo XAUUSD specification (read-only bridge queries) | contract 100 oz, tick value 1 USD, volume min/step 0.01, max 100, stops level 20 points (0.20 USD), IOC filling only, market execution, hedging account, 1:100, demo balance 49,999.51 USD, no open positions or orders | Verified (demo server `VantageMarkets-Demo`) |
| Spread at the Friday close (stale quote) | 35 points = 0.35 USD | Verified, but market closed: not representative |
| New provider messages after the export (2026-09-24 .. 2026-10-22T19:45Z) | 375 message ids, 486 stored revisions in the range read, 58 XAUUSD signals | Verified (Firestore `telegram_messages`, 500 reads, 0 writes) |
| Second out-of-sample test of the frozen strategies | all negative, see section 3 | Modeled (Dukascopy ticks) |
| Firestore plan | free plan (`billingEnabled: false`), daily quota exhausted by AutoTrader polling | Verified |

The earlier statements "Vantage contract size, tick value, lot limits unverified" are replaced by the table
above. Margin, commission and a representative in-hours spread remain **Unknown**; the account is a demo.

## 2. Data used for OOS2 and deviations from the pre-registration

Pre-registration: `PREREGISTRATION_OOS2.md` (sha256 `073151fa1e95c3b07e39d635412673fc424dae17a3a249589dc062f79f046702`),
written before any message text of the period was read. Frozen set unchanged: S_TP4|M5, S_TP4|M0, Q_25x4|M3,
Q_25x4|M0, S_TP3|M0 and benchmark S_TP1|M0, engine `sim_engine_b2.py`, E1/E2, MID costs primary.

Deviations (all made before any result was seen):
- The stored `parsed_ok` field in Firestore comes from the legacy history parser (it demands the word "NOW") and
  rejected all 499 revisions. Signals were identified with the Python port of `vipSignalParser` (verified 3,317/3,317
  against the repo parser in the main study).
- n = 58 signals (not the 80 to 120 guessed): power to detect anything smaller than roughly |0.4| R is low.
- Tick data were downloaded for 2026-09-27 .. 2026-10-23 (all hours resolved after retrying five HTTP 503 hours).
  Independent check: 37.7 million ticks in the signal windows, median spread 0.56 USD.
- Pipeline validation: the new evaluator reproduced all 1,398 stored B2 trade results for old signals exactly.

Three signal universes were evaluated: **final** (time = post time, levels = final text; same method as the main
study), **first** (time = when the system first saw a parseable revision, levels of that revision) and **live**
(`first` restricted to signals seen within the 120 s default age gate).

## 3. Results (E2 = project `pending_at_range`, MID costs; mean R per filled trade, 95% bootstrap CI)

| Variant | final (n) | first (n) | live (n) |
|---|---|---|---|
| S_TP4\|M5 (Conservative draft) | -0.66 [-0.79, -0.52] (53) | -0.67 [-0.81, -0.53] (50) | -0.69 [-0.82, -0.54] (49) |
| S_TP4\|M0 | -0.58 [-1.04, +0.00] (53) | -0.47 [-1.04, +0.24] (50) | -0.46 [-1.04, +0.31] (49) |
| Q_25x4\|M3 | -0.49 [-0.77, -0.14] (53) | -0.47 [-0.79, -0.08] (52) | -0.46 [-0.79, -0.05] (50) |
| Q_25x4\|M0 | -0.53 [-0.81, -0.19] (53) | -0.51 [-0.82, -0.11] (52) | -0.50 [-0.82, -0.09] (50) |
| S_TP3\|M0 | -0.67 [-0.97, -0.27] (53) | -0.71 [-1.04, -0.29] (51) | -0.70 [-1.04, -0.27] (49) |
| S_TP1\|M0 (benchmark) | -0.35 [-0.62, -0.08] (53) | -0.40 [-0.66, -0.13] (52) | -0.41 [-0.67, -0.12] (50) |

Holm-adjusted p (12 primary tests, final universe): S_TP4|M5 <0.001 (every one of 53 trades ended at the stop,
33, or at break-even, 20; none reached TP4), S_TP3|M0 0.018, Q_25x4|M0 0.045, others 0.06 to 1.0. E1 (market
within 2.0 USD) results are similar, except S_TP4|M0, which is +0.18 [-0.82, +1.47] (n = 27) in the live
universe: a point estimate above zero with a CI that is useless at this n. Fill rates at MID: E2 53/58 (91%),
E1 31/58 (53%), strict E3 14/58 (24%).

Independent plausibility check of the zero-TP4 result (no strategy, raw ticks only): within 72 h price touched
TP1 in 91% of signals, TP4 in 50%, but the stop in **95%**. The stops are tight relative to the swings, so the
stop is usually hit first.

Pre-registered hypotheses:
- **H1 (not distinguishable from zero): not supported in the direction that matters.** The Conservative draft's
  mean is significantly *negative* in this sample. Per the pre-registration this counts as evidence against it.
- **H2 (late-edited signals do better than text-stable ones): partly replicated, mechanism not established.**
  Difference late (>300 s, n = 16) minus stable (n = 37): S_TP4|M5 +0.45 [+0.18, +0.71]; S_TP1|M0 +0.86
  [+0.30, +1.42]; Q_25x4|M0 +0.29 [-0.31, +0.92]; S_TP4|M0 -0.11 [-1.01, +0.89]. Late-edited signals are still
  negative on average for the TP4 variants (-0.34 for S_TP4|M5); only the TP1 exit is positive on them (+0.25).
- **H3 (live-engine view mean <= 0): holds for 11 of 12 point estimates**; the exception is E1 S_TP4|M0 above.

## 4. Findings that change earlier statements

1. **Providers rewrite levels after posting (Verified).** Of the 58 signals, 31 had a first parseable version
   that differs from the final one: entry in 10, stop-loss in 9, existing take-profit values in 18, take-profits
   only appended in 1. Median 8.6 minutes between first parseable and final version (p90 59 minutes). 39 of 58
   signals reached the forwarder first as an *edit* event.
2. **But the rewriting does not explain the results here.** Re-running with first-version levels instead of final
   levels changes E2 mean R by +0.02 (S_TP4|M5, n = 50) and -0.03 (S_TP1, n = 52); among the signals whose
   levels changed the difference is +0.005 and -0.045. The main report's hypothesis that late edits embed
   hindsight is therefore **not confirmed** by this sample (it is not refuted either: the main study could not
   observe first versions).
3. **Correction to the earlier remark that the 120 s age gate would skip the profitable group.** The gate uses the
   original message date, but the first parseable revision reached the system within 120 s for 56 of 58 signals,
   so the gate would skip only 2. What the live engine does when later revisions change levels (`handleRevision`)
   was not simulated here.
4. **Sign change versus the main study.** The main study's last 81 signals gave E2 S_TP4|M5 +0.20 R (CI spanning
   zero); this independent month gives -0.66 R. The two are not poolable without a regime explanation (market regime in the two periods was not examined). Together they say: **the edge is not stable**.

## 5. Cross-check of the `auto-trader` session's work (read-only)

- Reproduced: worker tests 764/764 pass, web tests 67/67 pass, strict `tsc --noEmit` exit 0.
- Its claim of a DEMO hedging account was reproduced through the bridge (`trade_mode` DEMO, `margin_mode` HEDGING).
  The account is flat. EA version 2.0.0, magic 98801.
- The kill-switch/fail-closed behaviour held under the Firestore outage: 48 `execution_control_fail_closed` log
  events, no entries opened. That is the correct failure direction.
- **Problem (Verified from the journal): the AutoTrader cannot run on the free Firestore plan.** Pollers run every
  2 to 3 seconds (about 1.2 queries per second, nominally up to roughly 100,000 reads a day against a 50,000 cap;
  actual read counts were not measured). `RESOURCE_EXHAUSTED` occurred 2026-10-22T22:00Z to about 07:00Z and again
  from 2026-10-23T18:00Z until the 07:00Z reset on 2026-10-24. During those windows no signal can be traded and
  the forwarder logged 575 failed history writes (signals are spooled locally by design; the spool file was empty).
- **Unexplained:** about 60% of provider messages in the period reached the forwarder first as an edit, never as a
  new-message event (240 of 399). The engine treats a first-seen edit as a fresh signal, so trades are probably
  not lost, but the cause (update delivery or the provider's posting method) is unknown.
- The active demo profile and the execution mode could not be read while the quota was exhausted; they were not
  read afterwards to save quota.

## 6. Updated recommendation

- Do **not** treat the Conservative draft as a profit candidate. After two independent out-of-sample periods with
  opposite signs, the evidence supports only "no stable edge". It can still be used on the demo account as an
  *operations* test (order mechanics, sizing, break-even handling), which has no profit expectation.
- Keep the owner decisions listed in `OPTIMAL_REPORT.md` section 9 and add: enable billing on the Firebase project
  or lengthen the polling intervals before relying on the AutoTrader.
- For any further forward test, record per-signal first-seen and final versions (already stored in
  `telegram_messages`) and compare against at least 100 more signals before drawing conclusions. Gold reopens
  Sunday 22:00Z; no demo order was placed in this session, and crypto symbols had no quotes on the weekend.

## 7. Files

Scripts and aggregates (no message text, no per-trade tables) are in `analysis/oos2/`: `oos2_fetch.mjs`,
`oos2_build.py`, `oos2_eval.py`, `h2.py`, `bridge_ro.mjs`, `PREREGISTRATION_OOS2.md`, `revisions_summary.json`,
`final_summary.json`, `first_summary.json`, `live_summary.json`.
