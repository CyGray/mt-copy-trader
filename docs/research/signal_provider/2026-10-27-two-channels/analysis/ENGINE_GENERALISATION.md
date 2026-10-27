# Symbol-aware B2 engine: implementation report

Scope: offline research code only. No broker, Telegram, Firestore, service, git or secret was touched. Reads of
the reference scratchpad and the repo analysis copies were read-only (`find -newer` shows no writes there).
Gold behaviour is unchanged: the XAUUSD regression is exact. FX behaviour is verified on synthetic data only.

## Result in one table

| Check | Result |
|---|---|
| Existing suites, before edits | 39 OK (35 + 4) |
| Existing suites, after edits | 39 OK |
| New `b2/test_symbols.py` | 11 OK |
| Total after | 50 OK |
| Gold regression, trade rows | 1716 compared on (message_id, entry, cost, variant); 0 mismatches on status, total_R, fill_px, final_exit, exit_seq or any of the 35 columns |
| Gold regression, fills | 522 rows, 0 mismatches |
| Gold regression, summary | byte-identical to the scratchpad live/oos2 summary and to the repo `final_summary.json` |
| Gold tick cache | 473 files, same names, identical arrays |
| FX scale invariance, frozen set | 0 mismatches (4,140 trade comparisons, 40 seeds, EURUSD 1e-4 and USDJPY 0.01); max abs diff in total_R 5e-13 |
| FX scale invariance, full grid, exact power-of-two scale | 0 mismatches (67,620 trade comparisons) |
| FX scale invariance, full grid, decimal scales | 56 mismatches out of 135,240 (see below); not part of the frozen-set acceptance |
| Mutation check (6 injected defects) | all 6 caught by test_symbols.py |

## Commands run (all with `nice -n 10` for heavy work, `python3 -I`)

1. Baseline suites, before any edit. The brief's form `python3 -I -m unittest test_sim_engine_on_b2 test_b2_engine_patch -v`
   failed with ModuleNotFoundError, because `-I` drops the working directory from `sys.path`. Same modules, run as:
   `cd study/b2 && python3 -I -c "import sys, unittest; sys.path.insert(0, '.'); unittest.main(module=None, argv=['unittest', '-v', 'test_sim_engine_on_b2', 'test_b2_engine_patch'])"`
   Result: Ran 39, OK. numpy comes from the engine's existing user-site fallback (the mechanism the scripts already use).
   Log: `gen/suites_before.log`.
2. Copied `finalists.json` from the scratchpad to `study/b2/out/`. Verified the hash the brief names: recomputing the
   body hash the way `b2_select.py` does (`json.dumps(body, sort_keys=True, indent=1)` without the hash field) gives
   `907790184fd086998e07533102e1e6f8a332c55e5626ef52b0a4d60b63432235`, which matches `sha256_of_body`. The file's
   own bytes hash to `21a337d7...`; that differs only because the file contains its own body hash.
3. Edits (see the diff). Suites rerun after the engine edit: 39 OK.
4. New tests: `cd study/b2 && python3 -I test_symbols.py` → 11 OK. Log: `gen/test_symbols_final.log`.
5. Scale experiments (scratch, `gen/scratch/`: `exp_scale.py` frozen and full grid, `exp_dyadic.py` exact power-of-two,
   `exp_group.py` mismatch grouping, `exp_tie_shift.py` gold-shift control, `dbg_tie*.py` one-case trace; logs in
   `gen/experiments/`), 40 seeds x 2 directions.
6. Mutation check: `gen/mutate.sh` applied one replacement at a time to a scratch copy, logs in `gen/mut/`.
7. Gold regression, on the final code:
   `python3 -I study/oos2/oos2_eval.py $OLD/live/oos2/universe_final.csv regress/final/gold --symbol XAUUSD --raw $OLD/a3/raw`
   (about 12 s; `$OLD` = the scratchpad, read only). Comparison: `gen/compare_regression.py`, log `gen/regression_compare.log`.
8. FX command-line smoke test on synthetic inputs (`gen/smoke/`, not research data).
9. Unified diff against the pristine analysis copies: `gen/engine_generalisation.diff`. Checked: it applies cleanly to
   the pristine files and reproduces the three study files exactly.

## What changed

- `b2/sim_engine_b2.py`
  - `TickStore(..., price_divisor=PRICE_DIVISOR)`; decoding uses `self.price_divisor`.
  - Cache name gets `_d<divisor>` only for non-default divisors, so gold cache files keep their historical names.
  - `Conventions(contract_oz=None)` reads `CONTRACT_OZ` at call time, so `configure_symbol` reaches the default.
