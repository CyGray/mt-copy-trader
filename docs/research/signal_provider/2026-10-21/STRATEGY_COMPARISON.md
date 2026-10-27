# Strategy Comparison

Research only. Prices: Dukascopy XAUUSD ticks (not Vantage). All numbers are **Simulated** unless stated.
R = |fill - SL| (distance at the actual fill). USD figures assume a 100-oz contract (**unverified**).
Authors: Agent B2 (exits/runners), Agent B3 (risk), coordinator review. Audit status is in
`RESEARCH_VALIDATION.md`.

## 1. Protocol (chronological, no leakage)

- Universe: 406 clean signals sorted by time. **TRAIN** = first 244 (2025-10-30 .. 2026-06-02),
  **VALIDATION** = next 81 (2026-06-03 .. 2026-08-17), **OOS** = last 81 (2026-08-17 .. 2026-09-24).
- Exploration on TRAIN only. 196 strategy variants x 2 optimised entry models x 3 cost scenarios = 1,176
  evaluations were computed on TRAIN. Shortlist (top 12 per entry model by TRAIN mean R, 21 variants) was
  re-scored on TRAIN+VALIDATION; **5 finalists were frozen** before OOS (sha256 of `finalists.json`
  `907790184fd08...`, lock file proves a single OOS evaluation per frozen variant: 6 variants including the
  TP1 benchmark).
- Two hypotheses were pre-registered (SELL > BUY; trend > range). Both failed.
- After the one-time OOS evaluation OOS signals were re-used for three descriptive checks (walk-forward,
  horizon/weekend, hypotheses); these are flagged as not out-of-sample.
- Signals used for optimisation (TRAIN+VALIDATION): 325. Reserved for independent validation: 81.

### Entry models (never pooled)

- **E1** market within range +/-2.0 USD at the first tick after latency; skip if actual risk > 1.5x nominal.
- **E2** project `pending_at_range`: market inside range +/-0.5 USD, else limit at the unfavourable range
  edge valid 60 min (BUY_LIMIT fills on Ask, SELL_LIMIT on Bid).
- **E3** strict market, range +/-0.5 USD (report only; n ~ 10-53 per split).

Fills (clean, MID costs): E1 TRAIN 130 / VAL 48 / OOS 37; E2 220 / 74 / 73; E3 53 / 14 / 10.

## 2. Candidate families (196 variants)

Single exits at TP1-TP4; two-/three-/four-checkpoint splits (70/30, 50/50, 30/70, 50/30/20, 40/30/30,
33/33/34, 20/30/50, 25 x 4); close-all-at-checkpoint; 72 runner variants (10/20/30/40% of initial volume
with no TP, rest split over TP1-TP2 or TP1-TP3, trailing after TP1/TP2 at 1.5/2.5/4.0/6.0 USD or untrailed);
stop management M0 (original SL), M1/M2 (entry after TP1, buffer 0 / 0.3), M3 (entry after TP2), M4 (previous
TP after TP2), M5 (break-even once +4.0 USD in favour), trailing T1/T2.

**Schema fit.** 124 variants (single, multi, close-all) are expressible in the execution-profile schema. The
72 runner variants, the 24 h horizon and close-before-weekend are **not**: the final checkpoint always closes the
remaining volume (no runner primitive) and there is no time-stop field. Runner/time-stop results are
descriptive only and excluded from finalists.

## 3. In-sample results (TRAIN+VALIDATION, MID costs)

Median variant mean R by family (Simulated): single exits -0.10 (E1) / -0.12 (E2); **multi-checkpoint
-0.12 / -0.15 (0 of 110 positive)**; close-all -0.12 / -0.14 (0 of 6 positive); **runners -0.13 / -0.17 (0
of 72 positive)**. Only 2 single-exit variants (TP4 and part-TP3) have positive in-sample means.

