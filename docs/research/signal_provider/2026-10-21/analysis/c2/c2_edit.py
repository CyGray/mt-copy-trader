"""C2: edit-time bias. Late-edited (>300 s) vs early-edited clean signals; level-vs-market at posting and at edit."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, collections
import numpy as np
from c2_run import OUT, SCR, load_signals
sigs = {s['msg']: s for s in load_signals()}
uni = {r['message_id']: r for r in csv.DictReader(open(os.path.join(SCR, 'b1', 'signals_universe.csv')))}
pr = {r['msg']: r for r in json.load(open(os.path.join(SCR, 'c2', 'out', 'c2_posting_rows.json')))}
TR = {}
for r in csv.DictReader(open(os.path.join(OUT, 'c2_trades_core.csv'))):
    TR[(r['variant'], r['msg'], r['strat'])] = r
cl = [m for m in sigs if sigs[m]['clean']]

def grp(m):
    d = float(uni[m]['edit_delay_s'])
    return 'A_0s' if d == 0 else ('B_le300' if d <= 300 else 'C_gt300')

c = collections.Counter((grp(m), sigs[m]['split']) for m in cl)
print('group x split (clean):', dict(sorted(c.items())))
for g in ['A_0s', 'B_le300', 'C_gt300']:
    ms = [m for m in cl if grp(m) == g]
    dp = [(sigs[m]['mid'] - pr[m]['mid_mkt_post']) * sigs[m]['dir'] * -1 for m in ms if pr[m]['mid_mkt_post'] is not None]
    de = [(sigs[m]['mid'] - pr[m]['mid_mkt_edit']) * sigs[m]['dir'] * -1 for m in ms if pr[m]['mid_mkt_edit'] is not None]
    print(g, 'n', len(ms), 'median |level-mkt| at posting %.2f' % np.median(np.abs(dp)), 'at edit %.2f' % np.median(np.abs(de)),
          'favourable offset median posting %.2f edit %.2f' % (np.median(dp), np.median(de)))
rng = np.random.default_rng(42)
v = 'MID_E2_noguard'
for st in ['S_TP1|M0', 'S_TP4|M0', 'S_TP4FB|M0']:
    a = np.array([float(TR[(v, m, st)]['R']) for m in cl if grp(m) == 'C_gt300' and (v, m, st) in TR and TR[(v, m, st)]['status'] == 'OK'])
    b = np.array([float(TR[(v, m, st)]['R']) for m in cl if grp(m) != 'C_gt300' and (v, m, st) in TR and TR[(v, m, st)]['status'] == 'OK'])
    ia = rng.integers(0, len(a), (10000, len(a))); ib = rng.integers(0, len(b), (10000, len(b)))
    diff = a[ia].mean(1) - b[ib].mean(1)
    print(st, 'late n', len(a), 'mean %.3f' % a.mean(), '| early n', len(b), 'mean %.3f' % b.mean(),
          '| diff 95%% CI [%.2f, %.2f]' % tuple(np.percentile(diff, [2.5, 97.5])))
    for sp in ['TRAIN', 'VALID', 'OOS']:
        aa = [float(TR[(v, m, st)]['R']) for m in cl if grp(m) == 'C_gt300' and sigs[m]['split'] == sp and (v, m, st) in TR and TR[(v, m, st)]['status'] == 'OK']
        bb = [float(TR[(v, m, st)]['R']) for m in cl if grp(m) != 'C_gt300' and sigs[m]['split'] == sp and (v, m, st) in TR and TR[(v, m, st)]['status'] == 'OK']
        print('    split', sp, 'late n', len(aa), ('mean %.3f' % np.mean(aa)) if aa else '-', '| early n', len(bb), ('mean %.3f' % np.mean(bb)) if bb else '-')
