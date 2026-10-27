## 1. Universe, quality flags and data coverage (Observed)

| universe | n | share |
|---|---|---|
| signals in accepted universe (A1) | 415 | 100% |
| clean (no hard flag) | 406 | 97.8% |
| excluded (hard flag) | 9 | 2.2% |

Excluded signals (kept in the ALL table, flagged):

| message_id | time (UTC) | hard flag(s) |
|---|---|---|
| 14 | 2025-10-30T11:38 | comma_decimal_truncated |
| 19 | 2025-10-30T11:39 | comma_decimal_truncated |
| 196 | 2025-11-14T14:20 | comma_decimal_truncated |
| 378 | 2025-12-08T15:35 | comma_decimal_truncated |
| 445 | 2025-12-24T15:34 | duplicate_of_442 |
| 512 | 2026-01-14T08:30 | sl_implausible_dist403.5 |
| 649 | 2026-02-05T08:25 | duplicate_tp_label_in_text |
| 1464 | 2026-04-15T08:04 | duplicate_of_1459 |
| 2141 | 2026-05-28T14:39 | tp4_implausible_400 |

Informational flags (no exclusion). lead_in = previous message in the chat is a direction-only post (heuristic, A1 counted ~94).

| info flag (kept in CLEAN) | n |
|---|---|
| edited_after_10min | 84 |
| lead_in_prev_header_post | 91 |

Tick coverage. Total ticks decoded: 83,641,720. First ok hour 2025-10-30T00:00:00Z, last ok hour 2026-09-27T23:00:00Z.

| hour class (2025-10-30T00 .. 2026-09-28T00) | hours | share |
|---|---|---|
| ok (ticks decoded) | 5359 | 67.1% |
| empty / closed (known no ticks) | 2633 | 32.9% |
| unknown (no file) | 0 | 0.0% |

Signals whose 80 h tick window has complete coverage for the BASE scenario: 415/415 (100%). Windows that cross an unknown hour are truncated and become NO_PRICE_DATA where unresolved.

## 2. Entry model: fill and skip rates (Reconstructed)

Scenario BASE = P1, latency 5 s, tolerance 0.5 USD, spread +0, slippage 0. PESS = latency 15 s, tolerance 0.5, spread +0.20 total, slippage 0.10. Skip reasons come from the first tick at or after signal time + latency.

| universe | scenario | n | FILLED | fill rate (Wilson) | SKIPPED price_outside_range | NO_PRICE_DATA |
|---|---|---|---|---|---|---|
| ALL signals | BASE | 415 | 68 | 16.4% [13.1, 20.3] | 347 | 0 |
| CLEAN signals | BASE | 406 | 67 | 16.5% [13.2, 20.4] | 339 | 0 |

| universe | scenario | n | FILLED | fill rate (Wilson) | SKIPPED price_outside_range | NO_PRICE_DATA |
|---|---|---|---|---|---|---|
| ALL signals | PESS | 415 | 75 | 18.1% [14.7, 22.1] | 340 | 0 |
| CLEAN signals | PESS | 406 | 73 | 18.0% [14.6, 22.0] | 333 | 0 |

Skip geometry, ALL signals. Distance = executable price at first tick minus range edge (tolerance applied).

| scenario | skips | beyond range on unfavourable side | beyond range on favourable side | median \|distance\| USD | max \|distance\| USD |
|---|---|---|---|---|---|
| BASE | 347 | 344 | 3 | 0.94 | 281.78 |
| PESS | 340 | 336 | 4 | 1.17 | 281.67 |

Skip geometry, CLEAN signals. Distance = executable price at first tick minus range edge (tolerance applied).

| scenario | skips | beyond range on unfavourable side | beyond range on favourable side | median \|distance\| USD | max \|distance\| USD |
|---|---|---|---|---|---|
| BASE | 339 | 338 | 1 | 0.94 | 281.78 |
| PESS | 333 | 330 | 3 | 1.12 | 281.67 |

Staleness: provider entry mid versus the Dukascopy mid at message time (Observed price comparison).

| universe | signals with a Dukascopy quote within +/-120 s | median (entry mid - market mid), USD | median \|gap\| USD | \|gap\| <= 0.5 USD | \|gap\| > 5 USD (stale / mismatched) |
|---|---|---|---|---|---|
| ALL signals | 415 | 0.89 | 1.87 | 5.5% [3.7, 8.2] | 3.6% [2.2, 5.9] |
| CLEAN signals | 406 | 0.90 | 1.87 | 5.7% [3.8, 8.4] | 3.2% [1.9, 5.4] |

