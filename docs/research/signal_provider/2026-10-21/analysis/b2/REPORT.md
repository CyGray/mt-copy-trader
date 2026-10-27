# B2 - TP and runner optimiser for the ByTrader XAUUSD signal study

Status: research only. Nothing here changes the repo, worker/dist, services, Telegram, Firestore or any broker.
No position-sizing recommendation is made (that is Agent B3). No filter is recommended.

Labels used throughout: **Observed** = taken directly from signal text or tick data with no exit model;
**Reconstructed** = entry/fill and tick-level touch facts replayed from ticks; **Simulated** = strategy exit-model
outcomes (R, drawdown, expectancy). Every table gives n. "R" = total_R of a trade, R = |fill - SL| (engine convention).
Costs: BASE (spread +0, slip 0, latency 5 s), MID (spread +0.10, slip 0.05, latency 10 s), PESS (spread +0.20, slip 0.10, latency 15 s).
Cost scenarios change the latency, so the set of fills can change between scenarios too.

## 0. Bottom line

1. **No strategy shows a statistically distinguishable positive expectancy after MID or PESS costs.** Out of sample
   (OOS, 81 clean signals, each of 6 frozen variants evaluated once), every 95% bootstrap CI of mean R contains zero,
   under both optimised entry models and all three cost scenarios (Section 8).
2. **The best-looking family is a single exit at TP4 (100% at TP4, original SL).** In-sample on TRAIN+VALIDATION it
   averages +0.31 R (E1, n=148) and +0.20 R (E2, n=233) on the signals that carry a TP4. OOS it averages +0.19 R
   (E1, n=33) and +0.21 R (E2, n=68), CIs about -0.6 to +1.1 R. A paired OOS comparison against TP1 gives +0.08 R (E1)
   and +0.33 R (E2), neither significant (Holm-adjusted p = 1.0). Under PESS costs the TP4 variants stay positive in both
   entries (E1 +0.30 R, n=30; E2 +0.18 R, n=68), as does E1 S_TP3 (+0.15 R, n=33). None of these CIs excludes zero.
3. **Multiplicity-aware checks agree.** White's Reality Check on the TP4-present subset, 196 variants, TRAIN+VAL, MID:
   best vs zero p = 0.11 (E1) and 0.22 (E2). Best vs the TP1 benchmark is p = 0.03 (E1) and 0.04 (E2) in-sample only.
   Those in-sample wins were not confirmed OOS.
4. **Runners do not improve expectancy.** None of the 72 runner variants has a positive TRAIN+VAL mean under E1 or E2.
   The best runner is below the best schema-expressible variant (paired -0.33 R, CI [-0.75, +0.05], E1; -0.36 R,
   CI [-0.73, -0.00], E2). Runners are also not schema-expressible (Section 5), so they are excluded from finalists.
5. **Multi-checkpoint splits did not help.** None of the 110 multi-checkpoint variants has a positive TRAIN+VAL mean
   (E1 median -0.12 R; E2 median -0.15 R). Adding TP2/TP3 legs did not improve the average outcome.
6. **Taking TP1 does sacrifice expectancy in-sample, but waiting costs drawdown and exposure.** Section 10 gives the detail.
   OOS, waiting for TP4 instead of TP1 raises the block-bootstrap p95 drawdown from 6.0 R to 25.7 R under E1
   (about 4x) and from 28.8 R to 45.5 R under E2 (about 1.6x), for a mean-R gain that is not significant.
7. **Engine defect found in B1 and corrected in a B2 copy.** B1's P2 pending-at-range model never filled a SELL limit
   (202/202 SELL pending orders expired), and BUY limits triggered on Bid rather than Ask. Every P2 number in the B1
   report (including its "49% fill rate") is therefore wrong. Corrected E2 fill rates are about 90% (Section 2).
8. **Project fit.** The 124 non-runner variants are expressible in the execution-profile schema. Runners, a 24 h horizon
   and close-before-weekend are not (no runner concept, no time-stop field). The frozen finalists are all expressible.
9. **Profile labels (descriptive, not sizing).** No finalist meets a positive-expectancy criterion with confidence, so
   none is a defensible Balanced or Aggressive live profile on this evidence. Section 13 maps the candidates by drawdown
   and exposure only.

## 1. Data, universe and splits

| Split | Clean signals | Period (UTC, signal time) | BUY | SELL | Label |
|---|---|---|---|---|---|
| TRAIN | 244 | 2025-10-30 11:36 to 2026-06-02 15:16 | 101 | 143 | Observed, n=244 |
| VALIDATION | 81 | 2026-06-03 07:04 to 2026-08-17 14:50 | 38 | 43 | Observed, n=81 |
| OOS | 81 | 2026-08-17 17:50 to 2026-09-24 13:06 | 23 | 58 | Observed, n=81 |

- Universe: 415 signals in B1's accepted set; 406 "clean" (no hard flag) used for all optimisation. The 9 hard-flagged
  signals are all in TRAIN (TRAIN incl. flagged = 253). Their ALL-universe effect is in Section 12.
- Split rule (fixed in code before any OOS): clean signals sorted by time; TRAIN = first round(0.6 x 406) = 244,
  VALIDATION = next round(0.2 x 406) = 81, OOS = last 81.
- Tick data: B1 cache (decoded Dukascopy XAUUSD hours, complete for 2025-10-30 to 2026-09-28). Dukascopy, not Vantage.
  Median hourly spread 0.69 USD is already inside the bid/ask (Observed, B1 QC).

## 2. Engine defect (B1) and the B2 patch

**Defect.** `decide_entry` for P2 (pending at range edge) compared `first_le/first_ge(limit)` on `y = fav * exit_px`.
For SELL, `y = -Bid'`, so the test `-Bid' >= limit` (limit about 4000) was never true. For BUY the test used Bid
instead of Ask (BUY_LIMIT fills when Ask falls to the limit), which is optimistic by roughly the spread.

