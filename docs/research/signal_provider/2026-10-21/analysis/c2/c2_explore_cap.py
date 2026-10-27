"""C2 exploration: E1/E3 fill counts vs search cap (how long after latency the in-band tick may occur)."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import numpy as np, collections, json, os
import c2_ticks as T_
import c2_sim as S
from c2_run import load_signals, H
sigs = load_signals()
store = T_.HourStore(max_hours=600)
caps = {'first_tick_only': 0, '5s': 5000, '60s': 60000, '5min': 300000, '15min': 900000, '60min': 3600000, '6h': 6 * H, '72h': 72 * H}
res = collections.defaultdict(lambda: collections.Counter())
delays = {}
for sig in sigs:
    if not sig['clean']:
        continue
    ts, asks, bids = store.window(sig['t'] - 120000, sig['t'] + 147 * H)
    d = sig['dir']
    eq = asks if d > 0 else bids  # BASE, no spread
    i0 = int(np.searchsorted(ts, sig['t'] + 5000, 'left'))
    for tol, lab in ((0.5, 'E3tol0.5'), (2.0, 'E1tol2.0')):
        m = (eq >= sig['low'] - tol) & (eq <= sig['high'] + tol)
        idx = np.flatnonzero(m[i0:])
        first = (idx[0] + i0) if len(idx) else None
        delays[(sig['msg'], lab)] = None if first is None else (ts[first] - sig['t']) / 1000.0
        for cn, cms in caps.items():
            if cn == 'first_tick_only':
                ok = bool(m[i0])
            else:
                ok = first is not None and (ts[first] - sig['t'] - 5000) <= cms
            res[(lab, cn)][sig['split']] += int(ok)
for lab in ('E3tol0.5', 'E1tol2.0'):
    for cn in caps:
        c = res[(lab, cn)]
        print(lab, cn.ljust(16), 'TRAIN', c['TRAIN'], 'VALID', c['VALID'], 'OOS', c['OOS'], 'ALLclean', c['TRAIN'] + c['VALID'] + c['OOS'])
dl = [v for (m, lab), v in delays.items() if lab == 'E3tol0.5' and v is not None]
print('E3 delay to first in-band tick (s, from signal): quantiles 25/50/75/90:', np.percentile(dl, [25, 50, 75, 90]).round(1))