| direction | n with quote | median (entry mid - market mid) | median \|gap\| |
|---|---|---|---|
| buy | 167 | -1.95 | 1.98 |
| sell | 248 | 1.84 | 1.84 |

Signal-to-fill delay (Reconstructed; by construction ~latency for market fills).

| statistic | value (s) |
|---|---|
| n filled (BASE) | 68 |
| median signal-to-fill | 5.19 |
| p90 signal-to-fill | 5.86 |
| max signal-to-fill | 8.01 |

## 3. First-touch frequencies, sequencing and win-rate definitions (Reconstructed, BASE, no management)

Each filled, determined signal is followed tick by tick for 72 h. "Before SL" compares first touches. n for each row is the set of signals where the event is defined (TP_k exists and the trade is determined).

TP touch frequencies, ALL signals.

| level | n (TP defined, filled & determined) | touched within 72 h | touched before SL |
|---|---|---|---|
| TP1 | 68 | 92.6% [83.9, 96.8] | 55.9% [44.1, 67.1] |
| TP2 | 68 | 91.2% [82.1, 95.9] | 30.9% [21.2, 42.6] |
| TP3 | 67 | 79.1% [67.9, 87.1] | 22.4% [14.1, 33.7] |
| TP4 | 51 | 68.6% [55.0, 79.7] | 19.6% [11.0, 32.5] |
| TP5 | 4 | 100.0% [51.0, 100.0] | 75.0% [30.1, 95.4] |

TP touch frequencies, CLEAN signals.

| level | n (TP defined, filled & determined) | touched within 72 h | touched before SL |
|---|---|---|---|
| TP1 | 67 | 92.5% [83.7, 96.8] | 55.2% [43.4, 66.5] |
| TP2 | 67 | 91.0% [81.8, 95.8] | 31.3% [21.5, 43.2] |
| TP3 | 66 | 78.8% [67.5, 86.9] | 22.7% [14.3, 34.2] |
| TP4 | 50 | 68.0% [54.2, 79.2] | 20.0% [11.2, 33.0] |
| TP5 | 4 | 100.0% [51.0, 100.0] | 75.0% [30.1, 95.4] |

Sequencing (Reconstructed, BASE). Denominators: determined filled signals with at least one event; conditionals as labelled.

| universe | P(SL before any TP \| any event) | P(TP1 before SL \| TP1 or SL) | P(TP2 before SL \| TP1 before SL) | P(TP3 before SL \| TP2 before SL) |
|---|---|---|---|---|
| ALL signals | 44.1% [32.9, 55.9] | 55.9% [44.1, 67.1] | 55.3% [39.7, 69.9] | 75.0% [53.1, 88.8] |
| CLEAN signals | 44.8% [33.5, 56.6] | 55.2% [43.4, 66.5] | 56.8% [40.9, 71.3] | 75.0% [53.1, 88.8] |

Win-rate definitions under the baseline (no management). Undetermined trades are excluded from the rate and counted separately.

| universe | definition | n (TP defined) | win | loss (SL first) | undetermined (neither by 72 h) | win rate = win/(win+loss) [95% CI] |
|---|---|---|---|---|---|---|
| ALL signals | (a) TP1 before SL | 68 | 38 | 30 | 0 | 55.9% [44.1, 67.1] |
| ALL signals | (b) TP2 before SL | 68 | 21 | 47 | 0 | 30.9% [21.2, 42.6] |
| ALL signals | (c) last TP before SL | 68 | 11 | 57 | 0 | 16.2% [9.3, 26.7] |
| CLEAN signals | (a) TP1 before SL | 67 | 37 | 30 | 0 | 55.2% [43.4, 66.5] |
| CLEAN signals | (b) TP2 before SL | 67 | 21 | 46 | 0 | 31.3% [21.5, 43.2] |
| CLEAN signals | (c) last TP before SL | 67 | 11 | 56 | 0 | 16.4% [9.4, 27.1] |

## 4. Strategy outcomes (Simulated, original SL, no BE unless named)

Simulated R uses R = |fill - SL| and exits on the executable tick side; checkpoint legs fill at the TP price; stop exits fill at the tick when gapped. Only FILLED trades are included. UNRESOLVED_MTM trades (open at 72 h) are counted separately and excluded from win rates and from the closed-equity curve.

