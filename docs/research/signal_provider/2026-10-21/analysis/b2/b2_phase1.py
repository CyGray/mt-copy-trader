"""PHASE 1 (exploration): simulate the full grid on TRAIN and VALIDATION clean signals only.
OOS signals are never loaded in this script. Writes out/phase1_*.csv(.gz) and per-split metric tables.
usage: nice -n 10 python3 -I b2_phase1.py
"""
import csv
import gzip
import multiprocessing as mp
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402
import b2_stats as st  # noqa: E402
import sim_engine_b2 as se  # noqa: E402

FILL_FIELDS = ['message_id', 't_ms', 'split', 'in_clean', 'direction', 'entry', 'cost', 'nominal_R', 'sl_dist_signal',
               'status', 'reason', 'fill_ms', 'fill_px', 'R_usd', 'kind']
TRADE_FIELDS = ['message_id', 't_ms', 'split', 'in_clean', 'direction', 'entry', 'cost', 'nominal_R', 'sl_dist_signal',
                'fill_ms', 'fill_px', 'R_usd', 'kind', 'variant', 'alloc', 'mgmt', 'family', 'status', 'reason',
                'total_R', 'usd_per_1lot', 'last_exit_ms', 'final_exit', 'exit_seq', 'tp_ks', 'mae_all_R', 'mfe_all_R',
                'mae_pre_R', 'mfe_pre_R', 'min_to_first_tp', 'min_to_stop', 'flags', 'horizon_reason']
_G = {}


def _init():
    _G['store'] = se.TickStore(c.RAW, c.CACHE, mem_hours=64)
    V = c.build_grid()
    for v in V:
        v['strategy'] = c.make_strategy(v)
    _G['V'] = V


def _work(sig):
    fr, tr = c.evaluate_signal(_G['store'], sig, _G['V'])
    return fr, tr


def main():
    t0 = time.time()
    sigs = c.load_signals()
    c.assign_splits(sigs)
    work = [s for s in sigs if s.meta['in_clean'] == 1 and s.meta['split'] in ('train', 'val')]
    assert all(s.meta['split'] != 'oos' for s in work)
    print('phase1 signals', len(work), 'train', sum(s.meta['split'] == 'train' for s in work),
          'val', sum(s.meta['split'] == 'val' for s in work), flush=True)
    V = c.build_grid()
    print('grid', c.grid_summary(V), flush=True)
    fills, trades = [], []
    with mp.Pool(2, initializer=_init) as pool:
        for i, (fr, tr) in enumerate(pool.imap(_work, work, chunksize=4)):
            fills += fr
            trades += tr
            if i % 50 == 0:
                print('done', i, round(time.time() - t0, 1), flush=True)
    with open(os.path.join(c.OUT, 'phase1_fills.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=FILL_FIELDS, extrasaction='ignore')
        w.writeheader()
        w.writerows(fills)
    with gzip.open(os.path.join(c.OUT, 'phase1_trades.csv.gz'), 'wt', newline='') as f:
        w = csv.DictWriter(f, fieldnames=TRADE_FIELDS, extrasaction='ignore')
        w.writeheader()
        w.writerows(trades)
    print('wrote fills', len(fills), 'trades', len(trades), round(time.time() - t0, 1), flush=True)


if __name__ == '__main__':
    main()