| Entry | Frozen variant | TRAIN n / mean R | VAL n / mean R |
|---|---|---|---|
| E1 | S_TP4 (100% at TP4) | 100 / +0.41 | 48 / +0.12 |
| E1 | S_TP4 + BE@4.0 (M5) | 100 / +0.10 | 48 / +0.23 |
| E1 | Q_25x4 | 130 / -0.00 | 48 / -0.14 |
| E1 | S_TP3 | 130 / -0.10 | 48 / -0.06 |
| E1 | **S_TP1 benchmark** | 130 / -0.06 | 48 / -0.24 |
| E2 | S_TP4 | 159 / +0.35 | 74 / -0.12 |
| E2 | S_TP4 + BE@4.0 (M5) | 159 / +0.18 | 74 / -0.08 |
| E2 | Q_25x4 | 220 / -0.02 | 74 / -0.25 |
| E2 | S_TP3 | 220 / -0.03 | 74 / -0.15 |
| E2 | **S_TP1 benchmark** | 220 / -0.11 | 74 / -0.27 |

**Selection-bias warning:** TP4-only variants can only trade the 72-77% of signals that carry a TP4, so their
means describe a different population. Paired comparisons use the common subset.

## 4. Out-of-sample (81 signals; each frozen variant evaluated once; MID costs)

| Entry | Variant | n | Mean R [95% bootstrap CI] | PF | Closed DD (R) | Block-bootstrap p95 DD (R) | Mean R after dropping top 5 winners |
|---|---|---:|---|---:|---:|---:|---:|
| E1 | S_TP4 | 33 | +0.19 [-0.63, +1.13] | 1.22 | 16.1 | 25.7 | -0.85 |
| E1 | S_TP4 + BE@4 | 33 | +0.19 [-0.38, +0.90] | 1.55 | 5.3 | 11.7 | -0.42 |
| E1 | Q_25x4 | 37 | +0.14 [-0.32, +0.63] | 1.26 | 8.1 | 12.1 | -0.33 |
| E1 | S_TP3 | 36 | +0.18 [-0.44, +0.85] | 1.24 | 13.4 | 20.3 | -0.41 |
| E1 | S_TP1 (benchmark) | 37 | +0.07 [-0.22, +0.36] | 1.19 | 2.6 | 6.0 | -0.09 |
| E2 | S_TP4 | 68 | +0.21 [-0.47, +0.99] | 1.24 | 22.6 | 45.5 | -0.47 |
| E2 | S_TP4 + BE@4 | 68 | +0.20 [-0.33, +0.80] | 1.37 | 13.5 | 30.8 | -0.40 |
| E2 | Q_25x4 | 73 | +0.00 [-0.37, +0.42] | 1.01 | 16.3 | 32.6 | -0.32 |
| E2 | S_TP3 | 72 | +0.01 [-0.47, +0.54] | 1.01 | 18.5 | 40.8 | -0.39 |
| E2 | S_TP1 (benchmark) | 73 | -0.10 [-0.33, +0.13] | 0.81 | 19.2 | 28.8 | -0.21 |

(Q_25x4|M3 and cost-scenario breakdowns are in the B2 outputs.) **Every OOS confidence interval contains
zero.** Paired against TP1 on common fills: S_TP4 +0.08 R (E1, n = 33) and +0.33 R (E2, n = 68), Holm-adjusted
p = 1.0 everywhere. Under PESS costs the TP4 variants stayed positive (E1 +0.30 R n = 30; E2 +0.18 R n = 68)
and TP1 stayed ~0 / negative (E1 -0.05; E2 -0.15), still with CIs spanning zero.

### Multiplicity

White's Reality Check on the TP4-present subset (196 variants, TRAIN+VAL, MID): best vs **zero** p = 0.11 (E1)
and 0.22 (E2); best vs the TP1 benchmark p = 0.03 / 0.04 *in-sample only*, not confirmed OOS. Power
(Modeled from the OOS trade SDs, MID costs: single TP4 exit SD 2.6 R (E1, n = 33) and 3.05 R (E2, n = 68);
TP1 SD 0.89 R (E1) and 1.01 R (E2)): the minimum detectable mean (80% power, two-sided 5%, ~2.8 x SD/sqrt(n))
is about 1.3 R (E1) and 1.0 R (E2) for the TP4 exit, and about 0.3 R for TP1. The observed +0.2 R for TP4 is
roughly a fifth of the effect size this sample could detect, so "not significant" means "not testable at this
n", not "no edge". Conversely, TP4's high variance (SD ~3 R) is what produces its deep drawdowns.

## 4.1 Independent audit findings that change the reading of section 4 (Agent C2; coordinator re-check)

