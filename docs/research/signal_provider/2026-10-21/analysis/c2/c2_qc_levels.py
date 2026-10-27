"""C2 QC: decode every hour once (own decoder), daily median mid, and compare provider entry_mid by day."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import c2_ticks as T
import csv, datetime as dt, json, os
import numpy as np
S = T.SCRATCH
store = T.HourStore(max_hours=50)
start = int(dt.datetime(2025, 10, 30, tzinfo=dt.timezone.utc).timestamp() * 1000)
end = int(dt.datetime(2026, 9, 28, tzinfo=dt.timezone.utc).timestamp() * 1000)
daily = {}
hours_ok = hours_empty = 0
h = start
while h < end:
    st, t, a, b = store.get(h)
    if st == 'ok':
        hours_ok += 1
        day = dt.datetime.fromtimestamp(h / 1000, dt.timezone.utc).strftime('%Y-%m-%d')
        mid = (a + b) / 2
        daily.setdefault(day, []).append(np.median(mid))
    elif st == 'empty':
        hours_empty += 1
    else:
        print('MISSING', dt.datetime.fromtimestamp(h/1000, dt.timezone.utc).isoformat())
    h += T.HOUR_MS
print('hours ok', hours_ok, 'empty', hours_empty, 'decoded', store.decoded, 'missing', len(store.missing))
out = {d: float(np.median(v)) for d, v in daily.items()}
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'c2_daily_median_mid.json'), 'w'), indent=0)
# compare provider entry_mid with own market median of same day (+-same day)
rows = list(csv.DictReader(open(os.path.join(S, 'b1', 'signals_universe.csv'))))
diffs = []
for r in rows:
    d = dt.datetime.fromtimestamp(int(r['t_ms']) / 1000, dt.timezone.utc).strftime('%Y-%m-%d')
    if d in out:
        diffs.append((float(r['entry_mid']) - out[d], r['direction'], r['message_id'], d))
arr = np.array([x[0] for x in diffs])
print('signals with same-day market:', len(diffs), 'median(entry_mid - daily market median)=%.2f' % np.median(arr))
print('abs diff quantiles 10/50/90/99:', np.percentile(np.abs(arr), [10, 50, 90, 99]).round(2))
big = sorted(diffs, key=lambda x: -abs(x[0]))[:8]
print('largest day-level gaps:', [(round(x[0],1), x[1], x[2], x[3]) for x in big])