**Evidence.** B1 `results.json`, P2_EXP60 scenario: 202 of 202 SELL pending orders ended `SKIPPED_pending_expired`
(0 SELL limit fills). This is Observed in B1 output, n=202.

**Patch (copy only, B1 untouched).** `sim_engine_b2.py`: added `Market.first_entry_ge/first_entry_le` on `entry_px`
(Ask' for BUY, Bid' for SELL), and `decide_entry` uses them for P2 pending triggers. Diff: `sim_engine_b2.diff` (52 lines).
Verification:
- B1's 35 unit tests pass unchanged on the patched copy (`test_sim_engine_on_b2.py`).
- 4 new tests (`test_b2_engine_patch.py`): BUY limit must not fill when only Bid touches the limit; SELL limit fills
  when Bid reaches the low; SELL limit expires correctly; the unpatched B1 module reproduces the defect.
- Cross-check against B1 (`b2_check_vs_b1.py`): the rebuilt E3 BASE 100%TP1 trades equal B1's CLEAN BASE TP1 trades,
  67 of 67 signals, identical fill set, max |dR| = 5e-5, mean R 0.0349 for both (Reconstructed + Simulated, n=67).

**Effect of the fix (Reconstructed, BASE, CLEAN).** E2 fills now: TRAIN 224/244 (91.8%), VALIDATION 74/81 (91.4%),
OOS 73/81 (90.1%). Of the TRAIN+VALIDATION E2 fills (n=298 at BASE), 241 are pending (110 BUY_LIMIT, 131 SELL_LIMIT)
and 57 are market. B1's 49% was an artefact.

## 3. Protocol and deviations (read this before the numbers)

- Exploration on TRAIN only. Shortlist and score used TRAIN and then VALIDATION (MID costs only; E1 and E2 separately;
  E3 report-only). Freeze written by `b2_select.py` with sha256 `907790184fd086998e07533102e1e6f8a332c55e5626ef52b0a4d60b63432235`.
  Phase-2 re-computes this hash and refuses to run if the file changed.
- OOS evaluated exactly once per frozen variant (5 finalists + the benchmark = 6 variants) for E1, E2 and E3 at BASE,
  MID, PESS (lock file `out/oos_evaluated.lock`). Benchmark is frozen as a reference, not a finalist.
- After OOS, I re-used OOS signals for three descriptive or robustness analyses (walk-forward, horizon/weekend
  sensitivity, pre-registered H1/H2 tests). None of these changed the frozen set. Section 9 flags which numbers are
  OOS-contaminated in this way.
- **Deviation 1 (BE distance).** The grid's break-even at "1R" was implemented as a fixed 4.0 USD (M5), because the
  schema's break-even distance is in price, not in R. The measured median fill risk on TRAIN MID is 6.56 USD (E1, n=130),
  6.05 USD (E2, n=220), 5.49 USD (E3, n=53) (Reconstructed; p10-p90 about 4.0 to 10.0 USD). So 4.0 USD is roughly 0.6-0.7R,
  not 1R. The frozen grid is not changed. A post-hoc 6.0 USD (about 1R) check on TRAIN+VALIDATION only is in Section 12;
  it does not change the conclusion.
- **Deviation 2 (E1 nominal guard).** E1 skips a fill when the actual risk |fill - SL| exceeds 1.5 x nominal
  (|entry mid - SL|), as specified. This is a research guard, not a project rule. The project rule that does apply
  (validateStopLoss, min 2.0 / max 25.0 price units) rejected zero fills in this sample (Observed in fill logs).
- **Deviation 3 (trailing distance family).** Trailing distances use fixed USD {1.5, 2.5, 4.0, 6.0} with step 0.5, not
  R-multiples, because the schema's `distance_price` / `step_price` are price units. R-multiple trailing would not be
  expressible in a single profile.
- **Deviation 4 (missing TP).** Single-exit variants use skip_trade when that TP is absent (the trade cannot be taken).
  Multi-checkpoint variants fold a missing checkpoint's share into the last existing checkpoint, as the project does.
  This makes TP4-only trades a subset of signals that have a TP4 (Section 6, bias warning).

## 4. Entry models E1, E2, E3 (Reconstructed fills)

Definitions (never pooled):
- **E1** = P1 market if price is within the range +/- 2.0 USD at the first tick after latency; else no trade.
  Then the project stop checks (2.0 <= SL distance <= 25.0) and the 1.5x nominal guard. Optimised.
- **E2** = P2 (project `pending_at_range`): market if price is within +/- 0.5 USD; else a pending limit at the
  unfavourable range edge (BUY_LIMIT at high, SELL_LIMIT at low), valid 60 min, filled when Ask' (BUY) or Bid' (SELL)
  reaches the limit, fill price = limit + adverse slippage. Optimised.
- **E3** = P1 strict (+/- 0.5 USD). Report-only, no optimisation.

Fill counts (Reconstructed, clean signals; fill rate in brackets):

| Split (n) | Model | BASE | MID | PESS |
|---|---|---|---|---|
| TRAIN (244) | E1 | 133 (54.5%) | 130 (53.3%) | 121 (49.6%) |
| TRAIN (244) | E2 | 224 (91.8%) | 220 (90.2%) | 219 (89.8%) |
| TRAIN (244) | E3 | 45 (18.4%) | 53 (21.7%) | 49 (20.1%) |
| VALIDATION (81) | E1 | 53 (65.4%) | 48 (59.3%) | 43 (53.1%) |
| VALIDATION (81) | E2 | 74 (91.4%) | 74 (91.4%) | 74 (91.4%) |
| VALIDATION (81) | E3 | 12 (14.8%) | 14 (17.3%) | 13 (16.0%) |
| OOS (81) | E1 | 39 (48.1%) | 37 (45.7%) | 33 (40.7%) |
| OOS (81) | E2 | 73 (90.1%) | 73 (90.1%) | 73 (90.1%) |
| OOS (81) | E3 | 10 (12.3%) | 10 (12.3%) | 11 (13.6%) |

