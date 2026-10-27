# Signal Performance Report

All outcomes below are **reconstructed or simulated** from independent Dukascopy XAUUSD bid/ask ticks
(2025-10-30 .. 2026-09-27 UTC). No broker-confirmed execution exists. Dukascopy is not Vantage: spread,
commission, swap, fill quality and contract specification are unverified. Win rates / R-multiples describe
what *this feed* would have produced under the stated entry rule; they say nothing certain about Vantage or
the future.

Labels: **Observed** (in the signal file / ticks), **Reconstructed** (tick-level facts under the stated
entry rule), **Simulated** (strategy P&L under the stated model). Rates carry n and a Wilson 95% interval.
UNRESOLVED and NO_PRICE_DATA counts were 0 in every table (all 415 windows had complete tick coverage).

Universe: 415 accepted signals (406 "clean"; 9 flagged, see `SIGNAL_DATA_AUDIT.md` 4.3). Conventions:
BUY enters at Ask and exits at Bid, SELL the reverse; R = |fill - SL|; SL gaps fill at the tick price;
TP limits fill at the TP price; horizon 72 h from fill; contract size 100 oz (**unverified**). Costs:
BASE = latency 5 s, no extra spread/slippage; PESS = latency 15 s, +0.20 USD spread, 0.10 USD slippage.

## 1. The headline: entry feasibility dominates everything

The provider's posted entry range is usually **not executable at market** when the message is posted.

| Entry rule (Reconstructed, n = 415 signals) | Fills | Fill rate [95% CI] |
|---|---:|---|
| Strict market: first tick after 5 s inside range +/-0.5 USD (E3) | 68 | 16.4% [13.1, 20.3] |
| Same, range +/-0.0 USD | 25 | 6.0% [4.1, 8.7] |
| Market within range +/-2.0 USD (E1) | 299 | 72.0% [67.5, 76.1] |
| Strict, latency 60 s | 93 | 22.4% [18.7, 26.7] |
| Project `pending_at_range`: market inside +/-0.5 else limit at range edge, 60 min (E2, **corrected**) | ~90% (clean: 224/244, 74/81, 73/81 per split) | - |
| Idealised mid at message time (non-executable, diagnostic) | 415 | 100% |

Of the 347 strict-entry skips, 344 (99%) lie on the unfavourable side of the range (median distance
0.94 USD). Provider levels sit on the *favourable* side of the market at posting in **both** directions
(BUY entry median 1.95 USD below the Dukascopy mid, SELL 1.84 USD above; Verified, n = 167 / 248), which a
feed offset cannot produce - they behave like limit levels or were stale at posting. Consequence: of 154
unambiguous provider "TP hit" claims, 132 refer to signals that could not be entered inside the posted
range under strict entry (98 of 117 signals carrying such a claim).

> The B1 report's pending-order figures (a 49% fill rate and the `P2` strategy rows) came from an engine
> defect (SELL limits never filled; BUY limits triggered on Bid). They are **withdrawn**; the corrected
> fill rate is ~90% (Agent B2 patch, cross-checked). Market-entry results were unaffected (identical on the
> patched copy, 67 / 67 trades).

## 2. Baseline outcomes (strict entry E3, no management; Reconstructed, n = 68 fills / 67 clean)

| Event (original SL, all TPs held) | n | Frequency [95% CI] |
|---|---:|---|
| TP1 touched within 72 h | 68 | 92.6% [83.9, 96.8] |
| TP1 **before** SL | 68 | 55.9% [44.1, 67.1] |
| TP2 before SL | 68 | 30.9% [21.2, 42.6] |
| TP3 before SL | 67 | 22.4% [14.1, 33.7] |
| TP4 before SL | 51 | 19.6% [11.0, 32.5] |
| SL before any TP | 68 | 44.1% [32.9, 55.9] |
| P(TP2 before SL \| TP1 first) | 38 | 55.3% [39.7, 69.9] |
| P(TP3 before SL \| TP2 first) | 20 | 75.0% [53.1, 88.8] |

Win-rate depends sharply on the definition: TP1-before-SL 55.9%, TP2-before-SL 30.9%, last-TP-before-SL
16.2% (68 fills). The provider's visible stream is dominated by "TP1 hit" posts (276 of 526 TP posts are TP1)
and almost never reports an SL hit, so its stream says little about the true loss rate.

Same-tick SL/TP ambiguity: 0 trades (geometry cannot produce it for one position on a bid/ask feed).

### 2.1 Strategy results at strict entry (Simulated, BASE, n = 68; PESS n = 75)

| Strategy (original SL unless noted) | Avg R [95% CI] BASE | PF | Max closed DD (R) | Longest loss streak | Avg R PESS |
|---|---|---:|---:|---:|---|
| 100% TP1 | +0.046 [-0.19, +0.28] | 1.10 | 3.99 | 3 | -0.179 [-0.41, +0.05] |
| 100% TP2 | +0.009 [-0.38, +0.40] | 1.01 | 8.55 | 8 | -0.138 |
| 100% TP3 | +0.056 [-0.44, +0.56] | 1.07 | 11.31 | 10 | +0.032 |
| Equal thirds TP1/TP2/TP3 | +0.045 [-0.28, +0.37] | 1.08 | 7.81 | 8 | -0.095 |
| 50/50 TP1+TP2, SL->entry after TP1 | +0.003 [-0.24, +0.25] | 1.01 | 6.58 | 3 | -0.147 |
| Equal thirds, SL->entry after TP1 | -0.008 [-0.27, +0.26] | 0.98 | 8.75 | 3 | -0.097 |