- `b2/b2_core.py`
  - `configure_symbol(symbol)` derives all USD parameters from the gold originals (`_BASE`): costs (spread, slippage),
    entry tolerances, BE trigger, trailing distances and step, and the M2 stop buffer. It takes the stop bounds
    from `min_sl`/`max_sl` and the contract from the spec. It returns the spec, so callers can pass the divisor.
  - Variant names use labels (`distance / UNIT`), so finalist names match across symbols. `v['unit']` is recorded,
    and `make_strategy` refuses a grid built for a different unit.
  - Output rows round `fill_px` and `R_usd` to `OUT_DP` (4 for gold, 8 for EURUSD, 6 for USDJPY). Gold stays at 4.
- `oos2/oos2_eval.py`: argparse with `--symbol` (default XAUUSD), `--raw`, `--b2`. Defaults reproduce the gold run.
  It prints one header line to stdout. The summary JSON is unchanged.
- New: `b2/test_symbols.py` (11 tests: gold identity, FX parameters, scale invariance for frozen set and full grid,
  TickStore divisor and cache naming, contract in usd_per_1lot and in the grid guard).

## Finding during implementation: one missed USD constant (fixed)

The first version scaled every USD parameter except the M2 stop buffer (`sl_after` 0.3 USD in `mgmt_options`).
The frozen set has no M2 variant, so the frozen-set test could not see it. The full-grid comparison did. Re-running
the unscaled version (`gen/experiments/mutant_M2_unscaled_groups.log`) gives 3,710 mismatching trade comparisons out
of 135,240: 3,654 are M2 variants, and the other 56 are the trailing-tie set described below. Fixed as `0.3 * UNIT`;
gold is unaffected because `0.3 * 1.0 == 0.3`. A grep audit of float literals in the engine and core found no other
decision-relevant USD constant. `EPS = 1e-9` is an absolute numerical guard and is deliberately not scaled.

## Scale invariance: details

- Synthetic gold path: random walk on a 0.001 grid over 80 h, one signal at T0, seven TPs, spreads 0.10 to 0.30.
  FX case = every price multiplied by k. Compared through `evaluate_signal` (fill status and reason, exit sequence,
  final exit, unrounded total_R).
- Frozen set (5 finalists + benchmark), all entries (E1, E2, E3), all costs: 0 mismatches at both 1e-4 and 0.01.
- Full grid, exact power-of-two scale 2^-13 (scaling is exact in binary, so this isolates the logic): 0 mismatches in
  67,620 trade comparisons. This is the completeness proof: it would catch any missed USD constant.
- Full grid at the spec scales (1e-4 and 0.01): 56 mismatches in 135,240 comparisons. Every one is a trailing variant
  with a 4-unit trail distance (T1_4, T2_4, RUN_T1_4, RUN_T2_4), all at E1/MID, 28 for EURUSD and 28 for USDJPY.
  Largest |diff| in total_R is 0.026 R. No fill status or fill decision differs.
- Cause, verified for one case by hand (seed 16, sell, EURUSD, T_50_30_20|T1_4, E1/MID): the trailing stop is
  2003.217 - 6.5 = 1996.717, and the tick ask plus the 0.05 half-spread is 1996.667 + 0.05 = 1996.717. That is an exact
  decimal tie, and the engine's `<=` comparison has no tolerance. In floating point, FX lands exactly on the stop and
  fires; gold lands one ulp above it and does not. The evidence points to the rounding introduced by a
  non-power-of-two scale factor: the exact power-of-two run has no mismatches.
- Not established: why the mismatches are confined to E1/MID and to the 4-unit distance (I did not find a cause), and
  whether all 56 are ties (only the one case above was checked by hand). A control that shifts the gold path by
  1e-10 or 1e-7 (decimal relations preserved) changed nothing in 67,620 comparisons, so the trigger is specific to
  the scale transform, not to generic float noise.
- Consequence: the gold engine's own result at an exact decimal tie depends on floating-point rounding. Changing
  the comparison to use a tolerance would change gold results, which the brief forbids, so I did not do it. Real FX
  runs can hit the same effect on trailing stops (the frozen set has no trailing variant). Gold runs are unaffected.

## Mutation check (`gen/mutate.sh`, logs `gen/mut/run_*.log`)

