"""C2: H1 (SELL minus BUY mean R under top finalist E1 MID S_TP4|M0; TRAIN, VALID, OOS) and B2-style block-5 DD on OOS."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os
import numpy as np
from c2_run import OUT, load_signals
sigs = {s['msg']: s for s in load_signals()}
TR = {}
for fn in ('c2_trades_core.csv', 'c2_trades_sens.csv', 'c2_trades_extra.csv'):
    for r in csv.DictReader(open(os.path.join(OUT, fn))):
        TR[(r['variant'], r['msg'], r['strat'])] = r
def rs(v, st, sp):
    out = []
    for m, s in sigs.items():
        if not s['clean'] or (sp != 'ALL' and s['split'] != sp):
            continue
        r = TR.get((v, m, st))
        if r and r['status'] == 'OK':
            out.append((s['dir'], float(r['R']), int(r['t_fill'])))
    return out
res = {}
for v in ('MID_E1_FT', 'MID_E2_noguard_pendslip'):
    for st in ('S_TP4|M0',):
        for sp in ('TRAIN', 'VALID', 'OOS'):
            x = rs(v, st, sp)
            sell = [r for d, r, _ in x if d < 0]; buy = [r for d, r, _ in x if d > 0]
            diff = np.mean(sell) - np.mean(buy)
            rng = np.random.default_rng(42)
            a = np.array(sell); b = np.array(buy)
            bs = a[rng.integers(0, len(a), (10000, len(a)))].mean(1) - b[rng.integers(0, len(b), (10000, len(b)))].mean(1)
            res[f'H1 {v} {st} {sp}'] = dict(n_sell=len(sell), n_buy=len(buy), mean_sell=round(float(a.mean()), 3), mean_buy=round(float(b.mean()), 3),
                                              diff=round(float(diff), 3), ci95=[round(float(x), 2) for x in np.percentile(bs, [2.5, 97.5])])
# B2-style block-5 DD (blocks of 5 trades in exit order, 10k resamples, seed 42) vs iid, OOS, E2 pendslip (B2 engine) and E1 MID
def mdd(x):
    eq = np.concatenate([[0.0], np.cumsum(x)])
    return float((np.maximum.accumulate(eq) - eq).max())
def block_p95(x, block, nb=10000, seed=42):
    rng = np.random.default_rng(seed)
    n = len(x); nbk = int(np.ceil(n / block))
    dds = np.empty(nb)
    for i in range(nb):
        starts = rng.integers(0, n - block + 1, nbk)
        idx = (starts[:, None] + np.arange(block)[None, :]).reshape(-1)[:n]
        dds[i] = mdd(x[idx])
    return float(np.percentile(dds, 95)), float(np.percentile(dds, 99))
for v in ('MID_E2_noguard_pendslip', 'MID_E1_FT'):
    for st in ('S_TP1|M0', 'S_TP4|M0', 'S_TP4|M5', 'Q_25x4|M3'):
        x = rs(v, st, 'OOS')
        x = np.array([r for _, r, _ in sorted(x, key=lambda t: t[2])])
        if len(x) == 0:
            continue
        p95b, p99b = block_p95(x, 5, nb=3000)
        res[f'DD {v} {st} OOS'] = dict(n=len(x), mean=round(float(x.mean()), 3), closed_dd=round(mdd(x), 2),
                                        block5_p95=round(p95b, 2), block5_p99=round(p99b, 2))
json.dump(res, open(os.path.join(OUT, 'c2_h1_block.json'), 'w'), indent=1)
for k, d in res.items():
    print(k, d)
