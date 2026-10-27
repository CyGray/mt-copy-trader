"""C2: were TP1 / SL already touched (BASE quotes, from the posting time) before the final edit? By edit-delay group."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, collections, datetime as dt
import numpy as np
import c2_ticks as T_
from c2_run import SCR, load_signals, H
sigs = {s['msg']: s for s in load_signals()}
uni = {r['message_id']: r for r in csv.DictReader(open(os.path.join(SCR, 'b1', 'signals_universe.csv')))}
a1 = {r['message_id']: r for r in csv.DictReader(open(os.path.join(SCR, 'a1', 'signals.csv')))}
store = T_.HourStore(max_hours=400)
def grp(m):
    d = float(uni[m]['edit_delay_s'])
    return 'A_0s' if d == 0 else ('B_le300' if d <= 300 else 'C_gt300')
rows = []
for m, s in sigs.items():
    if not s['clean']:
        continue
    ed = a1[m]['edit_date_utc']
    if not ed:
        continue
    te = int(dt.datetime.strptime(ed.replace('Z', ''), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    ts, a, b = store.window(s['t'], s['t'] + 72 * H)
    if len(ts) == 0 or s['tps'][0] is None:
        continue
    d = s['dir']
    x = (b if d > 0 else a) * d  # exit quote, flipped
    tp1 = d * s['tps'][0]; sl = d * s['sl']
    i_tp = np.flatnonzero(x >= tp1); i_sl = np.flatnonzero(x <= sl)
    t_tp = ts[i_tp[0]] if i_tp.size else None
    t_sl = ts[i_sl[0]] if i_sl.size else None
    rows.append(dict(msg=m, grp=grp(m), split=s['split'], tp1_before_edit=(t_tp is not None and t_tp < te),
                     sl_before_edit=(t_sl is not None and t_sl < te), tp1_hit=t_tp is not None,
                     sl_hit=t_sl is not None, sl_first=(t_sl is not None and (t_tp is None or t_sl < t_tp))))
json.dump(rows, open(os.path.join(SCR, 'c2', 'out', 'c2_edit_touch.json'), 'w'), default=bool)
for g in ['A_0s', 'B_le300', 'C_gt300']:
    rr = [r for r in rows if r['grp'] == g]
    n = len(rr)
    print(g, 'n', n, 'TP1 hit within 72h from posting %.2f' % np.mean([r['tp1_hit'] for r in rr]),
          'TP1 already hit BEFORE edit %.2f' % np.mean([r['tp1_before_edit'] for r in rr]),
          'SL hit before edit %.2f' % np.mean([r['sl_before_edit'] for r in rr]),
          'SL-first (72h) %.2f' % np.mean([r['sl_first'] for r in rr]))
