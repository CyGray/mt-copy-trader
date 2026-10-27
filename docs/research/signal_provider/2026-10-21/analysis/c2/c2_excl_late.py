"""C2: strategy means with and without signals edited >300 s after posting (post-outcome edit timing), per split."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os
import numpy as np
from c2_run import OUT, SCR, load_signals
sigs = {s['msg']: s for s in load_signals()}
uni = {r['message_id']: r for r in csv.DictReader(open(os.path.join(SCR, 'b1', 'signals_universe.csv')))}
TR = {}
for fn in ('c2_trades_core.csv', 'c2_trades_sens.csv', 'c2_trades_extra.csv'):
    for r in csv.DictReader(open(os.path.join(OUT, fn))):
        TR[(r['variant'], r['msg'], r['strat'])] = r
late = {m for m in sigs if sigs[m]['clean'] and float(uni[m]['edit_delay_s']) > 300}
out = {}
for v in ('MID_E2_noguard', 'MID_E1_FT', 'BASE_E2_noguard'):
    for st in ('S_TP1|M0', 'S_TP3|M0', 'S_TP4|M0', 'S_TP4|M5', 'Q_25x4|M0', 'Q_25x4|M3', 'S_TP4FB|M0'):
        for sp in ('TRAIN', 'VALID', 'OOS', 'ALL'):
            allm = [m for m in sigs if sigs[m]['clean'] and (sp == 'ALL' or sigs[m]['split'] == sp)]
            rows = {m: float(TR[(v, m, st)]['R']) for m in allm if (v, m, st) in TR and TR[(v, m, st)]['status'] == 'OK'}
            ex = [x for m, x in rows.items() if m not in late]
            lt = [x for m, x in rows.items() if m in late]
            rng = np.random.default_rng(42)
            if len(ex) > 1:
                b = np.array(ex); ci = np.percentile(b[rng.integers(0, len(b), (10000, len(b)))].mean(1), [2.5, 97.5])
            else:
                ci = [float('nan'), float('nan')]
            out[f'{v} {st} {sp}'] = dict(n_all=len(rows), mean_all=round(float(np.mean(list(rows.values()))), 3) if rows else None,
                                         n_late=len(lt), mean_late=round(float(np.mean(lt)), 3) if lt else None,
                                         n_early=len(ex), mean_early=round(float(np.mean(ex)), 3) if ex else None,
                                         early_ci95=[round(float(ci[0]), 2), round(float(ci[1]), 2)])
json.dump(out, open(os.path.join(OUT, 'c2_excl_late.json'), 'w'), indent=1)
for k, d in out.items():
    if k.startswith('MID_E2_noguard') and (k.endswith('OOS') or k.endswith('ALL')):
        print(k, d)
for k, d in out.items():
    if k.startswith('MID_E1_FT') and k.endswith('OOS') and ('S_TP4|M0' in k or 'S_TP1' in k):
        print(k, d)
