"""PHASE 2 (one-time OOS evaluation of the frozen finalists + benchmark). Refuses to run unless out/finalists.json
exists and its sha256 matches its content, and refuses to run twice (lock file). Evaluates OOS clean signals
(E1, E2 optimised; E3 descriptive) and the 9 hard-flagged signals (ALL-universe sensitivity, OOS-split only).
usage: nice -n 10 python3 -I b2_phase2_oos.py
"""
import csv
import gzip
import hashlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402
import b2_tables as bt  # noqa: E402
import sim_engine_b2 as se  # noqa: E402
import b2_phase1 as p1  # noqa: E402

LOCK = os.path.join(c.OUT, 'oos_evaluated.lock')


def verify_freeze():
    path = os.path.join(c.OUT, 'finalists.json')
    fin = json.load(open(path))
    sha = fin.pop('sha256_of_body')
    calc = hashlib.sha256(json.dumps(fin, sort_keys=True, indent=1).encode()).hexdigest()
    assert calc == sha, 'finalists.json was modified after freezing'
    return fin, sha


def main():
    if os.path.exists(LOCK):
        raise SystemExit('OOS already evaluated (lock present). Refusing to re-run.')
    fin, sha = verify_freeze()
    names = [d['variant'] for d in fin['finalists']] + [fin['benchmark']]
    V = [v for v in c.build_grid() if v['name'] in names]
    assert len(V) == len(names), names
    for v in V:
        v['strategy'] = c.make_strategy(v)
    open(LOCK, 'w').write(json.dumps(dict(sha=sha, variants=names, started=time.time())))
    sigs = c.load_signals()
    c.assign_splits(sigs)
    oos = [s for s in sigs if s.meta['split'] == 'oos' and s.meta['in_clean'] == 1]
    flagged_oos = [s for s in sigs if s.meta['split'] == 'oos' and s.meta['in_clean'] == 0]
    flagged_all = [s for s in sigs if s.meta['in_clean'] == 0]
    store = se.TickStore(c.RAW, c.CACHE, mem_hours=64)
    fills, trades = [], []
    for s in oos:
        fr, tr = c.evaluate_signal(store, s, V)
        fills += fr
        trades += tr
    print('OOS clean signals', len(oos), 'fills', len(fills), 'trade rows', len(trades), flush=True)
    with open(os.path.join(c.OUT, 'oos_fills.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=p1.FILL_FIELDS, extrasaction='ignore')
        w.writeheader(); w.writerows(fills)
    with gzip.open(os.path.join(c.OUT, 'oos_trades.csv.gz'), 'wt', newline='') as f:
        w = csv.DictWriter(f, fieldnames=p1.TRADE_FIELDS, extrasaction='ignore')
        w.writeheader(); w.writerows(trades)
    # ALL-universe sensitivity: the 9 hard-flagged signals, in their time split (OOS-split ones evaluated here)
    fl_fills, fl_trades = [], []
    for s in flagged_all:
        fr, tr = c.evaluate_signal(store, s, V)
        fl_fills += fr
        fl_trades += tr
    with gzip.open(os.path.join(c.OUT, 'flagged_trades.csv.gz'), 'wt', newline='') as f:
        w = csv.DictWriter(f, fieldnames=p1.TRADE_FIELDS, extrasaction='ignore')
        w.writeheader(); w.writerows(fl_trades)
    with open(os.path.join(c.OUT, 'flagged_fills.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=p1.FILL_FIELDS, extrasaction='ignore')
        w.writeheader(); w.writerows(fl_fills)
    print('flagged signals', len(flagged_all), 'oos-split flagged', len(flagged_oos), flush=True)
    print('done', flush=True)


if __name__ == '__main__':
    main()