Skip reasons (Reconstructed, counts from fill logs):
- E1 TRAIN: price outside +/-2.0 range 73 (BASE), 74 (MID), 74 (PESS); 1.5x nominal guard 38 / 40 / 49.
  VALIDATION guard 6 / 9 / 12. OOS guard 24 / 18 / 22.
- E2 TRAIN: pending expired 20 / 23 / 23 (BASE / MID / PESS). OOS 8 pending expired.
- E3 TRAIN: price outside +/-0.5 range 199 / 191 / 195.
- Project SL distance rejections (2.0 min, 25.0 max): 0 in every split and model.
- Counts are not monotone across cost scenarios because the latency change (5/10/15 s) moves the first sampled tick.
- Fill kinds, TRAIN+VALIDATION, BASE (Reconstructed): E1 = 71 BUY + 115 SELL market. E2 = 17 BUY + 40 SELL market,
  110 BUY_LIMIT, 131 SELL_LIMIT.
- Median risk per filled trade, TRAIN MID (Reconstructed): E1 6.56 USD (n=130), E2 6.05 (n=220), E3 5.49 (n=53).

Ex-ante regime features (`regime_features.csv`, prior 4 h of ticks, no data at or after signal time): available for
393 of 415 signals. Tercile cut-points fixed on TRAIN (Efficiency Ratio): low 0.0714, high 0.1653 (n=239 TRAIN signals).

## 5. Strategy grid and project-schema expressibility

196 variants = 8 single-exit + 110 multi-checkpoint + 6 close-all + 72 runner.

Allocations (checkpoint close %; TP index in brackets):
single: TP1, TP2, TP3, TP4 at 100%. Two-leg: (1)70/(2)30, (1)50/(2)50, (1)30/(2)70, (1)50/(3)50, (2)50/(3)50.
Three-leg: (1)50/(2)30/(3)20, (1)40/(2)30/(3)30, (1)33/(2)33/(3)34, (1)20/(2)30/(3)50. Four-leg: 25 each.
Close-all: 33/33/34 with close-all at TP2 (33/67); 25 x4 with close-all at TP3 (25/25/50).

Stop-management codes (applied where the referenced checkpoint exists and a position remains open after it):
- M0 original SL. M1 SL to entry, buffer 0, after TP1. M2 SL to entry, buffer 0.3, after TP1.
- M3 SL to entry, buffer 0, after TP2. M4 SL to previous TP, buffer 0, after TP2.
- M5 break-even at +4.0 USD price distance, buffer 0 (fixed-USD proxy, see Deviation 1).
- T1_d / T2_d trailing activated after TP1 / TP2, distance d in {1.5, 2.5, 4.0, 6.0} USD, step 0.5.

Runners (72): runner share r in {10, 20, 30, 40}% of initial volume with no TP cap; remaining share split equally over
(TP1, TP2) "RUN2" or (TP1, TP2, TP3) "RUN3"; each with no-trail management (SL to entry after TP1 and to previous TP
after later TPs) or trailing after TP1 or TP2 with the four distances.

Expressibility against the execution profile (docs/project_memory/OPTIMAL_REPORT_SCHEMA.md; worker/src/lib/executionProfile.ts):

| Feature | Schema | Status |
|---|---|---|
| entry policy, market_tolerance_price, pending_expiry_minutes | 3.4 | expressible (E1 tol 2.0 is allowed; the schema example uses 0.5) |
| stop distance min/max (2.0 / 25.0) | 3.7 | expressible; enforced by validateStopLoss |
| take_profit.checkpoints (sum 100, ascending) | 3.6 | expressible: all single, multi and close-all variants |
| missing_tp, infeasible_split (merge/skip) | 3.6 | expressible; same merge rule as positionSizing.ts |
| after_checkpoint move_to entry / previous_tp + buffer | 3.7 | expressible: M1-M4 |
| break_even trigger price_distance | 3.8 | expressible: M5 at fixed 4.0 USD |
| break_even per trade in R | none | NOT expressible (price units only) |
| trailing activation after_tp_index, distance_price, step_price | 3.9 | expressible: T1/T2 (step quantisation is a close approximation, see Section 14) |
| close-all at checkpoint | derived | expressible as a shorter checkpoint list |
| runner (share with no TP cap) | none | NOT expressible: the final checkpoint always closes its target remaining volume (0) |
| max holding horizon 24 h, close before weekend | none | NOT expressible: no time-stop or weekend field |

Consequence: 124 schema-expressible variants (8 + 110 + 6), 72 runners not expressible. Horizon/weekend results are
descriptive only (Section 12). All five finalists are schema-expressible.

Schema-adjacent risks noticed while reading the code (not modelled here):
- `limits.max_spread_price` example is 0.5, but the median Dukascopy spread is 0.69. A gate at 0.5 would block most
  entries. Vantage spreads are unverified.
- `safety.max_deviation_points` default 30 points (about 0.30 USD if point = 0.01, unverified) bounds slippage. MID and PESS
  slip (0.05, 0.10) are inside this bound if the point convention holds.

## 6. TRAIN and VALIDATION results (in-sample, Simulated, MID)

Landscape by family (Simulated; each variant on its own defined fill set; `landscape.csv`):