Strategy metrics, scenario BASE, ALL signals.

| strategy | filled | resolved | UNRESOLVED_MTM | skipped | win rate [95% CI] | avg R (expectancy) | avg R 95% CI (normal approx.) | profit factor | sum R | max DD (R, closed) | max DD (USD per 1.0 lot) | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100% TP1 | 68 | 68 | 0 | 0 | 55.9% [44.1, 67.1] | 0.046 | +0.046 [-0.189, +0.281] | 1.10 | 3.13 | 3.99 | 2162 | 3 |
| 100% TP2 | 68 | 68 | 0 | 0 | 30.9% [21.2, 42.6] | 0.009 | +0.009 [-0.377, +0.395] | 1.01 | 0.60 | 8.55 | 4056 | 8 |
| 100% TP3 | 67 | 67 | 0 | 1 | 22.4% [14.1, 33.7] | 0.056 | +0.056 [-0.442, +0.555] | 1.07 | 3.77 | 11.31 | 5724 | 10 |
| equal thirds TP1/TP2/TP3 | 68 | 68 | 0 | 0 | 30.9% [21.2, 42.6] | 0.045 | +0.045 [-0.284, +0.373] | 1.08 | 3.04 | 7.81 | 3632 | 8 |
| equal thirds, 0.10 lot rounded | 68 | 68 | 0 | 0 | 30.9% [21.2, 42.6] | 0.048 | +0.048 [-0.294, +0.390] | 1.09 | 3.28 | 8.16 | 3841 | 8 |
| 50% TP1 + 50% TP2 (no BE) | 68 | 68 | 0 | 0 | 38.2% [27.6, 50.1] | 0.027 | +0.027 [-0.254, +0.309] | 1.06 | 1.86 | 6.06 | 2763 | 8 |
| 50% TP1 + 50% TP2, SL->entry after TP1 (BE-aware) | 68 | 68 | 0 | 0 | 55.9% [44.1, 67.1] | 0.003 | +0.003 [-0.240, +0.246] | 1.01 | 0.19 | 6.58 | 3440 | 3 |
| equal thirds, SL->entry after TP1 (BE-aware) | 68 | 68 | 0 | 0 | 55.9% [44.1, 67.1] | -0.008 | -0.008 [-0.271, +0.255] | 0.98 | -0.56 | 8.75 | 4344 | 3 |

Strategy metrics, scenario BASE, CLEAN signals.

| strategy | filled | resolved | UNRESOLVED_MTM | skipped | win rate [95% CI] | avg R (expectancy) | avg R 95% CI (normal approx.) | profit factor | sum R | max DD (R, closed) | max DD (USD per 1.0 lot) | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100% TP1 | 67 | 67 | 0 | 0 | 55.2% [43.4, 66.5] | 0.035 | +0.035 [-0.203, +0.273] | 1.08 | 2.34 | 4.70 | 2162 | 3 |
| 100% TP2 | 67 | 67 | 0 | 0 | 31.3% [21.5, 43.2] | 0.024 | +0.024 [-0.366, +0.415] | 1.03 | 1.62 | 8.23 | 3699 | 8 |
| 100% TP3 | 66 | 66 | 0 | 1 | 22.7% [14.3, 34.2] | 0.073 | +0.073 [-0.432, +0.577] | 1.09 | 4.79 | 10.39 | 5354 | 10 |
| equal thirds TP1/TP2/TP3 | 67 | 67 | 0 | 0 | 31.3% [21.5, 43.2] | 0.052 | +0.052 [-0.282, +0.385] | 1.09 | 3.46 | 7.40 | 3564 | 8 |
| equal thirds, 0.10 lot rounded | 67 | 67 | 0 | 0 | 31.3% [21.5, 43.2] | 0.056 | +0.056 [-0.291, +0.403] | 1.10 | 3.75 | 7.69 | 3743 | 8 |
| 50% TP1 + 50% TP2 (no BE) | 67 | 67 | 0 | 0 | 38.8% [28.0, 50.8] | 0.030 | +0.030 [-0.256, +0.315] | 1.06 | 1.98 | 5.95 | 2763 | 8 |
| 50% TP1 + 50% TP2, SL->entry after TP1 (BE-aware) | 67 | 67 | 0 | 0 | 55.2% [43.4, 66.5] | -0.003 | -0.003 [-0.249, +0.243] | 0.99 | -0.20 | 6.97 | 3722 | 3 |
| equal thirds, SL->entry after TP1 (BE-aware) | 67 | 67 | 0 | 0 | 55.2% [43.4, 66.5] | -0.012 | -0.012 [-0.279, +0.255] | 0.97 | -0.82 | 9.01 | 4528 | 3 |

