# B2 - TP and runner optimiser: re-run guide

All code is read-only with respect to the repo, worker/dist, services, Telegram, Firestore and brokers.
Inputs are read from `../b1/` (signals_universe.csv, cache/ read-only, strategy_outcomes.csv for a cross-check)
and `../a3/raw` (Dukascopy bi5 hours). Outputs go to `out/`. Run everything with

    cd <this dir> && nice -n 10 python3 -I <script>

Engine: `sim_engine_b2.py` = B1's `sim_engine.py` + one defect fix (entry-side pending triggers).
Diff: `sim_engine_b2.diff`. Patch tests: `test_b2_engine_patch.py` (4) and `test_sim_engine_on_b2.py` (B1's 35, unchanged).

## Order (as run)
1. `python3 -I test_b2_engine_patch.py` and `python3 -I test_sim_engine_on_b2.py`
2. `python3 -I b2_phase1.py`          TRAIN + VALIDATION only (OOS never loaded). ~2.5 min, 2 workers.
3. `python3 -I b2_tables.py train` and `python3 -I b2_tables.py val`
4. `python3 -I b2_select.py`          FREEZE: writes out/finalists.json with sha256 (do not re-run after OOS).
5. `python3 -I b2_regime.py`          ex-ante regime features (prior 4 h, pre-signal ticks only).
6. `python3 -I b2_phase2_oos.py`      ONE-TIME OOS evaluation; writes out/oos_evaluated.lock (refuses a second run).
7. `python3 -I b2_tables.py oos out/oos_trades.csv.gz out/oos_fills.csv`
8. `python3 -I b2_analysis.py`        OOS paired bootstrap + Holm, White RC (TRAIN+VAL), landscape, TP1 and runner paired tests.
9. `python3 -I b2_rc_tp4_support.py` RC on the full-support (TP4-present) subset.
10. `python3 -I b2_descriptive.py`    BUY/SELL, session, weekday, regime; pre-registered H1/H2.
11. `python3 -I b2_walkforward.py`    rolling 3-month walk-forward over the frozen family (post-OOS, robustness only).
12. `python3 -I b2_extra.py`          RC vs zero, horizon/weekend sensitivity (post-OOS, descriptive), flagged signals.
13. `python3 -I b2_be_1r_check.py`    post-hoc BE 6.0 USD check on TRAIN+VAL only (descriptive).
14. `python3 -I b2_feasibility.py`    lot-rounding arithmetic (synthetic, fill-independent).
15. `python3 -I b2_frozen_summary.py` frozen family, all splits and costs, with exposure.
16. `python3 -I b2_check_vs_b1.py`    cross-check of the rebuilt E3 BASE 100%TP1 trades against B1.
17. `python3 -I b2_check_lookahead.py` fill-after-latency and exit-after-fill check on all trade rows.
18. `python3 -I b2_be_1r_check.py` (listed as 13) and `python3 -I b2_rc_tp4_support.py` (listed as 9) are the post-hoc and RC scripts.

Cores: `b2_core.py` (signals, splits, grid, entry models, per-signal evaluation), `b2_stats.py` (metrics,
bootstraps seed 42, block bootstrap, paired differences, White RC).

## Outputs (out/)
- `train_metrics.csv`, `val_metrics.csv`, `oos_metrics.csv`: every variant x entry x cost x split (metric definitions in REPORT.md).
- `*_fill_summary.csv`: fills and skip reasons per split, entry, cost.
- `phase1_trades.csv.gz`, `oos_trades.csv.gz`, `phase1_fills.csv`, `oos_fills.csv`: trade-level rows.
- `finalists.json`: frozen finalists, rule, sha256 of its content, pre-registered H1/H2.
- `oos_paired.csv`, `tv_paired.csv`, `analysis.json`, `landscape.csv`, `rc_tp4_support.json`, `extra.json`.
- `walkforward.csv`, `descriptive.csv`, `hypotheses.json`, `regime_features.csv`, `feasibility.csv`.
- `horizon_sensitivity.csv`, `flagged_sensitivity.csv`, `be_1r_check.csv`, `frozen_summary.csv`.
- `oos_evaluated.lock`: one-time OOS guard record.