| Entry | Family | Variants | Median of variant means | Best variant (mean R) | Share with positive mean | Fill-set n range |
|---|---|---|---|---|---|---|
| E1 | single | 8 | -0.10 | S_TP4\|M0 (+0.31) | 25% | 148-178 |
| E1 | multi | 110 | -0.12 | Q_25x4\|M0 (-0.04) | 0% | 178 |
| E1 | close-all | 6 | -0.12 | CA_Q25_at_TP3\|M0 (-0.10) | 0% | 178 |
| E1 | runner | 72 | -0.13 | RUN3_r40\|RUN_T2_4 (-0.09) | 0% | 178 |
| E2 | single | 8 | -0.12 | S_TP4\|M0 (+0.20) | 25% | 233-294 |
| E2 | multi | 110 | -0.15 | Q_25x4\|M3 (-0.07) | 0% | 294 |
| E2 | close-all | 6 | -0.14 | CA_Q25_at_TP3\|M0 (-0.12) | 0% | 294 |
| E2 | runner | 72 | -0.17 | RUN3_r40\|RUN_T1_4 (-0.13) | 0% | 294 |

Frozen benchmark and finalists, TRAIN and VALIDATION (Simulated, MID; n = determined trades; 95% bootstrap CI, 10,000, seed 42):

| Entry | Variant | TRAIN n | TRAIN mean R [CI] | VAL n | VAL mean R [CI] |
|---|---|---|---|---|---|
| E1 | S_TP4\|M0 | 100 | +0.41 [-0.21, +1.08] | 48 | +0.12 [-0.58, +0.92] |
| E1 | S_TP4\|M5 | 100 | +0.10 [-0.32, +0.59] | 48 | +0.23 [-0.33, +0.90] |
| E1 | Q_25x4\|M3 | 130 | -0.02 [-0.27, +0.25] | 48 | -0.14 [-0.53, +0.32] |
| E1 | Q_25x4\|M0 | 130 | -0.00 [-0.27, +0.28] | 48 | -0.14 [-0.54, +0.31] |
| E1 | S_TP3\|M0 | 130 | -0.10 [-0.42, +0.25] | 48 | -0.06 [-0.55, +0.49] |
| E1 | S_TP1\|M0 (benchmark) | 130 | -0.06 [-0.22, +0.09] | 48 | -0.24 [-0.48, +0.02] |
| E2 | S_TP4\|M0 | 159 | +0.35 [-0.18, +0.92] | 74 | -0.12 [-0.65, +0.49] |
| E2 | S_TP4\|M5 | 159 | +0.18 [-0.22, +0.64] | 74 | -0.08 [-0.44, +0.36] |
| E2 | Q_25x4\|M3 | 220 | -0.00 [-0.22, +0.24] | 74 | -0.26 [-0.57, +0.09] |
| E2 | Q_25x4\|M0 | 220 | -0.02 [-0.24, +0.23] | 74 | -0.25 [-0.56, +0.10] |
| E2 | S_TP3\|M0 | 220 | -0.03 [-0.31, +0.28] | 74 | -0.15 [-0.55, +0.30] |
| E2 | S_TP1\|M0 (benchmark) | 220 | -0.11 [-0.24, +0.02] | 74 | -0.27 [-0.49, -0.05] |

Drawdown and tail, TRAIN (Simulated, MID, closed-equity, R): S_TP1 E1 max DD 16.1R, block p95 26.0R; S_TP4 E1 22.3R,
block p95 37.3R; S_TP3 E1 32.2R, block p95 55.4R. E2: S_TP1 35.1R; S_TP4 35.7R; S_TP3 44.3R. Full table: `train_metrics.csv`.

**Selection bias warning.** TP4-only variants are evaluated only on signals that carry a TP4 (E1 TRAIN 100/130 = 77%,
E2 TRAIN 159/220 = 72%). Their means therefore describe a different signal population. The paired tests in Section 10
use the common subset to correct for this, but the population difference remains.

## 7. Freeze: finalists and rule (`finalists.json`)

Rule (fixed before OOS, written to the file):
- S1 (TRAIN): eligible if n >= 60 determined trades. Shortlist = top 12 by TRAIN mean R for E1, union top 12 for E2 (21 variants).
- S2 (TRAIN+VALIDATION): score = min over {E1, E2} of the pooled TRAIN+VALIDATION mean R, requiring n_VAL >= 20 for both.
  Finalists = top 5 by score. Benchmark = S_TP1|M0 (not a finalist).
- Trials: 196 variants x 2 optimised entries x 3 costs = 1,176 variant-entry-cost evaluations computed on TRAIN
  (Simulated; MID alone is used for ranking).

| Rank | Finalist | Score (min of E1/E2 pooled TV mean R) | E1 TRAIN n / mean | E1 VAL n / mean | E2 TRAIN n / mean | E2 VAL n / mean |
|---|---|---|---|---|---|---|
| 1 | S_TP4\|M0 | +0.197 | 100 / +0.41 | 48 / +0.12 | 159 / +0.35 | 74 / -0.12 |
| 2 | S_TP4\|M5 | +0.098 | 100 / +0.10 | 48 / +0.23 | 159 / +0.18 | 74 / -0.08 |
| 3 | Q_25x4\|M3 | -0.067 | 130 / -0.02 | 48 / -0.14 | 220 / -0.00 | 74 / -0.26 |
| 4 | Q_25x4\|M0 | -0.074 | 130 / -0.00 | 48 / -0.14 | 220 / -0.02 | 74 / -0.25 |
| 5 | S_TP3\|M0 | -0.086 | 130 / -0.10 | 48 / -0.06 | 220 / -0.03 | 74 / -0.15 |

Only the top two have a positive pooled score. Three of the five (Q_25x4|M0, Q_25x4|M3 and S_TP3|M0) have negative TRAIN and
VALIDATION means under both entries. The rule selects the best five from the shortlist; it does not impose a positive threshold.

