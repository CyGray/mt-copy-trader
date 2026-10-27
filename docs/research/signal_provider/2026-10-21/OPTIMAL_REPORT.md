# Optimal Report - XAUUSD Telegram Signal Provider (channel -1003271337051)

Status: **research draft for operator review. Nothing here is approved, activated, or deployed.**
Run: 2026-10-21 .. 2026-10-24. Coordinator: Claude (Sonnet 5.5 - the brief named Opus 5.5; disclosed
substitution). Analysis agents: Claude Haiku 5.5 at xhigh reasoning effort (A1-A3, B1-B3, C1, C2), as requested.
All figures were checked by an independent auditor (C2); where the auditor or the coordinator corrected an
agent, the corrected value is used.

Evidence classes: **Verified** (directly supported), **Modeled** (verified inputs + stated assumptions),
**Inferred**, **Unknown**. Supporting detail: `SIGNAL_DATA_AUDIT.md`, `SIGNAL_PERFORMANCE_REPORT.md`,
`STRATEGY_COMPARISON.md`, `RESEARCH_VALIDATION.md`, `execution_profile.draft.json`.

> **Update 2026-10-24 (read `OOS2_AND_LIVE_CROSSCHECK.md` first).** A second, pre-registered out-of-sample test on
> the 58 signals posted after this report's data ended (2026-09-24 .. 2026-10-22) gave negative results for every
> frozen strategy: the Conservative draft S_TP4|M5 averaged **-0.66 R** [-0.79, -0.52] (53 trades, none reached
> TP4), against +0.20 R in the earlier OOS. The edge is not stable; treat the profile drafts as operations-test
> material only. Also corrected: Vantage demo XAUUSD specs are now Verified (contract 100 oz, tick value 1, lot
> 0.01/0.01, stops level 0.20 USD, IOC, hedging, 1:100); the claim that the 120 s age gate skips the "profitable"
> late-edited group is withdrawn (the gate would skip only 2 of 58). The AutoTrader cannot run on the current free
> Firestore plan (daily quota exhausted by its polling).

---

## 1. Executive summary

1. **No profitable, tradable edge was established.** Reconstructing 415 provider signals (2025-10-30 ..
   2026-09-24) against independent Dukascopy XAUUSD ticks, no exit strategy has a mean R distinguishable from
   zero out of sample (every 95% CI contains 0; Holm-adjusted p = 1.0; White's Reality Check vs zero p = 0.11 -
   0.22), and the only configurations with positive means are fragile (see 3).
2. **The positive results come from signals edited long after posting.** About 25% of clean signals (104 of 406)
   had their text edited more than 5 minutes after posting, and 80% of those had already reached TP1 before the
   edit. On this group, a single TP4 exit averages +1.44 R (n = 76) and 100% TP1 +0.42 R (n = 83); on the 75%
   text-stable group they average **-0.22 R (n = 225)** and **-0.31 R (n = 283)** (MID costs, project
   `pending_at_range` entry). Original pre-edit text is unrecoverable, so late edits may embed hindsight.
   (Modeled; exploratory/post hoc; found by the auditor, re-computed by the coordinator.)
3. **Entry is the dominant practical problem.** The provider's posted ranges sit on the *favourable* side of the
   market at posting (BUY entry median 1.95 USD below the market, SELL 1.84 USD above; Verified, n = 415).
   Taking the signal at market inside the posted range fills only 16% of signals; widening tolerance to 2 USD
   fills 72%; the project's pending-at-range policy fills ~90% (at the range edge, i.e. as a limit).
4. **Costs and timing swing results as much as exit choice.** +1 USD adverse fill on every trade makes the
   strict-entry sample negative; shifting the entry clock by -60 s flips 100% TP1 from -0.14 R to +0.08 R.
5. **Do not run this provider live on this evidence.** If the owner wants to continue, the defensible next step is
   a **paper/demo forward test with signal-revision capture** (6), not an activation of any profile.
6. **Live Telegram verification is incomplete** (Firestore reads were refused for the whole run); the newest
   message seen is 2026-09-24T14:34:48Z from the local export.

## 2. Provider assessment

