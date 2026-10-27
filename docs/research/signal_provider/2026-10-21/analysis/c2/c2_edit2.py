"""C2: what differs for late-edited signals: TP count, TP/SL placement vs market at posting and at edit."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, collections
import numpy as np
from c2_run import SCR, load_signals
sigs = {s['msg']: s for s in load_signals()}
uni = {r['message_id']: r for r in csv.DictReader(open(os.path.join(SCR, 'b1', 'signals_universe.csv')))}
pr = {r['msg']: r for r in json.load(open(os.path.join(SCR, 'c2', 'out', 'c2_posting_rows.json')))}
cl = [m for m in sigs if sigs[m]['clean']]
def grp(m):
    d = float(uni[m]['edit_delay_s'])
    return 'A_0s' if d == 0 else ('B_le300' if d <= 300 else 'C_gt300')
for g in ['A_0s', 'B_le300', 'C_gt300']:
    ms = [m for m in cl if grp(m) == g]
    ntp = collections.Counter(sum(1 for t in sigs[m]['tps'] if t is not None) for m in ms)
    tp1p = [(sigs[m]['tps'][0] - pr[m]['mid_mkt_post']) * sigs[m]['dir'] for m in ms if sigs[m]['tps'][0] and pr[m]['mid_mkt_post']]
    tp1e = [(sigs[m]['tps'][0] - pr[m]['mid_mkt_edit']) * sigs[m]['dir'] for m in ms if sigs[m]['tps'][0] and pr[m]['mid_mkt_edit']]
    slp = [abs(sigs[m]['sl'] - sigs[m]['mid']) for m in ms]
    print(g, 'n', len(ms), 'num_tps', dict(sorted(ntp.items())), 'median TP1 beyond mkt@post %.2f' % np.median(tp1p),
          'median TP1 beyond mkt@edit %.2f' % np.median(tp1e), 'median |SL-mid| %.2f' % np.median(slp),
          'median TP1-mid %.2f' % np.median([abs(sigs[m]['tps'][0]-sigs[m]['mid']) for m in ms if sigs[m]['tps'][0]]))
# edit delay distribution and split of late edits in time
ed = [float(uni[m]['edit_delay_s']) for m in cl]
print('edit delay quantiles (s): p50 %.0f p75 %.0f p90 %.0f max %.0f' % tuple(np.percentile(ed, [50, 75, 90, 100])))
# message-level: which edits changed the TP list? look at edit ts vs signal ts for late
late = [m for m in cl if grp(m) == 'C_gt300']
print('late examples (msg, delay_s, dir, entry, sl, tp1..tp4):')
for m in late[:8]:
    s = sigs[m]
    print('  ', m, uni[m]['edit_delay_s'], s['dir'], s['low'], s['sl'], s['tps'][:4])
