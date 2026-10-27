"""Outlier check: for consecutive-tick mid jumps >= 5 USD, does the mid revert to within 1 USD of the
pre-jump mid within 60 s? usage: jump_reversion.py RAWDIR DERIVED_DIR"""
import sys, os, csv, datetime as dt, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import window_ticks
RAW, DER = sys.argv[1], sys.argv[2]
P = 1000.0
rows = [r for r in csv.DictReader(open(os.path.join(DER, 'big_moves.csv'))) if float(r['jump_usd']) >= 5]
rev = 0; res = []
for r in rows:
    t = dt.datetime.strptime(r['tick_utc'], '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=dt.timezone.utc)
    ms = int(t.timestamp() * 1000)
    pre = float(r['mid_prev']); post = float(r['mid_now'])
    back = False
    for ts, b, a in window_ticks(RAW, ms, ms + 60000):
        m = (a + b) / 2 / P
        if abs(m - pre) <= 1.0:
            back = True; break
    res.append(back)
    if back: rev += 1
print('jumps >=5 USD:', len(rows), '| reverted to within 1 USD of pre-jump mid within 60 s:', rev, f'({100*rev/len(rows):.1f}%)')
big = [r for r in rows if float(r['jump_usd']) >= 20]
print('jumps >=20 USD:', len(big))
for r in big[:10]: print('  ', r['tick_utc'], r['mid_prev'], '->', r['mid_now'], r['jump_usd'])