| Question | Finding | Label |
|---|---|---|
| Win rate | Depends on definition. Strict-entry fills (n = 68): TP1-before-SL 55.9% [44.1, 67.1], TP2-before-SL 30.9%, last-TP-before-SL 16.2%, SL-before-any-TP 44.1%. | Reconstructed |
| Profit factor / expectancy | 100% TP1: PF 1.10, +0.05 R [-0.19, +0.28] (BASE) and -0.18 R (PESS costs). Optimised entries (n = 220-300 fills): single exits -0.06 to -0.27 R in train/validation. | Simulated |
| TP hit frequencies | TP1/TP2/TP3/TP4 touched before SL: 55.9% / 30.9% / 22.4% / 19.6%. P(TP2 \| TP1 first) 55%; P(TP3 \| TP2 first) 75%. | Reconstructed (n = 68) |
| Drawdown | 100% TP1: 4.0 R max closed DD (n = 68); equal thirds 7.8 R; single TP4: 16-23 R OOS, bootstrap p95 26-45 R. | Simulated |
| Loss streaks | TP1: longest 3 (n = 68); TP4 OOS block-bootstrap p95 23 (E1) - 39 (E2) consecutive losses. | Simulated |
| Consistency | Monthly TP1-before-SL ranges 25% - 100% (2-16 fills/month). Provider behaviour drifted (signals/month 3 -> 59; SL distance 3 -> 5-7 USD; mostly 4 TPs). | Observed |
| Survives realistic execution? | Not demonstrably. Net of Dukascopy spread, modest extra cost/latency turns small positives negative. | Modeled |
| Provider's self-reported results | 785 outcome posts, only 54 loss-type, no "SL hit" statement; 132 of 154 unambiguous TP-hit claims refer to signals not enterable at the posted range. Treated as unverified marketing-like stream. | Observed/Reconstructed |
| BUY vs SELL, session, weekday, regime | Descriptive only; signs flip across periods; pre-registered SELL>BUY and trend>range hypotheses failed. **No filter recommended.** | Modeled |

## 3. Most defensible exit strategy

The data do **not** support a unique best configuration. Ranked by robustness (least bad first), among exits the
project's profile schema can execute:

| Rank | Exit | OOS mean R E2 (n) | Why |
|---|---|---|---|
| 1 | **100% at TP1, original SL** (reference) | -0.10 (73) | Shortest exposure (median 0.1-0.2 h), p95 DD 6-29 R, highest hit rate - but negative expectancy. Choose this only if capital preservation is the goal. |
| 2 | **100% at TP4 + break-even at +4.0 USD** (M5) | +0.20 [-0.33, +0.80] (68) | Best finalist on risk-adjusted terms: BE cuts DD to 13.5 R (vs 22.6 R) and 38% of trades exit at BE. Positive mean arises only from late-edited signals; -0.40 R after dropping top 5 winners. |
| 3 | 100% at TP4, original SL | +0.21 [-0.47, +0.99] (68) | Same mean, p95 DD 45.5 R; -0.47 R without top 5 winners. |
| 4 | 25% x 4 checkpoints | 0.00 [-0.37, +0.42] (73) | No gain; needs >= 0.04 lots. |

- **Selected TP checkpoints / allocation:** if any research exit is used, one checkpoint at **TP4 = 100%** with
  break-even at +4.0 USD (approx. 0.67 R of the median 6 USD fill risk) - or TP1 = 100% for the lowest variance.
  Multi-checkpoint splits (110 variants), close-all variants (6) and TP1-sacrifice arguments did not improve any
  tested mean (0 of 116 positive in-sample).
- **Does taking TP1 sacrifice too much?** In-sample, later TPs look better (TP4 minus TP1: +0.44 R E1, p = 0.054;
  +0.38 R E2, p = 0.04), not confirmed OOS (+0.08 / +0.33 R, Holm p = 1.0), and confounded by the edit-timing
  bias. Waiting for TP4 multiplies p95 drawdown by 1.6x (E2) - 4x (E1).
- **Runner:** **0%.** 72 runner variants (10-40% of initial volume, trailing after TP1/TP2, 1.5-6 USD) had no
  positive in-sample mean under either entry; runner share and trail made no material difference; no-runner beat
  the best runner by 0.33-0.36 R in-sample (not multiplicity-adjusted). The schema also cannot express a true
  runner (the final checkpoint always closes the remaining volume). Whether runners help in trends vs ranges
  could not be tested reliably (n too small; the trend hypothesis failed).
- **Stop management:** original SL; optional BE at +4.0 USD. BE reduced drawdown without changing the mean; a
  post-hoc 6 USD BE gave no consistent gain. Trailing never entered the shortlist.

## 4. Entry and execution rules (Modeled)

- Policy tested: project `pending_at_range`, tolerance 0.5 USD, pending expiry 60 min (fills ~90%: pending
  limits at the range edge on Ask for BUY, Bid for SELL). Other expiries were not re-tested after the
  pending-order engine defect was corrected.
- Stop-distance bounds: min 2.0, max 15 USD (clean signals 2.0 - 12.0; p99 10; both bounds practically non-binding).
- Latency: 5 s vs 60 s changes fills (68 vs 93) but not TP1-first (63.3% both, n = 30).
- Signal age: 120 s default; edit lag (median 52 s for signals) suggests a pending order should follow edits
  (`before_fill: apply_sl_tp`) - **untested**.
