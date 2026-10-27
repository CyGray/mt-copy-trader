"""Retry hours whose status is 'error' in a manifest. Max 3 attempts per hour, 2 workers.
Only adds files (never rewrites existing raw files). usage: retry_errors.py RAWDIR MANIFEST_IN MANIFEST_OUT
"""
import sys, os, csv, time, datetime as dt
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import fetch_hour
RAW, MIN, MOUT = sys.argv[1:4]
errs = [r['hour_utc'] for r in csv.DictReader(open(MIN)) if r['status'] == 'error']
print('error hours to retry', len(errs), flush=True)
def hour_of(s):
    return dt.datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ')
def attempt(h):
    hist = []
    for k in range(3):
        st, nb, note = fetch_hour(hour_of(h), RAW)
        hist.append(f'{st}:{note}')
        if st in ('ok', 'cached', 'empty', 'missing'):
            return h, st, nb, ' | '.join(hist)
        time.sleep(45 * (k + 1))
    return h, 'error', 0, ' | '.join(hist)
results = []
with ThreadPoolExecutor(max_workers=2) as ex:
    for res in ex.map(attempt, errs):
        results.append(res); print(res, flush=True)
with open(MOUT, 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['hour_utc', 'status', 'bytes', 'note'])
    w.writerows(results)
print('retry summary', {s: sum(1 for r in results if r[1] == s) for s in set(r[1] for r in results)}, flush=True)
