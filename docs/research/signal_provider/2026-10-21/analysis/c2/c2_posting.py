"""C2: provider entry level vs market at posting (date_utc) and at final edit (edit_date_utc). Own decoder."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, datetime as dt
import numpy as np
import c2_ticks as T_
from c2_run import load_signals
sigs = load_signals()
a1 = {r['message_id']: r for r in csv.DictReader(open(os.path.join(T_.SCRATCH, 'a1', 'signals.csv')))}
uni = {r['message_id']: r for r in csv.DictReader(open(os.path.join(T_.SCRATCH, 'b1', 'signals_universe.csv')))}
store = T_.HourStore(max_hours=600)

def mid_at(t_ms):
    ts, a, b = store.window(t_ms - 3 * 3600_000, t_ms)
    if len(ts) == 0:
        return None
    return float((a[-1] + b[-1]) / 2.0), int(t_ms - ts[-1])

rows = []
for s in sigs:
    r = a1[s['msg']]
    m_post = mid_at(s['t'])
    ed = r['edit_date_utc']
    m_edit = None
    if ed:
        et = int(dt.datetime.strptime(ed.replace('Z', ''), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
        m_edit = mid_at(et)
    edit_delay = float(uni[s['msg']]['edit_delay_s']) if uni[s['msg']]['edit_delay_s'] not in ('', None) else None
    rows.append(dict(msg=s['msg'], dir=s['dir'], clean=s['clean'], split=s['split'], mid_mkt_post=m_post[0] if m_post else None,
                     age_post_s=m_post[1] / 1000 if m_post else None, mid_mkt_edit=m_edit[0] if m_edit else None,
                     entry_mid=s['mid'], edit_delay_s=edit_delay))
json.dump(rows, open(os.path.join(T_.SCRATCH, 'c2', 'out', 'c2_posting_rows.json'), 'w'))

def summ(sel, key):
    out = {}
    for d, nm in ((1, 'BUY'), (-1, 'SELL')):
        vals = [x['entry_mid'] - x[key] for x in sel if x['dir'] == d and x[key] is not None]
        if not vals:
            continue
        vals = np.array(vals)
        fav = (vals < 0).mean() if d > 0 else (vals > 0).mean()  # BUY favourable = entry below market; SELL = above
        out[nm] = dict(n=len(vals), median_entry_minus_mkt=round(float(np.median(vals)), 2), favourable_share=round(float(fav), 3),
                       med_abs=round(float(np.median(np.abs(vals))), 2), p90_abs=round(float(np.percentile(np.abs(vals), 90)), 1))
    return out

print('POSTING (date_utc) all 415:', summ(rows, 'mid_mkt_post'))
print('POSTING clean 406:', summ([x for x in rows if x['clean']], 'mid_mkt_post'))
print('EDIT time (edit_date_utc) clean:', summ([x for x in rows if x['clean']], 'mid_mkt_edit'))
ages = np.array([x['age_post_s'] for x in rows if x['age_post_s'] is not None])
print('age of last tick at posting (s): median %.1f p90 %.1f max %.1f' % (np.median(ages), np.percentile(ages, 90), ages.max()))