- Cancels: none exist in the history (0 / 3,317); `explicit_cancel` untested.
- Spread gate: Dukascopy spread median 0.68 USD (7.2% of ticks <= 0.50, 91.5% <= 1.00); the default safety cap
  0.5 would block most entries. Vantage spread is **Unknown**.

## 5. Risk and position-sizing conclusions (account specs **unverified**)

The Vantage demo account balance, currency, leverage, symbol name, contract size, tick value, lot limits, margin
and commission could not be read (the bridge was not contacted; Firestore unreadable). Sizing numbers below use
placeholders: 100 oz/lot, 1 USD per 0.01 move per lot, min/step 0.01, margin = 100 x price / leverage, equity
scenarios. **The operator's approved risk ceilings override all of this.**

| Layer | Value | Label |
|---|---|---|
| Broker constraints | Unverified (min lot 0.01 / step 0.01 assumed) | Unknown |
| Code hard ceilings | 5% risk/trade, 20 lots, 20% total risk, 20,000 daily loss | Verified (`executionProfile.ts`) |
| Default safety (only if `settings.safety` absent) | risk min(1%, 50 USD), 1 per symbol, 3 concurrent, 3% total, 100 USD daily, spread 0.5, margin floor 200% | Verified |
| Draft-profile limits | risk 0.25%, 1 concurrent, 1% total, 50 USD daily, spread 1.0, SL 2-15 | Research-recommended (draft) |

- **Recommended risk policy: Conservative, `equity_risk_percent` 0.25%, `below_min_volume: skip`.** Per-trade loss
  at a median 5 USD stop and 5,000 USD equity is 10 USD (2 lots-steps of 0.01 -> 0.02 lots after rounding down
  from 0.025). Never use `use_min_if_within_cap` (it tests the safety cap and can risk 2-4x the target at
  500-1,000 USD).
- **Tradeable share of signals at 0.25% risk:** 0% at 500 USD, 3.9% at 1,000, 100% from 5,000 USD. At 0.5%: 3.9% /
  58.6% / 100%; at 1%: 58.6% / 99.5% / 100%.
- **Feasible lot sizes:** single-TP exits from 0.01 lots; two-way splits 0.02; three-/four-way splits (and
  3 + 10% runner) exact only from 0.04 lots; a 30% runner variant 0.05. Equity needed for an exact 3-way
  split at the median 5 USD stop: ~2,000 USD at 1% risk, 4,000 at 0.5%, 8,000 at 0.25% (3,000 / 6,000 / 12,000
  for the p90 7.5 USD stop). At 5,000 USD / 0.25% only ~3% of E2 fills allow a 4-way split.
- **Expected drawdown by sizing policy** (10,000 bootstrap resamples of the 67 strict-entry trades,
  5,000 USD, default safety): 0.25%: p95 5.1% / p99 6.4%; 0.5%: p95 10.4% / p99 12.9%; 1%: p95 19.5% / p99
  24.3%, P(DD >= 20%) 4.3%. Full-loss streak of 10 at 1% and 5,000 USD loses 9.1% (12.5% with 2 USD adverse
  fills). A single-TP4 exit at 1% risk had a median bootstrap max DD of 21-29% (p95 42-53%) in-sample.
- **Daily/total limits:** at 1% risk and 5,000 USD the 100 USD daily loss gate fires on ~4.5% of day-slots; with
  one position per symbol, total risk and margin are not binding at 1:100 for risk <= 1% (margin binds at >= 4
  concurrent positions at 1% and 1:100).
- **Overshoot:** market entries fill a median 0.9 USD (p90 1.4) farther from the SL than the nominal distance, so
  realised risk exceeds sized risk by about 17-33% unless sizing uses the live quote.

## 6. Profiles (all unapproved research candidates; none guarantees anything)

All four share: placeholder `broker_symbol` `UNVERIFIED-XAUUSD` (fails closed), entry `pending_at_range` tol 0.5
expiry 60 min, `missing_tp: skip_trade`, stop bounds 2-15 USD, edits `apply_sl_tp` / `apply_tighten_only`.

