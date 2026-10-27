"""C2 sizing/spread review. Spread distribution on the full tape (own decoder, every hour), spread at fills,
risk overshoot (fill distance vs sized nominal distance), and the repo sizing rule re-computed by hand."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, datetime as dt, collections, math
import numpy as np
import c2_ticks as T_
from c2_run import OUT, SCR, load_signals
store = T_.HourStore(max_hours=50)
start = int(dt.datetime(2025, 10, 30, tzinfo=dt.timezone.utc).timestamp() * 1000)
end = int(dt.datetime(2026, 9, 28, tzinfo=dt.timezone.utc).timestamp() * 1000)
edges = np.array([0, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 5.0, 1e9])
hist = np.zeros(len(edges) - 1, np.int64)
hourly_med = []
h = start
while h < end:
    st, t, a, b = store.get(h)
    if st == 'ok' and len(t):
        sp = a - b
        hist += np.histogram(sp, bins=edges)[0]
        hourly_med.append(float(np.median(sp)))
    h += T_.HOUR_MS
tot = hist.sum()
cum = np.cumsum(hist) / tot
spread_tape = dict(ticks=int(tot), share_by_bin=dict(zip([f'<{e}' for e in edges[1:]], [round(float(x), 5) for x in hist / tot])),
                   share_le_0p5=round(float(cum[1]), 4), share_le_1p0=round(float(cum[4]), 4),
                   hourly_median_spread_p50_p90=[round(float(x), 3) for x in np.percentile(hourly_med, [50, 90])])
print('TAPE', spread_tape, flush=True)
# spread at the fill ticks (E2 MID no-guard primary, E1 FT MID guard), and risk overshoot
sigs = {s['msg']: s for s in load_signals()}
ent = list(csv.DictReader(open(os.path.join(OUT, 'c2_entries_core.csv'))))
res = {}
for v in ('MID_E2_noguard', 'MID_E1_FT'):
    sp_f, over, dist_nom, dist_fill = [], [], [], []
    for r in ent:
        if r['variant'] != v or r['status'] != 'FILLED':
            continue
        s = sigs[r['msg']]
        if not s['clean']:
            continue
        ms = int(r['t_fill'])
        st, t, a, b = store.get(ms)
        k = int(np.searchsorted(t, ms, 'right')) - 1
        if k >= 0:
            sp_f.append(float(a[k] - b[k]))
        fill = float(r['fill_real'])
        nominal = abs(s['mid'] - s['sl']); realised = abs(fill - s['sl'])
        dist_nom.append(nominal); dist_fill.append(realised)
        over.append(realised / nominal if nominal > 0 else float('nan'))
    sp_f = np.array(sp_f); over = np.array(over); dist_fill = np.array(dist_fill); dist_nom = np.array(dist_nom)
    res[v] = dict(n=len(over), spread_at_fill_p50_p90=[round(float(x), 3) for x in np.percentile(sp_f, [50, 90])],
                  share_spread_le_0p5=round(float((sp_f <= 0.5).mean()), 3), share_spread_le_1p0=round(float((sp_f <= 1.0).mean()), 3),
                  fill_risk_dist_p10_p50_p90=[round(float(x), 2) for x in np.percentile(dist_fill, [10, 50, 90])],
                  nominal_dist_p10_p50_p90=[round(float(x), 2) for x in np.percentile(dist_nom, [10, 50, 90])],
                  overshoot_ratio_p50_p90_p99=[round(float(x), 2) for x in np.nanpercentile(over, [50, 90, 99])],
                  share_overshoot_gt1p2=round(float(np.nanmean(over > 1.2)), 3), share_overshoot_gt1p5=round(float(np.nanmean(over > 1.5)), 3),
                  share_fill_dist_le_3p125=round(float((dist_fill <= 3.125).mean()), 3), share_fill_dist_le_2=round(float((dist_fill <= 2.0).mean()), 3),
                  share_fill_dist_gt15=round(float((dist_fill > 15).mean()), 3), share_fill_dist_gt25=round(float((dist_fill > 25).mean()), 3))
json.dump(dict(tape=spread_tape, fills=res), open(os.path.join(OUT, 'c2_sizing_data.json'), 'w'), indent=1)
print('FILLS', json.dumps(res, indent=1), flush=True)