Pre-registered before OOS (in `finalists.json`):
- H1: SELL trades have higher mean R than BUY trades under the top finalist (E1, MID), positive sign in TRAIN, VALIDATION and OOS.
- H2: high-ER trending regime (top TRAIN tercile) has higher mean R than low-ER ranging regime (bottom tercile) under the top finalist (E1, MID).

## 8. Out-of-sample results (one-time evaluation, Simulated, n = determined trades)

**8.1 Frozen family, MID, OOS (n=81 clean signals).**

| Entry | Variant | n | Mean R [95% CI] | Win ex-BE | BE rate | PF | Closed DD R | Block p95 DD R | Block p99 DD R | Loss streak p95 | Drop top-5 winners, mean R |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E1 | S_TP4\|M0 | 33 | +0.19 [-0.63, +1.13] | 0.18 | 0.00 | 1.22 | 16.1 | 25.7 | 30.1 | 23 | -0.85 |
| E1 | S_TP4\|M5 | 33 | +0.19 [-0.38, +0.90] | 0.21 | 0.58 | 1.55 | 5.3 | 11.7 | 12.9 | 2 | -0.42 |
| E1 | Q_25x4\|M0 | 37 | +0.14 [-0.32, +0.63] | 0.34 | 0.05 | 1.26 | 8.1 | 12.1 | 15.1 | 9 | -0.33 |
| E1 | Q_25x4\|M3 | 37 | +0.07 [-0.34, +0.51] | 0.38 | 0.00 | 1.13 | 7.0 | 12.2 | 14.9 | 10 | -0.37 |
| E1 | S_TP3\|M0 | 36 | +0.18 [-0.44, +0.85] | 0.28 | 0.00 | 1.24 | 13.4 | 20.3 | 25.8 | 17 | -0.41 |
| E1 | S_TP1\|M0 (benchmark) | 37 | +0.07 [-0.22, +0.36] | 0.62 | 0.00 | 1.19 | 2.6 | 6.0 | 7.5 | 3 | -0.09 |
| E2 | S_TP4\|M0 | 68 | +0.21 [-0.47, +0.99] | 0.15 | 0.00 | 1.24 | 22.6 | 45.5 | 56.3 | 39 | -0.47 |
| E2 | S_TP4\|M5 | 68 | +0.20 [-0.33, +0.80] | 0.17 | 0.38 | 1.37 | 13.5 | 30.8 | 38.3 | 11 | -0.40 |
| E2 | Q_25x4\|M0 | 73 | +0.00 [-0.37, +0.42] | 0.26 | 0.01 | 1.01 | 16.3 | 32.6 | 40.0 | 18 | -0.32 |
| E2 | Q_25x4\|M3 | 73 | -0.07 [-0.41, +0.32] | 0.27 | 0.00 | 0.89 | 17.7 | 33.5 | 40.9 | 19 | -0.39 |
| E2 | S_TP3\|M0 | 72 | +0.01 [-0.47, +0.54] | 0.19 | 0.00 | 1.01 | 18.5 | 40.8 | 48.7 | 27 | -0.39 |
| E2 | S_TP1\|M0 (benchmark) | 73 | -0.10 [-0.33, +0.13] | 0.47 | 0.00 | 0.81 | 19.2 | 28.8 | 34.1 | 12 | -0.21 |

Definitions: WIN if total_R >= +0.10 R, LOSS if <= -0.10 R, BE otherwise. "Win ex-BE" = WIN/(WIN+LOSS). PF = gross
positive R / gross negative R. Closed DD in R (exit-time order) and in USD per 1.0 lot (contract 100 oz, UNVERIFIED).
Block p95/p99 DD: 10,000 resamples in blocks of 5 trades (exit order). Loss streak = consecutive LOSS trades.
Win ex-BE is 0.62 for the E1 benchmark and 0.18-0.38 for the other E1 variants. BE rates are large only for the M5 variants (38-58%).
MAE/MFE per trade (median MAE about -1.0 R for most variants, i.e. the stop is the typical adverse excursion).
Portfolio mark-to-market DD is not computed (per-trade MAE only). Exposure (median hours fill to last exit, OOS): benchmark
0.2 (E1) and 0.1 (E2); S_TP4 0.7 and 0.3; Q_25x4 0.6-0.7 and 0.4; S_TP3 0.7 and 0.3. The 90th percentile is about 5 h for S_TP4 (E1).

**8.2 Cost sensitivity, OOS (Simulated).** Means change with cost mainly through the fill set (n changes).

| Entry | Cost | S_TP4\|M0 mean [CI] (n) | S_TP4\|M5 mean [CI] (n) | S_TP1\|M0 benchmark mean [CI] (n) |
|---|---|---|---|---|
| E1 | BASE | +0.10 [-0.65, +0.99] (36) | +0.09 [-0.44, +0.77] (36) | +0.01 [-0.27, +0.27] (39) |
| E1 | MID | +0.19 [-0.63, +1.13] (33) | +0.19 [-0.38, +0.90] (33) | +0.07 [-0.22, +0.36] (37) |
| E1 | PESS | +0.30 [-0.58, +1.33] (30) | +0.30 [-0.37, +1.12] (30) | -0.05 [-0.37, +0.26] (33) |
| E2 | BASE | +0.23 [-0.46, +1.01] (68) | +0.21 [-0.32, +0.83] (68) | -0.10 [-0.33, +0.13] (73) |
| E2 | MID | +0.21 [-0.47, +0.99] (68) | +0.20 [-0.33, +0.80] (68) | -0.10 [-0.33, +0.13] (73) |
| E2 | PESS | +0.18 [-0.50, +0.95] (68) | +0.17 [-0.34, +0.77] (68) | -0.15 [-0.37, +0.09] (73) |

