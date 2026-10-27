"""C2: H2 (pre-registered): prior-4h Kaufman efficiency ratio (ER) terciles, cut points fixed on TRAIN clean signals.
ER = |mid(t) - mid(t-4h)| / sum |diff mid| over 48 five-minute bins (last tick before each bin edge). Own implementation."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os
import numpy as np
import c2_ticks as T_
from c2_run import OUT, load_signals
sigs = load_signals()
store = T_.HourStore(max_hours=300)
BIN = 300000; NB = 48
er = {}
for s in sigs:
    if not s['clean']:
        continue
    t = s['t']
    ts, a, b = store.window(t - NB * BIN - 1000, t - 1)
    if len(ts) < 10:
        er[s['msg']] = None
        continue
    mid = (a + b) / 2.0
    edges = (t - NB * BIN) + BIN * np.arange(NB + 1)
    idx = np.searchsorted(ts, edges, 'right') - 1
    ok = idx >= 0
    if ok.sum() < NB + 1:
        er[s['msg']] = None
        continue
    m = mid[idx]
    path = np.abs(np.diff(m)).sum()
    er[s['msg']] = float(abs(m[-1] - m[0]) / path) if path > 0 else None
train = [er[s['msg']] for s in sigs if s['clean'] and s['split'] == 'TRAIN' and er.get(s['msg']) is not None]
lo, hi = np.percentile(train, [33.333, 66.667])
print('ER terciles on TRAIN (n=%d): low cut %.4f high cut %.4f' % (len(train), lo, hi))
TR = {}
for fn in ('c2_trades_core.csv',):
    for r in csv.DictReader(open(os.path.join(OUT, fn))):
        TR[(r['variant'], r['msg'], r['strat'])] = r
out = {}
for v in ('MID_E1_FT',):
    for sp in ('TRAIN', 'VALID', 'OOS'):
        hiR, loR = [], []
        for s in sigs:
            if not s['clean'] or s['split'] != sp or er.get(s['msg']) is None:
                continue
            r = TR.get((v, s['msg'], 'S_TP4|M0'))
            if not r or r['status'] != 'OK':
                continue
            if er[s['msg']] >= hi:
                hiR.append(float(r['R']))
            elif er[s['msg']] <= lo:
                loR.append(float(r['R']))
        d = (np.mean(hiR) - np.mean(loR)) if hiR and loR else float('nan')
        rng = np.random.default_rng(42)
        a_ = np.array(hiR); b_ = np.array(loR)
        bs = a_[rng.integers(0, len(a_), (10000, len(a_)))].mean(1) - b_[rng.integers(0, len(b_), (10000, len(b_)))].mean(1)
        out[sp] = dict(trend_n=len(hiR), range_n=len(loR), trend_mean=round(float(a_.mean()), 3), range_mean=round(float(b_.mean()), 3),
                       diff=round(float(d), 3), ci95=[round(float(x), 2) for x in np.percentile(bs, [2.5, 97.5])])
json.dump(dict(cut_low=lo, cut_high=hi, results=out), open(os.path.join(OUT, 'c2_h2.json'), 'w'), indent=1)
print(json.dumps(out, indent=1))
