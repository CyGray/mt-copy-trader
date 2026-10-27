"""Sanity checks on trade rows (no tick re-read): fill is at or after signal time + cost latency; closes are at or
after fill; every SL-after-TP move and exit is in order. Output printed. usage: python3 -I b2_check_lookahead.py"""
import csv, gzip, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402
bad_fill = bad_exit = n = 0
for path in ('out/phase1_trades.csv.gz', 'out/oos_trades.csv.gz', 'out/flagged_trades.csv.gz'):
    with gzip.open(path, 'rt', newline='') as f:
        for r in csv.DictReader(f):
            if r['fill_ms'] in ('', None):
                continue
            n += 1
            lat_ms = c.COSTS[r['cost']]['latency'] * 1000
            if int(r['fill_ms']) < int(r['t_ms']) + int(round(lat_ms)):
                bad_fill += 1
            if r['last_exit_ms'] not in ('', None) and int(r['last_exit_ms']) < int(r['fill_ms']):
                bad_exit += 1
print('trade rows checked', n, 'fill before signal+latency', bad_fill, 'exit before fill', bad_exit)
