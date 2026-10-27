# Task 6: sanity checks on signals (from signals.csv + raw texts). Derived output only.
import csv, statistics, collections, json, re
from datetime import datetime
S='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
rows=list(csv.DictReader(open(S+'/signals.csv',encoding='utf-8')))
def q(vals, ps=(0,0.05,0.25,0.5,0.75,0.95,1)):
    v=sorted(vals); n=len(v)
    return {p: v[min(n-1,int(round(p*(n-1))))] for p in ps}
f=lambda x: float(x)
print('N signals', len(rows))
print('entry_width (price units) quantiles', {k:round(v,3) for k,v in q([f(r['entry_width']) for r in rows]).items()})
print('entry_width==0 (single price):', sum(1 for r in rows if f(r['entry_width'])==0), ' >=5:', sum(1 for r in rows if f(r['entry_width'])>=5))
print('sl_dist_from_mid quantiles', {k:round(v,2) for k,v in q([f(r['sl_dist_from_mid']) for r in rows]).items()})
print('tp1_dist_from_mid quantiles', {k:round(v,2) for k,v in q([f(r['tp1_dist_from_mid']) for r in rows]).items()})
print('tp_last_dist_from_mid quantiles', {k:round(v,2) for k,v in q([f(r['tp_last_dist_from_mid']) for r in rows]).items()})
print('by direction tp1 median', {dd: statistics.median([f(r['tp1_dist_from_mid']) for r in rows if r['direction']==dd]) for dd in ['buy','sell']})
print('by direction sl median', {dd: statistics.median([f(r['sl_dist_from_mid']) for r in rows if r['direction']==dd]) for dd in ['buy','sell']})
# SL-distance outliers
srt=sorted(rows,key=lambda r:-f(r['sl_dist_from_mid']))
print('largest SL distance (id, dist, dir, entry_mid, sl):')
for r in srt[:8]: print('   ',r['message_id'], r['sl_dist_from_mid'], r['direction'], r['entry_mid'], r['sl'], r['date_utc'])
print('smallest SL distance:')
for r in sorted(rows,key=lambda r:f(r['sl_dist_from_mid']))[:6]: print('   ',r['message_id'], r['sl_dist_from_mid'], r['direction'], r['entry_mid'], r['sl'], r['date_utc'])
# TP far
print('largest tp_last distances:')
for r in sorted(rows,key=lambda r:-f(r['tp_last_dist_from_mid']))[:8]: print('   ',r['message_id'], r['tp_last_dist_from_mid'], r['direction'], r['entry_mid'], r['num_tps'], r['tp_last'] if 'tp_last' in r else [r[f'tp{i}'] for i in range(1,8) if r[f'tp{i}']][-1], r['date_utc'])
print('wide entries (>=3):')
for r in sorted(rows,key=lambda r:-f(r['entry_width']))[:10]: print('   ',r['message_id'], r['entry_low'], r['entry_high'], r['direction'], r['date_utc'])
# price level over time (monthly median entry_mid)
bym=collections.defaultdict(list)
for r in rows: bym[r['date_utc'][:7]].append(f(r['entry_mid']))
print('monthly entry_mid median/min/max (n):')
for m in sorted(bym): print('   ',m, round(statistics.median(bym[m]),1), min(bym[m]), max(bym[m]), len(bym[m]))
# jumps vs rolling median of previous 10 signals
mids=[(i,f(r['entry_mid']),r['message_id'],r['date_utc']) for i,r in enumerate(rows)]
flag=[]
for i,(idx,mv,mid,dt) in enumerate(mids):
    if i<10: continue
    med=statistics.median([x[1] for x in mids[i-10:i]])
    if abs(mv-med)/med>0.02: flag.append((mid,dt,mv,round(med,1)))
print('entries >2% away from prior-10 median:', len(flag), flag[:15])
# weekday / hour / per-day
wd=collections.Counter(datetime.strptime(r['date_utc'],'%Y-%m-%dT%H:%M:%SZ').strftime('%a') for r in rows)
print('weekday', wd)
hr=collections.Counter(int(r['date_utc'][11:13]) for r in rows)
print('hour UTC', sorted(hr.items()))
pdays=collections.Counter(r['date_utc'][:10] for r in rows)
print('days with >=1 signal', len(pdays), 'max/day', pdays.most_common(3), 'median per active day', statistics.median(pdays.values()))
print('per-day distribution', sorted(collections.Counter(pdays.values()).items()))