| Profile | Exit | Sizing | Limits | OOS evidence (E2, MID) | Fit |
|---|---|---|---|---|---|
| **Conservative** (`execution_profile.draft.json`) | 100% TP4, BE +4.0 USD, `broker_tp` final | 0.25% risk | 1 concurrent, spread 1.0, 50 USD daily, 1% total | +0.20 R [-0.33, +0.80], n = 68; DD 13.5 R; p95 30.8 R | lowest finalist DD; CI spans 0; positive mean from late-edited signals only |
| **Balanced** (`alternates/balanced.draft.json`) | 25% x 4 at TP1-TP4, merge into next | 0.5% | as default safety | 0.00 R [-0.37, +0.42], n = 73; DD 16.3 R | middle variance; no expectancy; needs >= 0.04 lots |
| **Aggressive** (`alternates/aggressive.draft.json`) | 100% TP4, original SL | 1% | spread 0.5 (within default safety), no relaxed safety limits | +0.21 R [-0.47, +0.99], n = 68; DD 22.6 R; p95 45.5 R | highest variance and drawdown |
| Reference (`alternates/benchmark_tp1.reference.json`) | 100% TP1 | 0.25% | - | -0.10 R [-0.33, +0.13], n = 73 | for comparison only |

Validation: all four validate with the project's real `validateProfile` (0 errors, 0 warnings, within hard
ceilings). With **default** safety the Conservative/Balanced/Reference drafts are refused (spread gate 1.0 vs
safety 0.5) until the owner raises `settings.safety.max_spread_price`; the Aggressive draft passes default safety
but its 0.5 gate would skip most entries on this proxy's spreads. See `profile_validation_output.txt`.

### Recommended research configuration

**None is recommended for live trading.** The evidence does not support activating any profile: no out-of-sample
CI excludes zero in the favourable direction, the cleanest subset (text-stable signals) is negative, and
the Dukascopy price proxy, edit bias and unknown Vantage costs add uncertainty. The Conservative draft is the
most defensible **experimental forward-test candidate** (labelled so in the file) because it has the lowest
drawdown among the finalists and 38% break-even exits.

## 7. Failure conditions and limitations

- Dukascopy is not Vantage (spread, slippage, requotes, commissions, swap, contract size, tick value unknown).
- Edited signals: original levels and edit times unrecoverable (411 / 415 edited; 104 clean signals edited
  > 5 min after posting); this may bias every favourable result.
- The strict-fill rate depends on deciding at the first tick; waiting for the band fills 94-98%.
- Sample: 325 optimisation signals, 81 OOS signals (33-73 fills), 26 distinct OOS days; minimum detectable mean
  is ~1.0-1.3 R for TP4 exits and ~0.3 R for TP1.
- No portfolio mark-to-market drawdown, no swap/commission, overlapping trades not simulated for E1/E2.
- Provider drift (signals/month 3 -> 59); the stream after 2026-09-24 is unobserved.
- Stop spikes: 56-63% of >= 5 USD one-tick jumps revert within 60 s; false-stop risk not removable without
  Vantage's own feed.
- Break-even in the AutoTrader acts on polled broker prices, so triggers can be late relative to the simulation.
- Firestore settings/safety limits and production health unread; the quota failure may affect the live forwarder.

## 8. Confidence assessment

| Statement | Confidence |
|---|---|
| Provider levels are favourable-side at posting; strict-market entry is rarely available | **High** (Verified, n = 415, independently reproduced) |
| No exit strategy is distinguishable from zero OOS | **High** (consistent across 196 variants, audit, bootstrap) |
| Text-stable signals lose money; late-edited signals carry the gains | **Medium** (large n and reproduced, but post hoc and mechanism unproven) |
| Runners do not help; multi-checkpoints do not help | **Medium** (in-sample, many variants) |
| TP4 + BE is the best of a bad lot | **Low** (selection among noise) |
| Sizing figures | **Medium-Low** (conditional on unverified broker specs) |
| Provider quality after 2026-09-24 | **Unknown** |

## 9. Recommended next steps (owner decisions)

1. **Capture revisions going forward.** Firestore stores every text revision (`telegram_messages` and `signal_events`
   keyed by text hash), so a forward period will record original and edited text. Re-run the edit-timing audit on
   that data before trusting any past positive result.
2. Paper-trade (not live) the Conservative draft or the TP1 reference for at least 100-200 enterable signals,
   logging every decision, fill, skip and revision; the n = 68-73 OOS sample cannot confirm or refute an edge.
3. Verify the Vantage demo specs read-only (`ACCOUNT_INFO`, `SYMBOL_INFO`, `ORDER_CHECK`; checklist in
   `RESEARCH_VALIDATION.md`) with the AutoTrader in `disabled`, and set the true `broker_symbol`.
4. Check the Firebase quota page and production `system_logs` (`signal_forward_failed`) for the project in `.env.local`.
5. Confirm why `terminal64.exe` and a bridge listener on 127.0.0.1:5555 appeared on the host on 2026-10-23 (not
   started by this research) and that the AutoTrader mode is `disabled` or `paper`.
6. Decide the owner risk ceilings (`settings.safety`) before any profile is approved; the profile cannot raise them.