| Injected defect | Caught by |
|---|---|
| M2 stop buffer unscaled (the bug above) | test_full_grid_identical_under_exact_power_of_two_scale |
| TickStore decodes with the global divisor | test_divisor_100000_decodes_bi5_to_fx_prices |
| Slippage unscaled | frozen-set tests (EURUSD, USDJPY), exact-scale test, pip-parameter test |
| Trail distance unscaled | exact-scale test, pip-parameter test, label-name test |
| Conventions default frozen at 100 | test_usd_per_1lot_uses_the_symbol_contract |
| Cache name without divisor tag | test_divisor_100000_decodes_bi5_to_fx_prices |

## Regression detail (gold, reference = scratchpad live/oos2)

- Reference rows 1716, regenerated 1716. Key sets equal; no duplicate keys. Compared as exact CSV strings, no tolerance.
- Mismatches: 0 on status, total_R, fill_px, final_exit and exit_seq, and 0 across all 35 columns.
- Fills: 522 rows vs 522, 0 mismatches. Summary: JSON-equal and byte-identical to the live reference and to
  `analysis/oos2/final_summary.json` (in the repo, read only).
- Cache: 473 files, same names; every array identical (decoding from raw with the new code path).
- Run was without `--all`. All 58 rows are `in_clean=1`, so this is the same 58 signals.

## FX smoke test (synthetic only)

One synthetic signal, 84 h of minute ticks, 100,000 divisor, `--symbol EURUSD`. It ran end to end. Cache names carry
`_d100000`. Rows keep 5 decimals. usd_per_1lot = -116.0 for a -1R loss on R = 0.00116 (= 0.00116 x 100,000), as it should.
The numbers mean nothing as research.

## Assumptions

1. The pre-registered unit rule is applied as written (USD x unit; 1.0 gold, 1 pip FX). Stop bounds come from
   `min_sl`/`max_sl`, and the contract from `spec['contract']`. Spec numbers are unchanged.
2. **Stop cap inconsistency (for the owner):** the FX `max_sl` is 0.0100 (100 pips), while the gold cap of 25 USD maps
   to 25 pips under the 1-USD = 1-pip rule (0.0025). The FX cap is therefore 4x the gold-equivalent. The minimum
   (2 pips) matches. I used the spec as the rule says and did not change it.
3. Variant names are labels in study units (USD for gold, pips for FX). Finalist names therefore match across symbols.
4. `EPS = 1e-9` is not scaled. It only matters at exact ties.
5. Cache: the divisor tag is a guard, not a correctness requirement, because the cache stores raw integer ticks
   and the divisor is applied at load. TickStore does not know the symbol, so two symbols with the same divisor
   (XAUUSD and USDJPY are both 1000) whose raw files for the same hour have the same byte size would share a cache
   file. `oos2_eval.py` avoids this with `cache_oos2_<SYMBOL>` for non-gold symbols. The engine does not enforce it.
6. Column names such as `mae_*_usd`, `outside_dist`, and `swap_usd_per_lot_per_rollover` still say USD. For FX they
   are price units. This is naming only. The swap default is 0. The weekend cut-off only applies with
   `close_before_weekend`, which the grid does not use.
7. The gold reference invocation was not recorded. The output matches the default (clean-only) mode.
8. `analysis/` (repo, read only): the pristine copies do not contain `a3/symbols.py`. `b2_core` now imports it from
   `<study>/a3`. The saved diff applies to the pristine copies, but they need that file before the code runs.
9. The `-I` suite invocation is a wrapper that adds the test directory to `sys.path`, not a change to the tests.
10. Synthetic scale tests use a generator I wrote (`gen/scratch/exp_scale.py`, same as `test_symbols.py`). They do not
    use real market data.

## Could not do

- No real EURUSD or USDJPY data was downloaded or used. The brief did not ask for it, and disk has about 6 GB free.
  All FX results are synthetic.
- No FX signal universe exists. `oos2_build.py` is XAUUSD-only.
- Vantage symbol specs (SYMBOL_INFO) were not read. The spec module says they must be read through the read-only bridge.
- XAGUSD was not tested (not in the brief).
- Each of the 56 decimal-scale mismatches was not verified individually as a tie; only one was.
- The E1/MID and 4-unit pattern is unexplained (see above).

## Other observations

- `analysis/a3/__pycache__/dukas_lib.cpython-312.pyc` was created at 03:21:41 in the repo analysis folder, during this
  session. None of my commands imported that folder's `dukas_lib` (every run used `study/` paths). I did not delete
  it. It may come from another process and is worth checking.
- No git command was run. No commits. No file under `worker/dist`, `.env`, or the services was touched.
