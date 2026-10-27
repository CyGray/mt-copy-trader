"""C2: trades whose result changes when a breach must persist (2 ticks or 1 s) vs the primary MID E2 (no guard)."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, collections
from c2_run import OUT, load_signals
sig = {s['msg']: s for s in load_signals()}
def load(fn):
    d = {}
    for r in csv.DictReader(open(os.path.join(OUT, fn))):
        d[(r['variant'], r['msg'], r['strat'])] = r
    return d
core = load('c2_trades_core.csv'); sens = load('c2_trades_sens.csv')
allt = {**core, **sens}
res = {}
for v in ['MID_E2_noguard_persist2tk', 'MID_E2_noguard_persist1s']:
    flips = []
    cnt = collections.Counter()
    for (vv, m, st), r in allt.items():
        if vv != v or r['status'] != 'OK' or not sig[m]['clean']:
            continue
        b = allt.get(('MID_E2_noguard', m, st))
        if not b or b['status'] != 'OK':
            continue
        x, y = float(b['R']), float(r['R'])
        cnt[st] += 1
        if (x > 0) != (y > 0) or abs(y - x) > 0.5:
            flips.append(dict(msg=m, strat=st, split=sig[m]['split'], base_R=round(x, 3), persist_R=round(y, 3),
                              base_legs=b['legs'], persist_legs=r['legs']))
    res[v] = dict(compared=dict(cnt), flips=len(flips), flip_list=flips)
    print(v, 'flips by strat', collections.Counter(f['strat'] for f in flips))
    print('   flips by split', collections.Counter(f['split'] for f in flips))
json.dump(res, open(os.path.join(OUT, 'c2_spike_flips.json'), 'w'), indent=1)
for v in res:
    for f in res[v]['flip_list'][:6]:
        print(v, f['msg'], f['strat'], f['split'], 'base', f['base_R'], 'persist', f['persist_R'])
