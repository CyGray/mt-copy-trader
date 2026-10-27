# b1 - tick simulation engine and baseline (ByTrader signal study)

Read-only research code. Nothing here touches Telegram, Firestore, the broker, worker/dist or the services.
Run everything with `nice -n 10 python3 -I <script>` from this directory (numpy is loaded from the user
site, which `-I` hides; `sim_engine.py` appends that path itself).

## Files
- `sim_engine.py`: the engine (API below). Import it as `import sim_engine as se`.
- `test_sim_engine.py`: 35 unit tests on tiny synthetic tick series (plus a random-walk cross-check and a bi5 decode round-trip).
- `build_cache.py`: decodes A3's bi5 hours into `cache/` (one .npy per hour, ~970 MB) and writes `hour_index.csv`, `qc_summary.json`.
- `prepare_signals.py`: builds `signals_universe.csv` (415 signals, hard/info quality flags, `in_clean`).
- `run_analysis.py`: entry scenarios, baseline first touches, strategy variants -> `baseline_outcomes*.csv`, `strategy_outcomes.csv`, `results.json`.
- `stats.py`: every table in the report -> `tables.md`, `summary.json`.
- `verify_independent.py`: pure-Python re-decode of raw bi5 + tick-by-tick loop (30-signal sample, seed 42) -> `verify_report.json`.
- `verify_lookahead.py`: engine run with the window starting at signal time vs. at signal time + latency.
- `bench_variants.py`: timing (ms per simulate call).
- `REPORT.md`: the final report.

## Engine API (sim_engine.py)
```python
import sim_engine as se
store = se.TickStore(raw_dir, cache_dir)                   # A3 raw layout; decodes + caches hours
win = se.load_window(store, t_ms, t_ms + 80*3600_000)       # ticks; win.known_until / win.truncated
mk = se.Market(win, 'buy'|'sell', extra_spread_total)       # executable prices, first-touch cache
sig = se.Signal(msg_id, t_ms, direction, entry_low, entry_high, sl, [tp1, tp2, ..., tp7])  # None for missing TPs
ep = se.EntryParams('P1'|'P2'|'P3', latency_s, tol, expiry_min, extra_spread, slippage)
fill = se.decide_entry(sig, ep, mk)                         # Fill.status: FILLED | SKIPPED_* | NO_PRICE_DATA
strat = se.Strategy(name,
    checkpoints=((tp_index, close_pct), ...),               # pct + runner_pct = 100
    runner_pct=0.0,                                         # remainder with no TP (SL/BE/trail/horizon)
    close_all_at=None,                                      # tp_index at which all remaining volume closes
    missing_tp='merge_into_last_available'|'skip_trade',
    infeasible_split='merge_into_next'|'skip_trade',
    units='fraction'|'lots', total_lots=0.10, volume_min=0.01, volume_step=0.01,   # lot-rounded splits (project rule)
    sl_after=((after_tp_index, 'entry'|'previous_tp', buffer_usd), ...),
    break_even=None | ('after_tp', k, buffer) | ('price', distance, buffer),
    trailing=None | (('after_tp', k) | ('price', distance), distance, step),
    horizon_h=72.0, close_before_weekend=False,             # Friday 20:45 UTC cut-off
    manage_latency_s=0.0,                                   # delay for SL moves (BE / sl_after / trail)
    broker_tp='final_checkpoint')                           # recorded only; identical fills in the tick model
res = se.simulate(sig, fill, strat, mk, conv=se.Conventions(contract_oz=100.0), slip=ep.slippage)
out = se.baseline_touch(sig, fill, mk, horizon_h=72.0)     # provider-as-is first touches, no management
```
`res` keys: `status, reason, outcome (WIN|LOSS|FLAT|UNRESOLVED_MTM), exit_seq, final_exit, total_R, usd_per_1lot,
exits [(kind, ms, price, fraction)], min_to_first_tp, min_to_stop, bars_to_resolution, max_tick_gap_min,
mae_*/mfe_* (USD and R, pre-first-exit and overall), same_tick_ambiguity, flags, horizon_reason`.
Exit kinds: `TP<k>`, `SL`, `BE`, `SL_PREV_TP`, `TRAIL`, `MTM`, `TP_COMPLETE`.

## Conventions (see the module docstring)
- extra_spread E is the total widening: ask+E/2, bid-E/2. Entries use ask (BUY) / bid (SELL); exits the opposite side.
- Stops fill at min(bid, SL) for BUY (max(ask, SL) for SELL), i.e. the tick when gapped. TP fills at the TP price.
- Slippage: adverse on market and pending entries and on stop exits; not on TP legs.
- Exit checks start at the tick after the fill; SL is checked before TP on a shared tick (flagged).
- Horizon marks open legs to the last tick before the horizon (UNRESOLVED_MTM). Ticks at or after `known_until`
  (first unknown hour) are never used; the result becomes NO_PRICE_DATA if not resolved before that.
- Position/PnL: fraction units (1.0 = whole position); `usd_per_1lot = sum(fraction * move) * contract_oz`.
  `contract_oz=100` is UNVERIFIED for Vantage XAUUSD. Swap is 0 (Unknown for Vantage).

## Tests
`python3 -I test_sim_engine.py` -> 35 tests, all pass (entry policies, latency, spread, slippage, SL gap, TP,
break-even (after TP and price distance), trailing (price and after TP), previous-TP SL moves, manage latency,
runner, close_all_at, lot splits, missing TP, weekend cut-off, horizon MTM, truncation, decoder, Wilson, drawdown,
and a 60-trial random-walk comparison against a plain tick loop).
