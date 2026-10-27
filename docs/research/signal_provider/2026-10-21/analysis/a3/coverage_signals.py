"""Classify empty hours and check each signal's [signal_time, +72h] window.
Classes for status 'empty' hours (UTC):
  weekend          Fri>=21, all Sat, Sun<21 (Sun 21-23 counted as weekend open transition)
  daily_break      Mon-Thu at 21, 22 or 23 (winter 22 UTC / summer 21 UTC break)
  holiday_run      run of >=4 consecutive empty hours on Mon-Fri not in the classes above
  unexpected       any other empty hour (true gap inside trading time)
usage: coverage_signals.py DERIVED_DIR COVERAGE_DIR
Writes coverage/empty_hour_classes.csv and coverage/signal_window_coverage.csv
"""
import sys, os, csv, datetime as dt, collections
DER, COV = sys.argv[1], sys.argv[2]
rows = list(csv.DictReader(open(os.path.join(COV, 'final_manifest.csv'))))
man = {r['hour_utc']: r['status'] for r in rows}
def H(s): return dt.datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)
hours = sorted(man, key=H)
names = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
cls = {}
for h in hours:
    if man[h] != 'empty': continue
    t = H(h); w = t.weekday(); hr = t.hour
    if w == 5 or (w == 4 and hr >= 21) or (w == 6 and hr < 21): cls[h] = 'weekend'
    elif w == 6: cls[h] = 'weekend'  # Sun 21-23 open transition
    elif w <= 3 and hr in (21, 22, 23): cls[h] = 'daily_break'
    else: cls[h] = None  # decide below
# runs of residual empties on weekdays
i = 0
residual = [h for h in hours if cls.get(h) is None and man[h] == 'empty']
idx = {h: k for k, h in enumerate(hours)}
runs = []
cur = []
for h in residual:
    if cur and idx[h] != idx[cur[-1]] + 1:
        runs.append(cur); cur = []
    cur.append(h)
if cur: runs.append(cur)
for run in runs:
    lab = 'holiday_run' if len(run) >= 4 else 'unexpected'
    for h in run: cls[h] = lab
counts = collections.Counter(cls.values())
print('empty hours by class:', dict(counts), '| total empty', sum(1 for h in hours if man[h] == 'empty'))
with open(os.path.join(COV, 'empty_hour_classes.csv'), 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['hour_utc', 'weekday', 'class'])
    for h in hours:
        if man[h] == 'empty': w.writerow([h, names[H(h).weekday()], cls[h]])
hol = [r for r in runs if len(r) >= 4]
print('holiday/extended-closure runs (weekday):')
for r in hol: print(f'   {r[0]} .. {r[-1]}  ({len(r)} h)')
unexp = [h for h in hours if cls.get(h) == 'unexpected']
print('unexpected empty hours:', len(unexp))
for h in unexp: print('   ', h, names[H(h).weekday()])
data_end = H(hours[-1]) + dt.timedelta(hours=1)
sigs = list(csv.DictReader(open(os.path.join(DER, 'signals_a3.csv'), encoding='utf-8')))
out = []
for s in sigs:
    t0 = dt.datetime.fromisoformat(s['date_utc'].replace('Z', '+00:00'))
    t1 = t0 + dt.timedelta(hours=72)
    hs = []; cur_t = t0.replace(minute=0, second=0, microsecond=0)
    while cur_t < t1:
        hs.append(cur_t.strftime('%Y-%m-%dT%H:00:00Z')); cur_t += dt.timedelta(hours=1)
    not_in = [h for h in hs if h not in man]
    unexp_h = [h for h in hs if cls.get(h) == 'unexpected']
    hol_h = [h for h in hs if cls.get(h) == 'holiday_run']
    reasons = []
    if t1 > data_end: reasons.append('window_past_download_end')
    if not_in: reasons.append(f'hours_missing_from_manifest={len(not_in)}')
    if unexp_h: reasons.append(f'unexpected_empty_hours={len(unexp_h)}')
    lacks = bool(reasons)
    out.append(dict(msg_id=s['msg_id'], date_utc=s['date_utc'], direction=s['direction'], window_hours=len(hs),
                    ok_hours=sum(1 for h in hs if man.get(h) in ('ok', 'cached')),
                    daily_break_or_weekend_hours=sum(1 for h in hs if cls.get(h) in ('weekend', 'daily_break')),
                    holiday_run_hours=len(hol_h), lacks_tick_coverage=int(lacks), reasons=';'.join(reasons)))
with open(os.path.join(COV, 'signal_window_coverage.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
lack = [r for r in out if r['lacks_tick_coverage']]
print(f'signals {len(out)}; windows lacking tick coverage (unexpected gap or past download end or missing hours): {len(lack)}')
print('windows touching a holiday run (informational):', sum(1 for r in out if r['holiday_run_hours'] > 0))
for r in lack: print('   ', r['msg_id'], r['date_utc'], r['reasons'])