Strategy metrics, scenario PESS, ALL signals.

| strategy | filled | resolved | UNRESOLVED_MTM | skipped | win rate [95% CI] | avg R (expectancy) | avg R 95% CI (normal approx.) | profit factor | sum R | max DD (R, closed) | max DD (USD per 1.0 lot) | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100% TP1 | 75 | 75 | 0 | 0 | 44.0% [33.3, 55.3] | -0.179 | -0.179 [-0.405, +0.048] | 0.69 | -13.39 | 15.97 | 9126 | 4 |
| 100% TP2 | 75 | 75 | 0 | 0 | 26.7% [18.0, 37.6] | -0.138 | -0.138 [-0.489, +0.212] | 0.82 | -10.38 | 20.88 | 11847 | 7 |
| 100% TP3 | 75 | 75 | 0 | 0 | 20.0% [12.5, 30.4] | 0.032 | +0.032 [-0.486, +0.550] | 1.04 | 2.38 | 13.10 | 8620 | 7 |
| equal thirds TP1/TP2/TP3 | 75 | 75 | 0 | 0 | 26.7% [18.0, 37.6] | -0.095 | -0.095 [-0.426, +0.236] | 0.85 | -7.13 | 14.45 | 8624 | 7 |
| equal thirds, 0.10 lot rounded | 75 | 75 | 0 | 0 | 26.7% [18.0, 37.6] | -0.082 | -0.082 [-0.430, +0.265] | 0.88 | -6.18 | 14.23 | 8523 | 7 |
| 50% TP1 + 50% TP2 (no BE) | 75 | 75 | 0 | 0 | 32.0% [22.5, 43.2] | -0.159 | -0.159 [-0.421, +0.104] | 0.74 | -11.89 | 15.50 | 9169 | 7 |
| 50% TP1 + 50% TP2, SL->entry after TP1 (BE-aware) | 75 | 75 | 0 | 0 | 44.0% [33.3, 55.3] | -0.147 | -0.147 [-0.399, +0.104] | 0.75 | -11.06 | 13.60 | 8037 | 4 |
| equal thirds, SL->entry after TP1 (BE-aware) | 75 | 75 | 0 | 0 | 44.0% [33.3, 55.3] | -0.097 | -0.097 [-0.394, +0.200] | 0.83 | -7.28 | 11.34 | 7440 | 4 |

Strategy metrics, scenario PESS, CLEAN signals.

| strategy | filled | resolved | UNRESOLVED_MTM | skipped | win rate [95% CI] | avg R (expectancy) | avg R 95% CI (normal approx.) | profit factor | sum R | max DD (R, closed) | max DD (USD per 1.0 lot) | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100% TP1 | 73 | 73 | 0 | 0 | 43.8% [33.0, 55.2] | -0.180 | -0.180 [-0.410, +0.051] | 0.69 | -13.12 | 15.70 | 8715 | 4 |
| 100% TP2 | 73 | 73 | 0 | 0 | 27.4% [18.5, 38.6] | -0.114 | -0.114 [-0.472, +0.245] | 0.85 | -8.31 | 18.81 | 10102 | 7 |
| 100% TP3 | 73 | 73 | 0 | 0 | 20.5% [12.9, 31.2] | 0.061 | +0.061 [-0.470, +0.592] | 1.07 | 4.45 | 11.03 | 6876 | 7 |
| equal thirds TP1/TP2/TP3 | 73 | 73 | 0 | 0 | 27.4% [18.5, 38.6] | -0.078 | -0.078 [-0.416, +0.261] | 0.88 | -5.66 | 12.98 | 7324 | 7 |
| equal thirds, 0.10 lot rounded | 73 | 73 | 0 | 0 | 27.4% [18.5, 38.6] | -0.064 | -0.064 [-0.419, +0.292] | 0.90 | -4.65 | 12.70 | 7178 | 7 |
| 50% TP1 + 50% TP2 (no BE) | 73 | 73 | 0 | 0 | 32.9% [23.2, 44.3] | -0.147 | -0.147 [-0.415, +0.122] | 0.76 | -10.72 | 14.33 | 8092 | 7 |
| 50% TP1 + 50% TP2, SL->entry after TP1 (BE-aware) | 73 | 73 | 0 | 0 | 43.8% [33.0, 55.2] | -0.142 | -0.142 [-0.399, +0.115] | 0.76 | -10.40 | 12.95 | 7340 | 4 |
| equal thirds, SL->entry after TP1 (BE-aware) | 73 | 73 | 0 | 0 | 43.8% [33.0, 55.2] | -0.089 | -0.089 [-0.393, +0.215] | 0.85 | -6.50 | 10.56 | 6648 | 4 |

