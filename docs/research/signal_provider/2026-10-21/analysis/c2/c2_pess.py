"""C2: PESS cost scenario (spread 0.20, slip 0.10, latency 15 s) summary by split, compared with B2 section 8.2 (OOS)."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, os
import numpy as np
from c2_run import OUT, load_signals
sigs = {s['msg']: s for s in load_signals()}
TR = {}
for r in csv.DictReader(open(os.path.join(OUT, 'c2_trades_extra2.csv'))):
    TR[(r['variant'], r['msg'], r['strat'])] = r
EN = {}
for r in csv.DictReader(open(os.path.join(OUT, 'c2_entries_extra2.csv'))):
    EN[(r['variant'], r['msg'])] = r
for v in ['PESS_E1_FT', 'PESS_E2_noguard_pendslip', 'PESS_E3_FT']:
    fills = [m for (vv, m), r in EN.items() if vv == v and r['status'] == 'FILLED' and sigs[m]['clean']]
    print(v, 'fills', {sp: sum(1 for m in fills if sigs[m]['split'] == sp) for sp in ['TRAIN', 'VALID', 'OOS']})
    for st in ['S_TP1|M0', 'S_TP4|M0', 'S_TP4|M5']:
        for sp in ['TRAIN', 'VALID', 'OOS']:
            x = [float(TR[(v, m, st)]['R']) for m in fills if sigs[m]['split'] == sp and (v, m, st) in TR and TR[(v, m, st)]['status'] == 'OK']
            if x:
                print('   ', st, sp, 'n', len(x), 'mean %.3f' % np.mean(x))
