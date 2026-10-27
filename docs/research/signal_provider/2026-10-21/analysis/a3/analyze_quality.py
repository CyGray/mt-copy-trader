"""Data-quality and spread summary from derived/ outputs.

usage: analyze_quality.py DERIVED_DIR COVERAGE_MANIFEST
Prints tables and writes derived/quality_summary.json.
"""
import sys, os, csv, json, statistics as st, datetime as dt, collections

DER, MAN = sys.argv[1], sys.argv[2]
P = 1000.0

def pct_from_counter(c, p):
    total = sum(c.values())
    if total == 0: return None
    target = p * total
    acc = 0
    for k in sorted(c):
        acc += c[k]
        if acc >= target:
            return k
    return max(c)

def mean_from_counter(c):
    total = sum(c.values())
    return sum(k * v for k, v in c.items()) / total if total else None

out = {}
# ---- coverage from manifest ----
man = list(csv.DictReader(open(MAN)))
mc = collections.Counter(r['status'] for r in man)
out['manifest_rows'] = len(man); out['manifest_status'] = dict(mc)
print('manifest rows', len(man), dict(mc))

# ---- hourly quality ----
qr = list(csv.DictReader(open(os.path.join(DER, 'hourly_quality.csv'))))
out['hours_in_quality_table'] = len(qr)
qs = collections.Counter(r['status'] for r in qr)
print('hourly rows', len(qr), dict(qs))
ok = [r for r in qr if r['status'] == 'ok']
hod_status = {h: collections.Counter() for h in range(24)}
wd_hours = collections.defaultdict(lambda: collections.Counter())  # weekday -> status
for r in qr:
    t = dt.datetime.fromisoformat(r['hour_utc'].replace('Z', '+00:00'))
    hod_status[t.hour][r['status']] += 1
    wd_hours[t.weekday()][r['status']] += 1
names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
print('\nstatus by weekday (UTC):')
for w in range(7):
    print(f'  {names[w]}', dict(wd_hours[w]))
out['weekday_status'] = {names[w]: dict(wd_hours[w]) for w in range(7)}

# unexpected empties on Mon-Thu (excluding the daily break hours 21-22 UTC)
unexpected = []
for r in qr:
    t = dt.datetime.fromisoformat(r['hour_utc'].replace('Z', '+00:00'))
    if t.weekday() in (0, 1, 2, 3) and r['status'] in ('empty', 'missing', 'absent', 'error') and t.hour not in (21, 22):
        unexpected.append((r['hour_utc'], r['status']))
print('\nunexpected non-ok hours Mon-Thu outside 21-22 UTC:', len(unexpected))
for x in unexpected[:40]: print('   ', x)
out['unexpected_mon_thu_nonok'] = unexpected

# Fri/Sun-day boundaries: non-ok hours by hour-of-day
print('\nnon-ok hours by UTC hour-of-day (all weekdays):')
for h in range(24):
    c = hod_status[h]
    print(f'  {h:02d}', dict(c))
out['hod_status'] = {h: dict(hod_status[h]) for h in range(24)}

# tick count profile by hour-of-day (ok hours)
tick_by_h = collections.defaultdict(list)
for r in ok:
    t = dt.datetime.fromisoformat(r['hour_utc'].replace('Z', '+00:00'))
    if t.weekday() <= 4:
        tick_by_h[t.hour].append(int(r['n_ticks']))
print('\nmedian ticks per UTC hour (Mon-Fri ok hours):')
prof = {}
for h in range(24):
    if tick_by_h[h]:
        prof[h] = int(st.median(tick_by_h[h]))
print('  ', prof)
out['tick_profile_median_by_utc_hour'] = prof

# gaps, anomalies
tot_bge = sum(int(r['n_bid_ge_ask']) for r in ok)
tot_zs = sum(int(r['n_zero_spread']) for r in ok)
tot_nm = sum(int(r['n_nonmono']) for r in ok)
g60 = [r for r in ok if int(r['n_gap_gt60s']) > 0]
g300 = [r for r in ok if float(r['max_gap_s']) > 300]
mj1 = sum(int(r['n_mid_jump_ge1usd']) for r in ok)
maxmj = max(ok, key=lambda r: float(r['max_mid_jump_usd']))
print(f"\nticks total {sum(int(r['n_ticks']) for r in ok)}; bid>=ask {tot_bge}; zero spread {tot_zs}; non-monotonic ms {tot_nm}")
print(f'hours with any gap >60 s inside the hour: {len(g60)}; hours with max gap >300 s: {len(g300)}')
for r in sorted(g300, key=lambda r: -float(r['max_gap_s']))[:25]:
    print('   gap', r['hour_utc'], 'max_gap_s', r['max_gap_s'], 'ticks', r['n_ticks'])
print(f'consecutive-tick mid jumps >=1 USD: {mj1}; largest single jump {maxmj["max_mid_jump_usd"]} USD in {maxmj["hour_utc"]}')
out.update(bid_ge_ask=tot_bge, zero_spread=tot_zs, nonmono=tot_nm, hours_gap_gt60=len(g60), hours_gap_gt300=len(g300),
           mid_jumps_ge1=mj1, max_jump=float(maxmj['max_mid_jump_usd']), max_jump_hour=maxmj['hour_utc'])

# ---- spread distribution (exact counters) ----
sh = json.load(open(os.path.join(DER, 'spread_hist.json')))
allc = collections.Counter()
for h, c in sh['by_hour_of_day'].items():
    for k, v in c.items(): allc[int(k)] += v
def fmt_c(c):
    n = sum(c.values())
    return dict(n=n, mean=round(mean_from_counter(c) / P, 4),
                median=pct_from_counter(c, .5) / P, p95=pct_from_counter(c, .95) / P,
                p99=pct_from_counter(c, .99) / P, max=max(c) / P)
print('\nspread (USD) overall:', fmt_c(allc))
out['spread_overall'] = fmt_c(allc)
print('\nspread by UTC hour-of-day (USD):')
sod = {}
for h in range(24):
    c = collections.Counter({int(k): v for k, v in sh['by_hour_of_day'][str(h)].items()})
    if sum(c.values()):
        sod[h] = fmt_c(c)
        print(f'  {h:02d}', sod[h])
out['spread_by_hour'] = sod
print('\nspread by month (USD):')
som = {}
for m, c0 in sh['by_month'].items():
    c = collections.Counter({int(k): v for k, v in c0.items()})
    som[m] = fmt_c(c)
    print(f'  {m}', som[m])
out['spread_by_month'] = som
json.dump(out, open(os.path.join(DER, 'quality_summary.json'), 'w'), indent=1, default=str)
print('\nwrote', os.path.join(DER, 'quality_summary.json'))
