import sys, os, datetime as dt, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import fetch_hour, decode_hour, hour_path, PRICE_DIVISOR
RAW = sys.argv[1]
t = dt.datetime(2025, 9, 30, 10)
print(fetch_hour(t, RAW))
p = hour_path(RAW, t)
if os.path.exists(p) and os.path.getsize(p) > 0:
    rows = decode_hour(p, t)
    print('ticks', len(rows))
    print('first', rows[:3])
    print('last', rows[-2:])
    mids = [(b + a) / 2 / PRICE_DIVISOR for _, b, a, _, _ in rows]
    print('bid-ask min/max raw', min(r[1]-r[2] for r in rows), max(r[1]-r[2] for r in rows))
    print('mid range', min(mids), max(mids), 'median', st.median(mids))
    sp = [(a - b) / PRICE_DIVISOR for _, b, a, _, _ in rows]
    print('spread USD median', st.median(sp), 'max', max(sp))
