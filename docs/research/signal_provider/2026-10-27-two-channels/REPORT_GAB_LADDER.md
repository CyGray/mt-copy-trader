# GAB FX with the owner's ladder plan (2026-10-29)

**Short answer: the ladder does not rescue GAB FX.** The best version (stop widened by 80 pips, one to four
0.01 legs, a 30-pip trail) made about **+1.2 USD per signal per 0.01 lot** from May to October. That is
indistinguishable from zero. It made money in May to August and lost in September and October. When the trail
is picked on May to July and then tested on August to October, **every lot size loses**. Widening by 130 pips is
worse than widening by 80. Adding legs beyond four adds risk without adding profit.

Labels as in `REPORT_GAB_LIVE.md`: **Verified**, **Modeled**, **Inferred**, **Unknown**. Everything in sections
2 to 5 is **Modeled** (a price replay), not real fills.

## 1. The plan as tested

| Item | Rule |
|---|---|
| Signals | GAB FX gold signals from the live history (`REPORT_GAB_LIVE.md`). Main sample: GAB's own **May to Oct, 126 signals**. Earlier phases are shown separately. |
| Entry | Market, 20 s after the post (the next minute's open; buys on the ask, sells on the bid). A limit at the zone edge is shown as a check. |
| Stop | The posted stop moved **80 or 130 pips** further away. 1 pip = 0.10 USD, the channel's own unit, so the stop is 8 or 13 USD wider. The posted stop (0 pips) is shown for reference. |
| Legs | N legs of 0.01 lot, N = 1 to 6. Leg k (k < N) closes at **+100k pips** from the fill (+10, +20, ... USD). |
| Breakeven | When price first reaches **+100 pips**, every open leg's stop moves to the fill price. |
| Runner | The last leg trails D pips behind the best price, D = 30 to 1,000 pips, or no trail (breakeven stop only). The trail starts at +100 pips (**be**) or only after the last fixed leg has closed (**last**). |
| Time limit | 120 h (5 days); anything still open is closed at market. |
| Money | 0.01 lot of gold = 1 ounce, so 1 USD of price movement = 1 USD per leg. Results are in **USD per signal** for the whole N-leg set. |
| Costs | Dukascopy bid/ask, so the spread is included. Stress test: an extra **0.40 USD per leg**; the tick check below shows ticks run 0.2 to 0.5 USD per leg worse than 1-minute bars. |

Edits caveat (Inferred, unchanged from `REPORT_GAB_LIVE.md`): 124 of the 126 signals were edited after posting,
and the replay uses the final stop and direction. The plan ignores GAB's targets, but a stop moved after the fact
still flatters the result. Treat every figure here as a best case.

**Price model check (Verified).** The same engine was run on tick data for the 92 signals with a full 24 h of
ticks (they are all from February to April). With the same fill minute, **100% of legs had the same exit type**
on ticks and 1-minute bars (target, breakeven, trail or stop). The median P&L gap was 0.04 to 0.18 USD per leg.
Ticks were slightly worse, by 0.2 to 0.5 USD per leg, because stops fill past their level in fast markets. Three
assumptions about the order of prices inside a minute change the mean by at most 1 USD per signal.
(`analysis/aggregates/gab_ladder_tick_check.json`)

## 2. Results, May to October (126 signals, market entry, 30-pip trail from +100)

The 30-pip trail is the best trail for every lot size and both widenings (section 3).

| Stop widened by | Legs (lot) | Mean USD per signal | 95% range | Total over 126 | Profit factor | Worst signal | Largest drawdown |
|---|---|---|---|---|---|---|---|
| **80 pips** | 1 (0.01) | **+1.23** | −1.52 to +4.02 | +154 | 1.18 | −25 | 181 |
| | 2 (0.02) | +1.41 | −3.7 to +6.5 | +178 | 1.11 | −50 | 391 |
| | 3 (0.03) | +1.28 | −6.5 to +9.0 | +162 | 1.06 | −76 | 681 |
| | 4 (0.04) | +1.31 | −9.1 to +11.8 | +165 | 1.05 | −101 | 961 |
| | 5 (0.05) | +0.39 | −12.8 to +13.6 | +49 | 1.01 | −126 | 1,332 |
| | 6 (0.06) | −0.70 | −16.7 to +15.5 | −88 | 0.98 | −151 | 1,722 |
| **130 pips** | 1 (0.01) | +0.21 | −2.8 to +3.3 | +26 | 1.03 | −30 | 301 |
| | 2 (0.02) | −0.59 | −6.4 to +5.1 | −75 | 0.96 | −60 | 631 |
| | 3 (0.03) | −1.87 | −10.7 to +6.8 | −236 | 0.92 | −91 | 1,041 |
| | 4 (0.04) | −2.99 | −14.8 to +8.7 | −377 | 0.90 | −121 | 1,441 |
| | 5 (0.05) | −5.07 | −19.7 to +9.6 | −638 | 0.87 | −151 | 1,932 |
| | 6 (0.06) | −7.30 | −25.0 to +10.6 | −920 | 0.84 | −181 | 2,442 |
| Posted stop (reference) | 1 to 6 | −0.48 to −8.15 | all ranges include 0 | −61 to −1,027 | 0.79 to 0.92 | | |

- **With the 0.40 USD per leg cost stress**, 80 pips / 1 leg falls to +0.83 (−1.9 to +3.6). 80 pips / 4 legs
  falls to −0.29, and every 130-pip row is negative.
- **Limit entry at the zone edge** is worse: 80 pips / 1 leg +0.03, 130 pips / 1 leg −0.96.
- **Why widening helps a little.** The first rung (+100 pips) is reached before the stop by 51% of signals with
  the posted stop, 68% at +80 pips and 70% at +130 pips. Each loss also costs more: the median stop distance is
  12.9, 20.9 and 25.9 USD per leg. The step from 80 to 130 buys 2 points of hit rate for 5 USD more risk per leg.
- **Why more legs do not help.** Only 32% of signals reach +200 pips, 22% reach +300 and 11% reach +500. A signal
  that loses still loses on *every* leg, because all legs share the stop until +100. Legs 2 to 4 add almost
  nothing on average, and legs 5 and 6 lose money.

## 3. Best trail distance

Mean USD per signal, 80 pips wider, trail from +100 (**be**):

| Legs | 30 | 50 | 75 | 100 | 150 | 200 | 300 | 500 | 1,000 | no trail |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **+1.23** | +1.11 | +0.69 | +0.54 | −0.42 | −0.41 | −1.91 | −0.69 | −2.92 | −3.02 |
| 4 | **+1.31** | +1.19 | +0.77 | +0.63 | −0.33 | −0.32 | −1.83 | −0.60 | −2.83 | −2.93 |
| 6 | **−0.70** | −0.81 | −1.23 | −1.38 | −2.34 | −2.33 | −3.83 | −2.61 | −4.84 | −4.94 |

- **The tighter the trail, the better**, at every lot size and both widenings. A 30-pip trail starting at +100
  pips simply banks about +70 to +100 pips. GAB's moves rarely run far past the first rung, so a wide trail
  mostly hands the gain back down to breakeven.
- Starting the trail only after the last fixed leg (**last**) is worse than starting it at +100 for every lot size
  from 3 to 6 legs. For 1 or 2 legs the two rules are the same.
- **Answer: 30 pips (3 USD), starting at +100 pips.** That is effectively "take the runner at about +70 to +100
  pips". It is not a real trend-following trail. Smaller distances were not tested: at 30 pips the trail is
  already only about 10 spreads wide.

## 4. Does it hold up over time?

Mean USD per signal by month (80 pips, 30-pip trail):

| Legs | May | Jun | Jul | Aug | Sep | Oct | Total |
|---|---|---|---|---|---|---|---|
| 1 | +2.7 | +4.5 | +2.5 | +1.1 | **−3.4** | **−3.1** | +154 |
| 4 | +13.0 | +16.3 | +3.5 | +1.1 | **−23.2** | **−14.3** | +165 |
| 6 | +21.1 | +17.1 | +6.8 | −6.5 | **−37.0** | **−23.8** | −88 |

**Out-of-sample test.** For each widening and lot size, the trail rule was chosen on May to July (72 signals) and
then scored on August to October (54 signals). **All 12 combinations lose** on the later months:

| Widened | 1 leg | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| 80 pips, mean USD per signal | −1.35 | −3.70 | −8.93 | −12.51 | −15.01 | −20.51 |
| 130 pips | −3.38 | −7.77 | −15.04 | −18.58 | −25.19 | −32.73 |

The small profit in section 2 comes from May to July. GAB's signals have been getting worse since July
(`REPORT_GAB_LIVE.md` §4), and the ladder does not change that.

**Earlier phases** (1 leg, best trail; not GAB's current product):
- Feb to Mar "Uncle Din" (28 signals): −3.1 / −2.0 USD.
- Mar to Apr copied feed (131 signals): +13 to +17 USD, with no trail best. That came from holding a runner
  through gold's fall of about 600 USD in March 2026. It is a few trend trades, not signal skill, and the range
  includes zero.

## 5. Lot size

There is no lot size at which this is worth trading. If the owner still wants a **paper or demo test**, the least
bad setting is **80 pips wider, 1 leg (0.01), 30-pip trail from +100 with breakeven**:
- risk is about 21 USD per signal (median), worst 25 USD;
- the largest drawdown over the 126 signals was 181 USD.

2 to 4 legs gave the same mean per signal with 2 to 5 times the drawdown (up to 961 USD). 5 and 6 legs lost.
Size any test so that a drawdown of about 1,000 USD per 0.04 lot is affordable, and expect the
September–October results, which were negative.

## 6. Verdict

| Question | Answer | Label |
|---|---|---|
| Does widening the stop by 80 or 130 pips plus the 100-pip ladder make GAB profitable? | No. The best case is +1.2 USD per signal per 0.01 lot, range −1.5 to +4.0, and it loses out of sample | Modeled |
| 80 or 130 pips? | 80 is better at every lot size; 130 loses from 2 legs up | Modeled |
| Best trail | 30 pips, starting at +100 pips. Tighter is better throughout, so the runner is really a fixed take-profit | Modeled |
| Best lot size | 0.01 (1 leg). More legs add drawdown, not profit; 0.05 and 0.06 lose | Modeled |
| Trade it? | No. Same verdict as `REPORT_GAB_LIVE.md` | Modeled / Inferred |

## 7. Reproduce

```
analysis/gab/gab_ladder.py            replay engine (M1 three intrabar orders, market/limit entry; --ticks for the check)
analysis/gab/gab_ladder_report.py     tables, trail curve, month split, out-of-sample choice
analysis/gab/gab_ladder_validate.py   tick vs 1-minute agreement
analysis/aggregates/gab_ladder_m1_h120.json    all configurations, aggregates only (no per-trade rows)
analysis/aggregates/gab_ladder_tick_check.json
```

Run: `python3 -I gab_ladder.py m1`; `LADDER_HORIZON_H=24 python3 -I gab_ladder.py m1` (then rename the output to
`ladder_m1_h24.json`); `python3 -I gab_ladder.py ticks`; then the report and validate scripts. The inputs are the
scratch files `signals.json` and the Dukascopy M1/tick caches, which are not in git.