The auditor rebuilt the decoder and simulator independently and reproduced B2's fill counts and per-trade
results exactly (E1/E2/E3 fills for all splits and cost scenarios; 4,800 trade rows with 0 price/time/R
mismatches; bootstrap CIs to two decimals; freeze hash and lock order confirmed). It also found:

1. **Edit-timing bias (highest risk).** 411 of 415 signals were edited and only the final text is stored. Among
   the 406 clean signals, 104 (25%) were edited more than 300 s after posting; for 80% of these TP1 had already
   been touched *before* the final edit. Strategy results split sharply by this variable (MID costs, entry E2;
   the coordinator reproduced the numbers from B2's trade files, n = filled trades over TRAIN+VAL+OOS):

   | Strategy | Edited > 300 s after posting | Edited <= 300 s |
   |---|---|---|
   | 100% TP1 | +0.42 R (n = 83) | **-0.31 R (n = 283)** |
   | 100% TP4 | +1.44 R (n = 76) | **-0.22 R (n = 225)** |
   | TP4 + BE@4.0 | +1.22 R (n = 76) | **-0.25 R (n = 225)** |

   Entry E1 shows the same pattern (TP1 +0.40 / -0.23; TP4 +1.54 / -0.15). The auditor found it in TRAIN,
   VALIDATION and OOS alike. OOS single-TP4 excluding late-edited signals: -0.68 R (n = 46, 95% CI
   [-1.04, -0.15]). **Interpretation (Inferred, exploratory, post hoc):** late edits are concentrated in
   trades that had already worked, and may embed hindsight (levels or text revised after the fact), so the
   favourable subset cannot be shown to be tradable in real time; the text-stable majority, whose levels are most
   likely the ones traders saw, loses money net of costs. The mechanism cannot be proven because original
   texts are unrecoverable. The strategies' positive full-sample means are therefore **not** evidence of an edge.
2. **The 16% strict-fill rate is a definition.** If the entry may wait for the band instead of deciding at the
   first tick, 94-98% of signals fill (E3 BASE 389/415 within 60 min). The first-tick rule measures
   "executable at message arrival", not market impossibility.
3. **Positive means rest on few trades.** OOS E2 TP4: top 1 / 3 / 5 trades = 9.9 / 28.1 / 44.2 R of a 15.0 R total;
   median -1.02 R; win rate 15%; 5% trimmed mean -0.16 R. Power: ~1,900 trades would be needed to detect +0.2 R
   at SD 3.1.
4. **Timestamp sensitivity.** Shifting the entry search by -60 s (before the message existed; an upper bound) flips
   100% TP1 from -0.14 R to +0.08 R; +60 s is -0.15 R. Provider message time vs the "real" signal moment matters.
5. **Cost claim corrected.** Entry-only +1.0 USD adverse fill leaves OOS TP4 at +0.02 R (E2) and turns TP1 -0.24 R;
   only when stops also slip (+1.0 on entries and stops) does TP4 go to -0.11 R. "One extra USD turns everything negative"
   was overstated for the TP4 exit (it was already negative for TP1).
6. **Spikes.** 56-63% of >= 5 USD one-tick jumps (n = 687) revert within 60 s (38% of >= 10 USD); an
   (executable-unrealistic) persistence filter changes mean R by < 0.02 R but flips 16-35 individual trades.
7. **Process.** B2's ex-ante regime features were computed on OOS signals before the freeze (no outcomes used);
   B2 and the audit reused OOS after the lock (disclosed).
8. **Sizing audit.** The default per-trade cap is min(50 USD, 1% equity); at 5,000 USD 0.25% risk sizes to 0.02 lots
   (10 USD realised, 80% of target) and a 25% x 4 split (needs >= 0.04 lots, i.e. a fill-to-SL distance of at most
   3.1 USD at 5,000 USD equity) is exact for only ~3% of E2 fills (63% at 10,000 USD); the median E2 fill-to-SL
   distance is 6.0 USD, above the signal's nominal distance; `use_min_if_within_cap` tests
   the *safety* cap, so a forced minimum lot can risk 2-4x the requested percentage at 500-1,000 USD equity; the
   default spread cap 0.5 would block ~83% of E2 fills on the Dukascopy proxy.

## 5. Direct answers

**Does taking TP1 sacrifice too much?** In-sample, 100% TP1 is the weakest single exit on the TP4-present
subset (-0.12 R E1, -0.19 R E2 vs +0.31 / +0.20 R for TP4), but the advantage is **not confirmed OOS**
(+0.08 / +0.33 R, not significant). TP1 has the best hit rate (OOS win ex-BE 0.62 E1) and the shortest
exposure (median 0.1-0.2 h).

**Does waiting for later TPs add disproportionate drawdown?** Yes. OOS block-bootstrap p95 drawdown:
E1 6.0 R (TP1) -> 20.3 R (TP3) -> 25.7 R (TP4); E2 28.8 -> 40.8 -> 45.5 R. Loss-streak p95 3 -> 17 -> 23 (E1),
12 -> 27 -> 39 (E2). Roughly 4x (E1) and 1.6x (E2) the p95 drawdown for a mean-R gain that is not significant.

**Do runners help?** No. 0 of 72 runner variants had a positive TRAIN+VAL mean under either entry; share
(10-40%) made no difference (median -0.12/-0.13 E1); trailing trigger (TP1/TP2/none) and distance made no
material difference. Best no-runner beats best runner by 0.33 R (E1, CI [-0.75, +0.05]) / 0.36 R (E2, CI
[-0.73, -0.00]) in-sample (not multiplicity-adjusted). A no-runner configuration is therefore the more
defensible one - but statistical superiority is not established, and runners are not schema-executable.

**Break-even / trailing.** BE at +4.0 USD (about 0.6-0.7 R of the median 5.5-6.6 USD fill risk) cuts OOS drawdown
(E1 5.3 R vs 16.1 R; E2 13.5 vs 22.6 R) at similar mean R and produces 38-58% BE exits. A post-hoc BE at
6.0 USD shows no consistent improvement. No trailing variant entered the shortlist.

**Horizon.** Not schema-expressible. A 24 h cap lowers the in-sample TP4 mean (E1 TRAIN 0.41 -> 0.23);
OOS trades never reach 24 h.

**Which TPs / allocation / runner?** The data do not support a unique best configuration. The least-bad
schema-expressible family is **a single exit at TP4 with break-even at +4.0 USD** (or, for lower variance,
TP1), with **no runner** and no multi-checkpoint split; none is distinguishable from zero.

## 6. Execution-behaviour findings

- **BUY vs SELL**, sessions, weekdays, regime (ex-ante efficiency ratio terciles): descriptive only. Pre-registered
  H1 (SELL > BUY under the top finalist, E1) failed (signs: TRAIN +0.17, VAL -0.72, OOS +1.05; CIs span 0). A
  post-hoc E2 SELL > BUY pattern had positive signs in all splits, but was not pre-registered and is **not**
  recommended as a filter. H2 (trend > range) failed. **No filter is recommended.**
- **Market vs pending entry:** the choice of entry model changes fill rates from ~16% (strict) to 72% (E1) to
  ~90% (E2). Because provider levels lie on the favourable side of the market at posting, strict market
  entry skips most signals, E1 chases price and E2 enters at limit levels at the provider's range edge.
- **Latency:** 5 s vs 60 s changes fills (68 vs 93) but not the TP1-first rate on the signals filled at both (63.3% / 63.3%, n = 30).
- **Edited signals / cancels:** unrecoverable original text (see data audit); no cancellations exist in history.
- **Simultaneous signals:** if every clean signal were filled, p90 simultaneous positions is 5 (24 h hold) or
  10 (72 h hold), max 8 / 18; actual strict-entry fills overlap on only 3% of arrivals (Agent B3).
- **News volatility:** not separately analysed (no news calendar available); Dukascopy shows 749 one-tick jumps
  >= 5 USD, 60% reverting within 60 s - a false-stop/false-TP risk assessed by the auditor.

## 7. Position sizing and risk (Agent B3; Vantage specs **unverified**)

Account balance, currency, leverage, symbol name, contract size, tick value, lot limits, margin and
commission were not obtained (the MT5 bridge was deliberately not contacted; the Firestore settings were
unreadable). Everything below is conditional on placeholders: tick 0.01, tick value 1.0 USD/lot/tick (100 USD
per 1.00 move per lot), min/step 0.01, margin = 100 x price / leverage, equity scenarios 500 .. 50,000 USD.

- **Port verified:** the Python port of `positionSizing.ts` matches the compiled repo code on 6,000
  randomised cases (0 mismatches); repo `positionSizing.test.ts` passes 46 / 46.
- **Default safety binds first:** with `DEFAULT_SAFETY` (risk <= min(50 USD, 1% equity), 1 position per
  symbol, 3% total risk, 100 USD daily loss, spread 0.5, margin floor 200%), 2% and 1% risk behave
  identically and above 5,000 USD equity percent policies stop scaling (the 50 USD cap binds).
- **Small-account feasibility** (SL distances: median 5.0, p90 7.5, max clean 12.0 USD; n = 406): at 500 USD,
  1% risk is tradeable on 58.6% of signals, 0.5% on 3.9%, 0.25% on 0%; at 1,000 USD 99.5% / 58.6% / 3.9%;
  from 5,000 USD all of 0.25-1% are tradeable on 100%. Signals whose risk-based lot is below 0.01 are skipped,
  never up-sized (`below_min_volume: skip`).
- **Split feasibility:** a 3-checkpoint split is exact from 0.04 lots (25 x 4 and 3 + runner also 0.04; a
  30% runner variant 0.05). Minimum equity for exactness at the median 5 USD stop: 2,000 USD at 1% risk,
  4,000 at 0.5%, 8,000 at 0.25% (3,000 / 6,000 / 12,000 at the p90 stop). Single-TP exits are feasible at
  0.01 lots.
- **Realised risk exceeds sized risk:** market entries filled a median 0.875 USD (p90 1.37, max 1.97) farther
  from the stop than the signal's nominal distance; the (D+a)/D overshoot is 1.4x at D = 5 and 2.0x at D = 2.
- **Margin (leverage unverified):** at 1:100 one lot at 5,600 USD needs 5,600 USD; with the 200% floor a
  percent policy at 1% risk supports at most 4 simultaneous positions at 1:100 (22 at 1:500). Under default
  safety the one-per-symbol and total-risk gates bind before margin.
- **Drawdown, strict-entry EQ3 trades (n = 67), DEFAULT safety, 1% risk, 5,000 USD** (bootstrap 10,000
  resamples, seed 42): median max DD 10.3% (block-5) / 11.7% (iid); p95 19.5% / 22.1%; P(DD >= 20%) 4.3% /
  8.7%; P(DD >= 30%) < 0.3%. At 0.5% risk p99 is 12.9%; at 0.25% 6.4%. Longest observed loss streak 8; bootstrap
  p99 17.
- **Daily loss gate:** at 1% risk and 5,000 USD, the default 100 USD daily limit triggers on ~4.5% of day
  slots (95% of resamples contain at least one trigger); a 1%-of-equity limit on ~41%.
- **Cost sensitivity:** BASE modeled return at 1% risk and 5,000 USD is +3.6%; one extra USD of adverse fill
  on every trade -> -8.5% (max DD 13.7%); PESS -> -5.7%. Costs remove the (statistically insignificant) edge.
- **Best-looking exit in-sample** (E1/E2 S_TP4|M0, 5,000 USD, 1% risk): median iid-bootstrap max DD 21% / 29%,
  p95 42% / 53% - a positive in-sample mean does not protect against deep drawdown at 1% risk. At 0.5%: p95
  23% / 31%.
- **Sizing policies** (labelled, not recommendations; DEFAULT safety, below-min skip): Conservative 0.25%,
  Balanced 0.5%, Aggressive 1% of equity. At 5,000 USD their bootstrap p99 max DD are 6.4% / 12.9% / 24.3%.
  Below 1,000 USD, the Conservative policy leaves 96-100% of signals unsized.

The operator's approved risk ceilings override all of the above; they could not be read (Firestore).
Hard ceilings in code: 5% risk/trade, 20 lots, 20% total risk, 20,000 daily loss.

## 8. Limitations of this comparison

Dukascopy is not Vantage; 325 optimisation signals and 81 OOS signals (33-73 fills) give CIs of about +/-0.4
to +/-1.0 R; fills at different cost scenarios are different sets; no portfolio mark-to-market drawdown; no
swap/commission; TP4 results use a subset of signals; walk-forward test months are mostly in-sample;
original (pre-edit) signal levels unknown.
