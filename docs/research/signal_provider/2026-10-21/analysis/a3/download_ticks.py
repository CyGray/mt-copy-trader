"""Resumable, polite (<=4 parallel) downloader for Dukascopy XAUUSD hourly tick files.

usage: download_ticks.py RAWDIR MANIFEST_CSV START_UTC END_UTC_EXCL [workers]
  START/END as YYYY-MM-DDTHH. Writes a manifest row per hour (status, bytes, note, seconds).
"""
import sys, os, csv, time, datetime as dt
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import fetch_hour

RAW, MAN = sys.argv[1], sys.argv[2]
start = dt.datetime.fromisoformat(sys.argv[3])
end = dt.datetime.fromisoformat(sys.argv[4])
workers = int(sys.argv[5]) if len(sys.argv) > 5 else 4
workers = min(workers, 4)

hours = []
t = start
while t < end:
    hours.append(t)
    t += dt.timedelta(hours=1)

def work(h):
    t0 = time.time()
    status, nbytes, note = fetch_hour(h, RAW)
    return h, status, nbytes, note, round(time.time() - t0, 2)

counts = {}
done_rows = []
with open(MAN, 'w', newline='') as mf, ThreadPoolExecutor(max_workers=workers) as ex:
    w = csv.writer(mf)
    w.writerow(['hour_utc', 'status', 'bytes', 'note', 'seconds'])
    futs = [ex.submit(work, h) for h in hours]
    n = 0
    for fu in as_completed(futs):
        h, status, nbytes, note, secs = fu.result()
        w.writerow([h.strftime('%Y-%m-%dT%H:00:00Z'), status, nbytes, note, secs])
        mf.flush()
        counts[status] = counts.get(status, 0) + 1
        n += 1
        if n % 250 == 0:
            print(f'{n}/{len(hours)} {counts}', flush=True)
print('DONE', len(hours), counts, flush=True)