**8.3 Paired comparison against the benchmark, OOS, MID (Simulated).** Paired bootstrap (10,000, seed 42) of per-signal
R differences on the common fill set; Holm correction across the five finalists within entry x cost (`oos_paired.csv`).

| Entry | Finalist | Common n | Mean diff vs TP1 [CI] | p (two-sided) | Holm p |
|---|---|---|---|---|---|
| E1 | S_TP4\|M0 | 33 | +0.08 [-0.72, +0.95] | 0.89 | 1.00 |
| E1 | S_TP4\|M5 | 33 | +0.08 [-0.43, +0.71] | 0.84 | 1.00 |
| E1 | Q_25x4\|M0 | 37 | +0.07 [-0.31, +0.46] | 0.75 | 1.00 |
| E1 | Q_25x4\|M3 | 37 | -0.01 [-0.36, +0.36] | 0.97 | 1.00 |
| E1 | S_TP3\|M0 | 36 | +0.11 [-0.46, +0.70] | 0.72 | 1.00 |
| E2 | S_TP4\|M0 | 68 | +0.33 [-0.29, +1.01] | 0.34 | 1.00 |
| E2 | S_TP4\|M5 | 68 | +0.32 [-0.14, +0.84] | 0.20 | 1.00 |
| E2 | Q_25x4\|M0 | 73 | +0.11 [-0.18, +0.42] | 0.48 | 1.00 |
| E2 | Q_25x4\|M3 | 73 | +0.03 [-0.23, +0.31] | 0.83 | 1.00 |
| E2 | S_TP3\|M0 | 72 | +0.12 [-0.31, +0.55] | 0.59 | 1.00 |

No finalist differs significantly from the benchmark OOS, under MID or under BASE and PESS (all Holm p >= 0.74, `oos_paired.csv`). Point differences favour TP4 variants in both entries.

**8.4 Multiplicity.** Reality Check (White 2000, block bootstrap of signals, 10,000 resamples), TRAIN+VALIDATION, MID
(in-sample, exploratory, Simulated):
- Vs TP1 benchmark, all variants with full support (193 variants, E1 n=178; E2 n=294): best mean difference
  +0.07 R (E1), p = 0.50; +0.09 R (E2), p = 0.30.
- Vs zero, TP4-present full-support subset (196 variants, E1 n=148; E2 n=233): best S_TP4|M0 +0.31 R, p = 0.11 (E1);
  +0.20 R, p = 0.22 (E2). Vs TP1 on the same subset: p = 0.03 (E1), 0.04 (E2) (`rc_tp4_support.json`).
- Interpretation: the best of 196 variants does not beat zero after multiplicity; it does beat TP1 in-sample. That
  in-sample TP1 advantage was not confirmed OOS (Section 8.3).

## 9. Walk-forward (robustness check, Simulated, MID)

Each test month (2026-01 to 2026-09, by signal time): choose the family member (5 finalists + benchmark) with the highest
mean R over the previous <= 3 calendar months (min 5 trades; else benchmark); realise its R in the test month (`walkforward.csv`).

| Entry | Test months | Test trades | Sum R | Mean R | Fixed S_TP4\|M0 mean (n) | Fixed benchmark mean (n) |
|---|---|---|---|---|---|---|
| E1 | 9 | 194 | +35.3 | +0.18 | +0.29 (181) | -0.09 (198) |
| E2 | 9 | 325 | +29.9 | +0.09 | +0.20 (301) | -0.16 (330) |

Caveats (important): the test months are not out of sample. Jan to 2 Jun 2026 are inside TRAIN, 3 Jun to 17 Aug inside
VALIDATION, and only 17 Aug to 27 Sep is OOS; those OOS signals were re-used here after the one-time OOS evaluation. The adaptive rule picks
S_TP4 variants most months. Monthly signs are mixed: E1 negative in Jan, Feb, Mar and Sep (-5.0, -11.9, -7.3, -7.3 R);
E2 negative in Jan, Feb, Mar, Jul and Aug. Month sizes are 12-53 trades. This is a robustness picture, not evidence.

## 10. Explicit answers to the brief

**Does taking TP1 sacrifice too much?** In-sample, yes relative to later TPs, but not in a way that is confirmed.
On the TP4-present subset (TRAIN+VAL, MID): 100% TP1 averages -0.12 R (E1, n=148) and -0.19 R (E2, n=233); 100% TP2 -0.05 and
-0.18; 100% TP3 +0.02 and -0.01; 100% TP4 +0.31 and +0.20. Paired TP4 minus TP1: +0.44 R (CI [-0.01, +0.91], p = 0.054, E1);
+0.38 R (CI [+0.02, +0.77], p = 0.04, E2). Those are in-sample (exploratory). OOS, TP4 minus TP1 is +0.08 R (E1, n=33) and +0.33 R
(E2, n=68), neither significant (Section 8.3). TP1 has the highest win rate (ex-BE 0.62 OOS, E1) and the lowest exposure.

**Does waiting for later TPs add disproportionate drawdown?** Yes. OOS MID, E1: block p95 DD 6.0 R (TP1), 20.3 R (TP3),
25.7 R (TP4); loss-streak p95 3, 17, 23. E2: block p95 DD 28.8 R, 40.8 R, 45.5 R; streak p95 12, 27, 39. Median exposure rises from
0.2 h to 0.7 h (E1). The mean-R gain (about +0.1 R, not significant) comes with about 4x the p95 drawdown under E1 (6.0 R to 25.7 R)
and about 1.6x under E2 (28.8 R to 45.5 R). The drawdown ranking is the reverse of the win-rate ranking.

