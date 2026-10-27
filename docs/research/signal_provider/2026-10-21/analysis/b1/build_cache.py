"""Decode A3's XAUUSD bi5 hours into b1/cache/*.npy and write the hour index + QC summary.

Re-runnable: hours already cached (same raw byte size) are not decoded again. Hours that are
still downloading are simply 'unknown' until their file appears.

usage: python3 -I build_cache.py [START_HOUR_ISO] [END_HOUR_ISO_EXCL]
       defaults: 2025-10-30T00 .. 2026-09-28T00 (A3 download range)
"""
import csv
import datetime as dt
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sim_engine as se  # noqa: E402
import numpy as np  # noqa: E402

RAW = '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a3/raw'
CACHE = os.path.join(HERE, 'cache')
OUT_INDEX = os.path.join(HERE, 'hour_index.csv')
OUT_QC = os.path.join(HERE, 'qc_summary.json')

start_s = sys.argv[1] if len(sys.argv) > 1 else '2025-10-30T00'
end_s = sys.argv[2] if len(sys.argv) > 2 else '2026-09-28T00'
t = dt.datetime.fromisoformat(start_s).replace(tzinfo=dt.timezone.utc)
t_end = dt.datetime.fromisoformat(end_s).replace(tzinfo=dt.timezone.utc)

store = se.TickStore(RAW, CACHE)
rows = []
qc = {'hours_total': 0, 'ok': 0, 'empty': 0, 'unknown': 0, 'ticks': 0,
      'bid_gt_ask': 0, 'zero_spread': 0, 'spread_gt_5usd': 0, 'ms_nonmonotone_hours': 0,
      'ms_out_of_hour': 0, 'mid_jump_gt_5usd_1tick': 0, 'mid_jump_gt_20usd_1tick': 0,
      'min_price': None, 'max_price': None, 'median_spread': []}
t0 = time.time()
decoded = 0
while t < t_end:
    h_ms = int(t.timestamp() * 1000)
    st = store.status(h_ms)
    row = {'hour_utc': t.strftime('%Y-%m-%dT%H:00:00Z'), 'status': st, 'n_ticks': 0,
           'bytes': store.raw_size(h_ms), 'weekday': t.strftime('%a')}
    qc['hours_total'] += 1
    qc[st] += 1
    if st == 'ok':
        ms, bid, ask = store.load_hour(h_ms)
        n = len(ms)
        row['n_ticks'] = n
        qc['ticks'] += n
        if n:
            spr = ask - bid
            row['bid_gt_ask'] = int((spr < 0).sum())
            row['zero_spread'] = int((spr == 0).sum())
            row['spread_med'] = round(float(np.median(spr)), 3)
            row['spread_max'] = round(float(spr.max()), 3)
            row['min_price'] = round(float(min(bid.min(), ask.min())), 3)
            row['max_price'] = round(float(max(bid.max(), ask.max())), 3)
            qc['bid_gt_ask'] += row['bid_gt_ask']
            qc['zero_spread'] += row['zero_spread']
            qc['spread_gt_5usd'] += int((spr > 5).sum())
            if np.any(np.diff(ms) < 0):
                qc['ms_nonmonotone_hours'] += 1
            if ms[-1] - h_ms >= 3_600_000 or ms[0] < h_ms:
                qc['ms_out_of_hour'] += 1
            mid = (bid + ask) / 2
            if n > 1:
                jump = np.abs(np.diff(mid))
                qc['mid_jump_gt_5usd_1tick'] += int((jump > 5).sum())
                qc['mid_jump_gt_20usd_1tick'] += int((jump > 20).sum())
            qc['median_spread'].append(float(np.median(spr)))
            qc['min_price'] = row['min_price'] if qc['min_price'] is None else min(qc['min_price'], row['min_price'])
            qc['max_price'] = row['max_price'] if qc['max_price'] is None else max(qc['max_price'], row['max_price'])
        decoded += 1
    rows.append(row)
    t += dt.timedelta(hours=1)

fields = ['hour_utc', 'weekday', 'status', 'n_ticks', 'bytes', 'bid_gt_ask', 'zero_spread', 'spread_med',
          'spread_max', 'min_price', 'max_price']
with open(OUT_INDEX, 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
    w.writeheader()
    w.writerows(rows)

qc['median_spread_of_hours'] = float(np.median(qc.pop('median_spread'))) if decoded else None
qc['decode_seconds'] = round(time.time() - t0, 1)
qc['hours_decoded_this_run'] = decoded
qc['range'] = [start_s, end_s]
qc['first_ok_hour'] = next((r['hour_utc'] for r in rows if r['status'] == 'ok'), None)
qc['last_ok_hour'] = next((r['hour_utc'] for r in reversed(rows) if r['status'] == 'ok'), None)
with open(OUT_QC, 'w') as f:
    json.dump(qc, f, indent=2)
print(json.dumps(qc, indent=2))
