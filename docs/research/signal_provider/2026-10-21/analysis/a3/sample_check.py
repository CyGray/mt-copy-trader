import sys, os, datetime as dt, statistics as st, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import fetch_hour, decode_hour, hour_path, PRICE_DIVISOR
RAW = sys.argv[1]
hours = [dt.datetime(2026,9,24,14), dt.datetime(2026,6,10,10), dt.datetime(2025,11,1,12), dt.datetime(2025,11,2,22), dt.datetime(2025,11,3,9), dt.datetime(2026,2,2,1)]
for t in hours:
    t0=time.time()
    s = fetch_hour(t, RAW)
    p = hour_path(RAW, t)
    n = 0; med=None; sp=None
    if s[0] in ('ok','cached'):
        rows = decode_hour(p, t); n=len(rows)
        if rows:
            mids=[(b+a)/2/PRICE_DIVISOR for _,b,a,_,_ in rows]
            spr=[(a-b)/PRICE_DIVISOR for _,b,a,_,_ in rows]
            med=round(st.median(mids),3); sp=round(st.median(spr),3)
            sorted_ok = all(rows[i][0] <= rows[i+1][0] for i in range(len(rows)-1))
    print(t.isoformat(), s, 'ticks',n,'mid_med',med,'spread_med',sp, 'sec', round(time.time()-t0,1))