**Do runners improve expectancy, and which share, trigger and trailing?** No (in-sample, Simulated, TRAIN+VAL MID):
- Every runner variant has a negative mean under both entries. By share (10/20/30/40%), the median of variant means
  is -0.12 to -0.13 (E1) and -0.16 to -0.17 (E2): share makes no difference.
- By trigger: trailing after TP2 median -0.11 (E1) and -0.17 (E2); after TP1 -0.13 and -0.15; no-trail -0.16 and -0.18.
- By trailing distance (USD): 1.5 / 2.5 / 4.0 / 6.0 gives medians -0.12 / -0.12 / -0.13 / -0.14 (E1) and -0.17 / -0.16 / -0.15 / -0.17 (E2).
- Best runner: RUN3 40% with trailing after TP2, distance 4.0 (E1, mean -0.09, n=178); RUN3 40% trailing after TP1 at 4.0 (E2, -0.13, n=294).
- Runners are not schema-expressible anyway (Section 5).

**Is the no-runner option statistically superior?** Partly. The best schema-expressible variant beats the best runner
in-sample: paired difference -0.33 R (CI [-0.75, +0.05], E1, n=148) and -0.36 R (CI [-0.73, -0.00], E2, n=233). The E2 CI
excludes zero, but the comparison is in-sample, not multiplicity-adjusted, and the runner was picked as the best of 72.
Runners were not tested OOS (not frozen).

**Break-even and trailing.** M5 (BE at 4.0 USD) lowers OOS drawdown (E1 DD 5.3 R vs 16.1 R for S_TP4 without BE; E2 13.5 vs 22.6)
and produces 38-58% BE exits, but its mean R is similar (+0.19 vs +0.19; +0.20 vs +0.21). In-sample the drawdown effect is mixed
(E1 TRAIN 23.0 vs 22.3; E1 VAL 6.2 vs 9.2). A post-hoc 6.0 USD (about 1R) BE on TRAIN+VAL gives no consistent improvement (Section 12).
No trailing variant entered the 21-variant shortlist or the finalist set. I did not run a separate trailing-vs-non-trailing paired test.

**Horizon and weekend.** Not schema-expressible; descriptive only (Section 12). A 24 h cap removes late TP4 hits and reduces
the in-sample TP4 mean (E1 TRAIN 0.41 -> 0.23 R; E1 VAL 0.12 -> -0.04 R). OOS trades do not reach 24 h in the benchmark or
the TP4 variants, so OOS is unchanged.

**Trending vs ranging (regime, ex-ante).** Pre-registered H1 and H2 tests under the top finalist (S_TP4|M0, E1, MID):

| Hypothesis | TRAIN diff [CI] (n) | VALIDATION diff [CI] (n) | OOS diff [CI] (n) | Result |
|---|---|---|---|---|
| H1 SELL minus BUY | +0.17 [-1.33, +1.50] (65 vs 35) | -0.72 [-2.17, +0.70] (23 vs 25) | +1.05 [-0.69, +2.70] (20 vs 13) | Fails (sign not consistent) |
| H2 trend minus range | +0.65 [-0.89, +2.44] (25 vs 41) | -0.46 [-2.01, +1.14] (13 vs 14) | +0.28 [-2.98, +3.11] (9 vs 6) | Fails (sign not consistent; n tiny) |

Post-hoc (not pre-registered for E2, not a filter): H1 under E2 has a positive sign in all three splits (TRAIN +0.28 n=96/63,
VALIDATION +0.36 n=39/35, OOS +1.80 CI [+0.86, +2.89] n=47/21). Only the OOS CI excludes zero, and the pre-registered test
was the E1 version, which failed. I make no recommendation from this (Section 11 rules).

**BUY vs SELL, session and weekday (descriptive only, top finalist, MID).**
- Direction: E1 TRAIN BUY +0.30 (n=35) / SELL +0.46 (n=65); VALIDATION BUY +0.46 (n=25) / SELL -0.26 (n=23); OOS BUY -0.45 (n=13) / SELL +0.60 (n=20).
  E2 TRAIN BUY +0.18 (n=63) / SELL +0.46 (n=96); VALIDATION BUY -0.31 (n=35) / SELL +0.04 (n=39); OOS BUY -1.04 (n=21) / SELL +0.77 (n=47).
- Session (UTC, signal time), E1: NY-overlap 12-17 +1.30 (TRAIN, n=31), +0.01 (VAL, n=22), -0.35 (OOS, n=10); London 07-12 -0.02 (TRAIN, n=64),
  -0.28 (VAL, n=17), -0.08 (OOS, n=7); Asia 00-07 +0.38 (n=5), +1.33 (n=6), +0.75 (n=15). Sign and size change across splits.
- Weekday, E1: Wed +1.53 (TRAIN, n=13), -1.03 (VAL, n=9), -1.04 (OOS, n=6); Thu -0.66 (TRAIN, n=23), +0.09 (VAL, n=11), +0.75 (OOS, n=8).
  Weekday effects flip sign between splits with n <= 25 per cell. Descriptive only.

## 11. Filters

No filter is recommended. The only tested hypotheses are H1 and H2 (Section 10). Both failed, and the post-hoc E2 direction
result is not a pre-registered hypothesis.

## 12. Sensitivities (descriptive; none used for selection)

- **ALL universe** (9 hard-flagged signals, all in TRAIN, `flagged_sensitivity.csv`): 2-5 determined trades per group. Not material.
- **Horizon** (72 h baseline; 24 h; close before Friday 20:45 UTC, `horizon_sensitivity.csv`; run after OOS, E1 and E2, MID, clean signals):
  S_TP4|M0 TRAIN E1 0.41 (72 h) -> 0.23 (24 h) -> 0.22 (weekend); VAL E1 0.12 -> -0.04 -> -0.02; TRAIN E2 0.35 -> 0.25 -> 0.24; VAL E2 -0.12 -> -0.24 -> -0.23.
  OOS identical across horizons (no OOS trade reaches the cap for the finalists). Benchmark unchanged; Q_25x4 changes by 0.02-0.04 R in-sample.
  Not schema-expressible.