Every interval contains zero. With n = 68 the sample cannot distinguish +0.05 R from -0.2 R; the PESS rows
show that modest extra spread, slippage and latency move the mean as much as any exit choice does.
Expectancy per trade after costs (this feed): about +0.05 R before extra costs and about -0.18 R with the
pessimistic cost set (100% TP1). Max closed drawdown for the 100% TP1 baseline: 3.99 R (USD 2,162 per 1.0
lot, contract 100 oz unverified).

### 2.2 Which entry is used changes the story (Simulated, MID cost, clean signals; Agent B2)

See `STRATEGY_COMPARISON.md`. In brief: single exits at TP1 average -0.06 to -0.27 R across train and
validation under the optimised entry models; the single-TP4 exit looks best in-sample but is not
distinguishable from zero out of sample.

## 3. Stability and breakdowns (strict entry, TP1-before-SL win rate; descriptive, n small)

Cells below have n of 1-34 fills; none is corrected for multiple comparisons; nothing here supports a filter.

- **Direction:** BUY 43.5% (n = 23, avg R TP1 -0.18) vs SELL 62.2% (n = 45, +0.16) - but the sign flips
  between periods under other entry models (Agent B2: pre-registered SELL > BUY test failed).
- **UTC session (signal time):** Asia 66.7% (9), London 52.9% (34), NY overlap 58.3% (24), Late 0 / 1.
- **Weekday:** Tue 66.7% (18) ... Thu 43.8% (16); all CIs wide.
- **Month:** from 25% (Apr 2026, n = 4) to 100% (Jun 2026, n = 5); n per month 2-16.
- **SL distance tercile:** <= 4.0 USD 43.5% (23); <= 5.3 USD 56.5% (23); > 5.3 USD 68.2% (22).
- **Overlap:** a signal arriving while an earlier filled signal was still open won TP1-before-SL 30.0% (n = 10) vs
  60.3% when none was open (n = 58) - small n, suggestive of correlated clustering only.
- **Late entry (60 s vs 5 s):** 30 signals filled at both; median fill difference 0.47 USD; TP1-before-SL 63.3%
  at both.
- Excluding the 9 flagged signals changes nothing material (TP1-first 55.2% vs 55.9%).

## 4. Trade-by-trade risk statistics (strict entry; Simulated)

- Closed-equity max drawdown (BASE, 1 lot per trade): 100% TP1 3.99 R; equal thirds 7.81 R; 100% TP3 11.31 R.
- Loss streaks (100% TP1, 68 trades): lengths 1x17, 2x2, 3x3. Equal thirds: longest 8.
- Mark-to-market drawdown was not computed (per-trade MAE/MFE only); median MAE of the strategies is about
  -1.0 R, i.e. the stop is the typical adverse excursion.
- Bootstrap tails over exit-ordered trades (Agent B2, optimised entries): see `STRATEGY_COMPARISON.md`.

## 5. Agreement with the provider's own claims (Observed claims vs Reconstructed ticks)

Only unambiguous links (reply or exactly one candidate): 154 TP-hit claims with a TP index. 132 attach to
signals not enterable under strict entry. On the 22 entered signals: 17 supported (77.3% [56.6, 89.9]), 3
SL-first, 2 not touched within 72 h; supported claims appear a median 1.5 min after our first touch. 2 break-even
claims and 1 loss claim agree with the ticks. A3's looser range-touch demo on 19 entered sample trades matched
16 of 21 TP claims within 10 minutes. Provider posts are therefore *timing-consistent where a trade is
enterable*, but the claims are a biased sample (losses rarely reported).

## 6. Consistency over time / recent vs historical

Only 11 months of data and, under strict entry, 2-16 fills per month, so period consistency cannot be
established. Monthly TP1-before-SL ranges from 25% to 100%. The provider's behaviour changed during the
sample (signal frequency up 20x, SL distance and TP count up; see `SIGNAL_DATA_AUDIT.md` 4.4). Recent
performance versus older performance after 2026-09-24 is **Unknown** (live data unavailable).

## 7. How much apparent profitability survives realistic execution?

- At strict entry only ~16% of signals are enterable, and for those the modeled mean R is statistically
  indistinguishable from zero before costs and negative under the pessimistic cost set.
- Costs matter more than exit choice: one extra USD of adverse fill on every trade turns modeled BASE results
  negative at every equity tested (Agent B3), and the tightest stops suffer most proportionally.
- Provider-posted "pips" are USD 0.10 per pip; posted pip totals are not comparable to R.

Conclusion for this report: **no profitable edge is established by this reconstruction.** Confidence and
out-of-sample treatment are in `STRATEGY_COMPARISON.md` and `OPTIMAL_REPORT.md`.
