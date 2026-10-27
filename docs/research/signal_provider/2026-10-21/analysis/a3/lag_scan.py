"""Timezone/timestamp check: for each signal, distance |entry_mid - market_mid(t+lag)| for lags in +/-15 min.
usage: lag_scan.py RAWDIR DERIVED_DIR. Writes derived/lag_scan.csv and prints the best lag.
"""
import sys, os, csv, statistics as st, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import window_ticks
RAW, DER = sys.argv[1], sys.argv[2]
P = 1000.0
rows = list(csv.DictReader(open(os.path.join(DER, 'signals_a3.csv'), encoding='utf-8')))
def ms_of(s): return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)
def mid_near(t, tol=30000):
    # nearest tick mid within tol of t (fast: scan a 60s window around t)
    best = None
    for ts, b, a in window_ticks(RAW, t - tol, t + tol):
        d = abs(ts - t)
        if best is None or d < best[0]:
            best = (d, (a + b) / 2 / P)
    return None if best is None else best[1]
lags = list(range(-900, 901, 60))
data = []
for r in rows:
    t = ms_of(r['date_utc'])
    lo = float(r['reparse_entry_low']); hi = float(r['reparse_entry_high']); emid = (lo + hi) / 2
    mids = {}
    for L in lags:
        mids[L] = mid_near(t + L * 1000)
    data.append((r['msg_id'], r['direction'], emid, mids))
res = []
for L in lags:
    diffs = [abs(e - m[L]) for _, _, e, m in data if m[L] is not None]
    if diffs:
        res.append((L, st.median(diffs), len(diffs)))
print('lag_s  median_abs_USD  n')
for L, md, n in res:
    print(f'{L:6d}  {md:8.3f}  {n}')
best = min(res, key=lambda x: x[1])
print('best lag (s):', best[0], 'median abs', round(best[1], 3))
with open(os.path.join(DER, 'lag_scan.csv'), 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['lag_s', 'median_abs_usd', 'n'])
    for x in res: w.writerow([x[0], round(x[1], 4), x[2]])