- **Break-even at about 1R** (6.0 USD, post-hoc, TRAIN+VAL only, `be_1r_check.csv`): S_TP4|M0 E1 TRAIN 0.41 (none) / 0.10 (4.0 USD) /
  0.24 (6.0 USD); VAL 0.12 / 0.23 / 0.08. E2 TRAIN 0.35 / 0.18 / 0.34; VAL -0.12 / -0.08 / -0.29. No consistent improvement.
- **Cost** (Section 8.2): sign of the S_TP4 mean is unchanged from BASE to PESS in OOS for both entries, but the fill sets differ.
- **E1 guard**: 22% of in-range E1 fills at BASE are removed by the 1.5x nominal guard (38 of 171, TRAIN; Section 4).

## 13. Profile labels (descriptive; not sizing)

The three profiles are used only to label drawdown and exposure. No finalist shows a positive-expectancy case that survives
OOS, so none is recommended for live use on this evidence.

| Profile (label only) | Best-fitting candidate | OOS MID evidence | Why this label |
|---|---|---|---|
| Conservative (lowest DD and exposure) | S_TP4\|M5 among finalists (benchmark S_TP1\|M0 has lower DD but no edge) | E1 mean +0.19 (n=33), DD 5.3 R, block p95 11.7 R, 58% BE exits; E2 mean +0.20 (n=68), DD 13.5 R | Lowest finalist DD and shortest loss streaks; mean not distinguishable from zero |
| Balanced | Q_25x4\|M0 | E1 mean +0.14 (n=37), DD 8.1 R; E2 mean +0.00 (n=73), DD 16.3 R | Middle drawdown and exposure; expectancy near zero in E2 |
| Aggressive (highest variance) | S_TP4\|M0, S_TP3\|M0 | E1 S_TP4 mean +0.19, DD 16.1 R, streak p95 23; E2 S_TP4 mean +0.21, DD 22.6 R, streak p95 39 | Largest tail; OOS CI spans zero |

Q_25x4|M3 and S_TP3|M0 do not fit a profile cleanly (negative TRAIN and VALIDATION means in one or both entries).

## 14. Limitations and items not verified

- **Not Vantage.** Dukascopy ticks are the only price source. Vantage spreads, latency, fill semantics and contract size are
  unverified. Contract size 100 oz per lot (`usd_per_1lot`) is UNVERIFIED.
- **Pending-order model.** Fill at the limit when Ask (BUY) or Bid (SELL) touches it, no queue priority, no partial fills.
  Adverse slippage applied to pending and market entries and to stop exits, not to TP legs.
- **Trailing approximation.** The engine quantises the trail above the activation stop in step increments; the schema moves
  the stop to best - distance whenever the improvement is at least step_price. These differ by at most one step in the stop level.
- **Break-even proxy.** M5 is 4.0 USD (about 0.6-0.7R), not 1R (Deviation 1).
- **No portfolio effects.** Each signal is an independent trade. No max_concurrent_positions, no overlap effects, no
  mark-to-market portfolio DD (per-trade MAE only), no swap, no commission.
- **Signal-set bias.** TP4-only variants use only signals with a TP4 (72-77% of fills).
- **Sample size.** OOS n is 30-73 per cell. CIs are wide (about +/-0.4 to +/-1.0 R). Results are not precise.
- **Regime features** missing for 22 of 415 signals (weekend or insufficient coverage). Unknown-regime rows are excluded.
- **Walk-forward and horizon checks used OOS signals after the one-time OOS evaluation** (Section 9 and 12).
- **Spread gate.** The schema example max_spread_price 0.5 is below the median Dukascopy spread (0.69). Not modelled.
- **Latency and first tick.** The first tick at or after signal time + cost latency is used. Checked on B2 trade rows:
  315,726 rows (TRAIN, VALIDATION, OOS, flagged) have fill >= signal + latency and exit >= fill, 0 violations
  (`b2_check_lookahead.py`). B1's run_analysis asserts the same for its rows (not re-run here).

## 15. Files

Directory: `scratchpad/b2/` (scripts, out/, README.md, REPORT.md, sim_engine_b2.py, sim_engine_b2.diff).

Key outputs (out/):
- `train_metrics.csv`, `val_metrics.csv`, `oos_metrics.csv`, `frozen_summary.csv` (all variant x entry x cost x split with CIs, block and iid tails, exposure).
- `train_fill_summary.csv`, `val_fill_summary.csv`, `oos_fill_summary.csv`.
- `finalists.json` (frozen, sha256 `907790184fd086998e07533102e1e6f8a332c55e5626ef52b0a4d60b63432235`).
- `oos_paired.csv`, `tv_paired.csv`, `analysis.json`, `landscape.csv`, `rc_tp4_support.json`, `extra.json`.
- `walkforward.csv`, `descriptive.csv`, `hypotheses.json`, `regime_features.csv`, `feasibility.csv`.
- `horizon_sensitivity.csv`, `flagged_sensitivity.csv`, `be_1r_check.csv`, `oos_evaluated.lock`.
- Trade-level: `phase1_trades.csv.gz`, `oos_trades.csv.gz`, `phase1_fills.csv`, `oos_fills.csv`.

Engine patch: `sim_engine_b2.py`, `sim_engine_b2.diff`; tests `test_b2_engine_patch.py`, `test_sim_engine_on_b2.py`.
Look-ahead check: `b2_check_lookahead.py`. Post-hoc BE check: `b2_be_1r_check.py`. RC on TP4 support: `b2_rc_tp4_support.py`.
Re-run order and dependencies: `README.md`.