| strategy | loss-streak length : count (BASE, closed trades, exit-time order) |
|---|---|
| 100% TP1 | 1:17, 2:2, 3:3 |
| equal thirds | 1:6, 2:1, 3:5, 5:2, 6:1, 8:1 |

Trades spanning a market gap (BASE, Reconstructed). Swap / overnight financing is NOT modelled (default 0, Unknown for Vantage); the count of rollovers is available in the engine.

| strategy | n | trades with a tick gap >= 60 min | >= 12 h | >= 24 h (weekend-type) | largest gap (min) |
|---|---|---|---|---|---|
| 100% TP1 | 68 | 0 | 0 | 0 | 0.2 |
| equal thirds | 68 | 1 | 0 | 0 | 60.0 |

## 5. Breakdowns (BASE, determined filled signals; Reconstructed win definitions and Simulated R)

direction, ALL signals.

| direction | n filled & determined | TP1-before-SL win rate [95% CI] (n=TP1 or SL) | avg R 100%TP1 | avg R equal thirds |
|---|---|---|---|---|
| buy | 23 | 43.5% [25.6, 63.2] | -0.18 | -0.37 |
| sell | 45 | 62.2% [47.6, 74.9] | 0.16 | 0.26 |

UTC session (signal time), ALL signals.

| UTC session (signal time) | n filled & determined | TP1-before-SL win rate [95% CI] (n=TP1 or SL) | avg R 100%TP1 | avg R equal thirds |
|---|---|---|---|---|
| Asia 00-07 | 9 | 66.7% [35.4, 87.9] | 0.20 | 0.45 |
| Late 17-24 | 1 | 0.0% [0.0, 79.3] | -1.01 | -1.01 |
| London 07-12 | 34 | 52.9% [36.7, 68.5] | -0.03 | -0.22 |
| NY-overlap 12-17 | 24 | 58.3% [38.8, 75.5] | 0.14 | 0.31 |

weekday (UTC), ALL signals.

| weekday (UTC) | n filled & determined | TP1-before-SL win rate [95% CI] (n=TP1 or SL) | avg R 100%TP1 | avg R equal thirds |
|---|---|---|---|---|
| Fri | 12 | 50.0% [25.4, 74.6] | -0.13 | -0.22 |
| Mon | 11 | 54.5% [28.0, 78.7] | -0.07 | -0.14 |
| Thu | 16 | 43.8% [23.1, 66.8] | -0.23 | -0.46 |
| Tue | 18 | 66.7% [43.7, 83.7] | 0.38 | 0.66 |
| Wed | 11 | 63.6% [35.4, 84.8] | 0.20 | 0.24 |

month (UTC), ALL signals.

| month (UTC) | n filled & determined | TP1-before-SL win rate [95% CI] (n=TP1 or SL) | avg R 100%TP1 | avg R equal thirds |
|---|---|---|---|---|
| 2025-11 | 7 | 42.9% [15.8, 75.0] | -0.33 | -0.68 |
| 2025-12 | 3 | 66.7% [20.8, 93.9] | 0.14 | -0.63 |
| 2026-01 | 6 | 50.0% [18.8, 81.2] | -0.12 | 0.10 |
| 2026-02 | 6 | 66.7% [30.0, 90.3] | 0.16 | 0.52 |
| 2026-03 | 2 | 50.0% [9.5, 90.5] | 0.01 | -0.69 |
| 2026-04 | 4 | 25.0% [4.6, 69.9] | -0.56 | -0.86 |
| 2026-05 | 16 | 56.2% [33.2, 76.9] | 0.11 | 0.39 |
| 2026-06 | 5 | 100.0% [56.6, 100.0] | 0.95 | 1.13 |
| 2026-07 | 6 | 50.0% [18.8, 81.2] | 0.03 | -0.13 |
| 2026-08 | 6 | 33.3% [9.7, 70.0] | -0.37 | -0.33 |
| 2026-09 | 7 | 71.4% [35.9, 91.8] | 0.37 | 0.23 |

