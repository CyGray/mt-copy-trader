"""Resumable, polite (<=4 parallel) downloader for Dukascopy hourly tick files (XAUUSD by default).

usage: download_ticks.py RAWDIR MANIFEST_CSV START_UTC END_UTC_EXCL [workers] [--symbol SYMBOL] [--pause SECONDS]
  START/END as YYYY-MM-DDTHH (END exclusive). Without --symbol the behaviour is the original XAUUSD one.
  A non-gold symbol needs its own RAWDIR named after the symbol, e.g. /tmp/.../fx/raw/EURUSD.
  Writes a manifest row per hour (status, bytes, note, seconds).
"""
import argparse, sys, os, csv, time, datetime as dt
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import fetch_hour, check_rawdir, DEFAULT_SYMBOL

ap = argparse.ArgumentParser(description='Download Dukascopy hourly bi5 tick files (resumable).')
ap.add_argument('rawdir')
ap.add_argument('manifest')
ap.add_argument('start', help='YYYY-MM-DDTHH, UTC, inclusive')
ap.add_argument('end', help='YYYY-MM-DDTHH, UTC, exclusive')
ap.add_argument('workers', nargs='?', type=int, default=4)
ap.add_argument('--symbol', default=DEFAULT_SYMBOL)
ap.add_argument('--pause', type=float, default=0.0, help='seconds a worker waits after each request')
args = ap.parse_args()

try:
    check_rawdir(args.rawdir, args.symbol)
except ValueError as e:
    sys.exit(f'error: {e}')

RAW, MAN, SYMBOL = args.rawdir, args.manifest, args.symbol
start = dt.datetime.fromisoformat(args.start)
end = dt.datetime.fromisoformat(args.end)
workers = min(args.workers, 4)

hours = []
t = start
while t < end:
    hours.append(t)
    t += dt.timedelta(hours=1)

def work(h):
    t0 = time.time()
    status, nbytes, note = fetch_hour(h, RAW, symbol=SYMBOL)
    secs = round(time.time() - t0, 2)
    if args.pause > 0:
        time.sleep(args.pause)
    return h, status, nbytes, note, secs

counts = {}
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
print('DONE', SYMBOL, len(hours), counts, flush=True)