SL distance tercile (|SL - entry mid|), ALL signals.

| SL distance tercile (\|SL - entry mid\|) | n filled & determined | TP1-before-SL win rate [95% CI] (n=TP1 or SL) | avg R 100%TP1 | avg R equal thirds |
|---|---|---|---|---|
| T1 low (<= 4.00) | 23 | 43.5% [25.6, 63.2] | -0.20 | -0.29 |
| T2 mid (<= 5.30) | 23 | 56.5% [36.8, 74.4] | 0.10 | 0.13 |
| T3 high (> 5.30) | 22 | 68.2% [47.3, 83.6] | 0.25 | 0.30 |

direction, CLEAN signals.

| direction | n filled & determined | TP1-before-SL win rate [95% CI] (n=TP1 or SL) | avg R 100%TP1 | avg R equal thirds |
|---|---|---|---|---|
| buy | 22 | 40.9% [23.3, 61.3] | -0.23 | -0.36 |
| sell | 45 | 62.2% [47.6, 74.9] | 0.16 | 0.26 |

UTC session (signal time), CLEAN signals.

| UTC session (signal time) | n filled & determined | TP1-before-SL win rate [95% CI] (n=TP1 or SL) | avg R 100%TP1 | avg R equal thirds |
|---|---|---|---|---|
| Asia 00-07 | 9 | 66.7% [35.4, 87.9] | 0.20 | 0.45 |
| Late 17-24 | 1 | 0.0% [0.0, 79.3] | -1.01 | -1.01 |
| London 07-12 | 33 | 51.5% [35.2, 67.5] | -0.05 | -0.21 |
| NY-overlap 12-17 | 24 | 58.3% [38.8, 75.5] | 0.14 | 0.31 |

weekday (UTC), CLEAN signals.

| weekday (UTC) | n filled & determined | TP1-before-SL win rate [95% CI] (n=TP1 or SL) | avg R 100%TP1 | avg R equal thirds |
|---|---|---|---|---|
| Fri | 12 | 50.0% [25.4, 74.6] | -0.13 | -0.22 |
| Mon | 11 | 54.5% [28.0, 78.7] | -0.07 | -0.14 |
| Thu | 16 | 43.8% [23.1, 66.8] | -0.23 | -0.46 |
| Tue | 18 | 66.7% [43.7, 83.7] | 0.38 | 0.66 |
| Wed | 10 | 60.0% [31.3, 83.2] | 0.14 | 0.30 |

month (UTC), CLEAN signals.

| month (UTC) | n filled & determined | TP1-before-SL win rate [95% CI] (n=TP1 or SL) | avg R 100%TP1 | avg R equal thirds |
|---|---|---|---|---|
| 2025-11 | 7 | 42.9% [15.8, 75.0] | -0.33 | -0.68 |
| 2025-12 | 3 | 66.7% [20.8, 93.9] | 0.14 | -0.63 |
| 2026-01 | 6 | 50.0% [18.8, 81.2] | -0.12 | 0.10 |
| 2026-02 | 6 | 66.7% [30.0, 90.3] | 0.16 | 0.52 |
| 2026-03 | 2 | 50.0% [9.5, 90.5] | 0.01 | -0.69 |
| 2026-04 | 3 | 0.0% [0.0, 56.1] | -1.01 | -1.01 |
| 2026-05 | 16 | 56.2% [33.2, 76.9] | 0.11 | 0.39 |
| 2026-06 | 5 | 100.0% [56.6, 100.0] | 0.95 | 1.13 |
| 2026-07 | 6 | 50.0% [18.8, 81.2] | 0.03 | -0.13 |
| 2026-08 | 6 | 33.3% [9.7, 70.0] | -0.37 | -0.33 |
| 2026-09 | 7 | 71.4% [35.9, 91.8] | 0.37 | 0.23 |

SL distance tercile (|SL - entry mid|), CLEAN signals.

| SL distance tercile (\|SL - entry mid\|) | n filled & determined | TP1-before-SL win rate [95% CI] (n=TP1 or SL) | avg R 100%TP1 | avg R equal thirds |
|---|---|---|---|---|
| T1 low (<= 4.00) | 23 | 43.5% [25.6, 63.2] | -0.20 | -0.29 |
| T2 mid (<= 5.25) | 22 | 54.5% [34.7, 73.1] | 0.07 | 0.06 |
| T3 high (> 5.25) | 22 | 68.2% [47.3, 83.6] | 0.25 | 0.40 |

Overlap with earlier open trades (baseline end-times), ALL signals.

| group | n | TP1-before-SL win rate [95% CI] |
|---|---|---|
| overlapping: an earlier filled signal still open at signal time | 10 | 30.0% [10.8, 60.3] |
| no earlier filled signal open | 58 | 60.3% [47.5, 71.9] |

Overlap with earlier open trades (baseline end-times), CLEAN signals.

| group | n | TP1-before-SL win rate [95% CI] |
|---|---|---|
| overlapping: an earlier filled signal still open at signal time | 10 | 30.0% [10.8, 60.3] |
| no earlier filled signal open | 57 | 59.6% [46.7, 71.4] |

## 6. Late entry and entry-policy sensitivity (Reconstructed; TP1 win definition (a) and EQ3 simulated where filled)

Entry-policy and offset sensitivity. P3 is diagnostic only (not executable) and is shown for the upper bound only. Equal-thirds R is available for LAT60 and P2 scenarios (simulated); blank for others.

| entry scenario | universe | n | filled | fill rate [95% CI] | TP1-before-SL [95% CI] (n: TP1 or SL) | avg R equal thirds (sim) |
|---|---|---|---|---|---|---|
| BASE (P1, 5 s, tol 0.5) | ALL signals | 415 | 68 | 16.4% [13.1, 20.3] | 55.9% [44.1, 67.1] | n/a |
| BASE (P1, 5 s, tol 0.5) | CLEAN signals | 406 | 67 | 16.5% [13.2, 20.4] | 55.2% [43.4, 66.5] | n/a |
| P1, tol 0 | ALL signals | 415 | 25 | 6.0% [4.1, 8.7] | 48.0% [30.0, 66.5] | n/a |
| P1, tol 0 | CLEAN signals | 406 | 25 | 6.2% [4.2, 8.9] | 48.0% [30.0, 66.5] | n/a |
| P1, tol 2.0 | ALL signals | 415 | 299 | 72.0% [67.5, 76.1] | 58.2% [52.5, 63.6] | n/a |
| P1, tol 2.0 | CLEAN signals | 406 | 293 | 72.2% [67.6, 76.3] | 58.0% [52.3, 63.5] | n/a |
| P1, latency 60 s (late entry) | ALL signals | 415 | 93 | 22.4% [18.7, 26.7] | 53.8% [43.7, 63.5] | 0.19 |
| P1, latency 60 s (late entry) | CLEAN signals | 406 | 91 | 22.4% [18.6, 26.7] | 53.8% [43.7, 63.7] | 0.21 |
| P2 pending at range, expiry 60 min | ALL signals | 415 | 203 | 48.9% [44.1, 53.7] | 53.7% [46.8, 60.4] | -0.14 |
| P2 pending at range, expiry 60 min | CLEAN signals | 406 | 199 | 49.0% [44.2, 53.9] | 53.3% [46.3, 60.1] | -0.13 |
| P2 pending at range, expiry 240 min | ALL signals | 415 | 208 | 50.1% [45.3, 54.9] | 53.8% [47.1, 60.5] | -0.13 |
| P2 pending at range, expiry 240 min | CLEAN signals | 406 | 204 | 50.2% [45.4, 55.1] | 53.4% [46.6, 60.1] | -0.12 |
| BASE after constant offset correction (-0.87 USD) | ALL signals | 415 | 144 | 34.7% [30.3, 39.4] | 50.7% [42.6, 58.7] | n/a |
| BASE after constant offset correction (-0.87 USD) | CLEAN signals | 406 | 143 | 35.2% [30.7, 40.0] | 51.0% [42.9, 59.1] | n/a |
| DIAGNOSTIC: BASE with levels re-anchored to the market mid at posting (distances kept) | ALL signals | 415 | 391 | 94.2% [91.5, 96.1] | 43.0% [38.2, 47.9] | n/a |
| DIAGNOSTIC: BASE with levels re-anchored to the market mid at posting (distances kept) | CLEAN signals | 406 | 382 | 94.1% [91.4, 96.0] | 43.2% [38.3, 48.2] | n/a |
| P3 ideal mid fill at signal time (NON-EXECUTABLE upper bound) | ALL signals | 415 | 415 | 100.0% [99.1, 100.0] | 61.4% [56.7, 66.0] | n/a |
| P3 ideal mid fill at signal time (NON-EXECUTABLE upper bound) | CLEAN signals | 406 | 406 | 100.0% [99.1, 100.0] | 61.3% [56.5, 65.9] | n/a |

Late-entry comparison (Reconstructed).

| group | n | median \|fill(60 s) - fill(5 s)\| USD | max \|diff\| USD |
|---|---|---|---|
| filled at 5 s and at 60 s | 30 | 0.470 | 1.537 |
| filled at 60 s only | 63 |  |  |
| filled at 5 s only (skipped at 60 s) | 38 |  |  |

| same signals | n | TP1-before-SL [95% CI] at 5 s | TP1-before-SL [95% CI] at 60 s |
|---|---|---|---|
| both filled | 30 | 63.3% [45.5, 78.1] | 63.3% [45.5, 78.1] |

## 7. Systematic offset between provider prices and Dukascopy (Observed + sensitivity)

A3's alignment_per_signal.csv has only 7 usable rows (408 of 415 had no tick within 120 s because the download had not reached those hours when it ran). This report recomputes the alignment on the full period: 415 signals have a quote within +/-120 s, and 400 of them have |entry mid - market mid| <= 5 USD. Their median is +0.87 USD (mean +0.29, sd 2.21). The sensitivity shifts every provider level by -0.87 USD before the BASE rules.

|  | BASE | BASE + constant offset correction | DIAGNOSTIC: re-anchored to market mid at posting |
|---|---|---|---|
| filled | 68 | 144 | 391 |
| skipped | 347 | 271 | 24 |

The constant-offset model fits poorly: the sign of (entry mid - market mid) is opposite for the two directions (BUY median -1.95, SELL median +1.84 USD). Both directions sit on the favourable side of the market at posting, which is what stale or lagged posting produces. A single shift cannot reproduce that. The re-anchored row is a diagnostic of how much of the skip rate is level staleness; it is not a trading result and is not used for any recommendation.

## 8. Comparison with provider self-reported claims (Observed claims vs Reconstructed prices)

Only unambiguous claim links are used: reply-linked, or temporal with exactly one candidate signal (a1 provider_claim_events.csv). Claims are never an input to the reconstruction. The provider's own TP/BE/loss claims are compared against the tick data only after the reconstruction was fixed.

TP-hit claim checks. SUPPORTED = our first touch of that TP precedes the first SL touch within 72 h; SL_FIRST = SL touched first; NOT_TOUCHED = no touch within 72 h; NA_NOT_FILLED = the signal was not entered.

| verdict (unambiguous TP-hit claims, BASE) | n |
|---|---|
| NA_NOT_FILLED | 132 |
| SUPPORTED | 17 |
| SL_FIRST | 3 |
| NOT_TOUCHED_IN_HORIZON | 2 |

| metric | value |
|---|---|
| TP-hit claims on filled signals (n) | 22 |
| agreement rate (SUPPORTED / n) [95% CI] | 77.3% [56.6, 89.9] |
| claims that price data does not support (SL_FIRST + NOT_TOUCHED_IN_HORIZON) | 22.7% [10.1, 43.4] |

| claim type (unambiguous) | n on filled signals | supported | contradicted | note |
|---|---|---|---|---|
| break-even exit claim (update_stopped_at_be) | 2 | 2 | 0 | supported = TP1 touched before SL (so a BE stop is plausible); contradicted = SL first (a loss) |
| loss claim (update_loss_claim) | 1 | 1 | 0 | supported = SL touched within 72 h |

Signals carrying at least one unambiguous TP-hit claim that could not be entered under BASE: 98 of 117 signals with such a claim. The tick data shows the entry was never available at the posted range, so the claimed TP hit cannot be reproduced from ticks.

| claim time minus our TP touch (supported claims, minutes) | n | median | p10 | p90 |
|---|---|---|---|---|
| claim - touch | 17 | 1.5 | 0.0 | 2.6 |

## 9. Data-quality facts from the tick feed (Observed)

| check | value |
|---|---|
| ticks decoded | 83,641,720 |
| bid > ask | 0 |
| zero spread ticks | 0 |
| spread > 5 USD (ticks) | 40,472 |
| ms offsets non-monotone within an hour (hours) | 0 |
| one-tick mid jumps > 5 USD | 749 |
| one-tick mid jumps > 20 USD | 15 |
| median spread (hour medians) | 0.690 |
| price range in data (USD) | 3915.07 .. 5599.72 |

