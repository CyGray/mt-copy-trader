# Final template and TP-index summary from classes.csv (classify6) and provider_claim_events.csv.
import csv, re, collections
S='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
rows=list(csv.DictReader(open(S+'/classes.csv',encoding='utf-8')))
ev=list(csv.DictReader(open(S+'/provider_claim_events.csv',encoding='utf-8')))
cnt=collections.Counter(r['class'] for r in rows)
print('TOTAL', len(rows), 'sum of class counts', sum(cnt.values()))
tops={}
for c in sorted(cnt, key=lambda k:-cnt[k]):
    if c in ('new_signal',): continue
    t=collections.Counter(r['template'] for r in rows if r['class']==c)
    print(f'== {c}: n={cnt[c]} distinct_templates={len(t)}')
    for k,v in t.most_common(6): print(f'     {v:4d}  {k}')
# normalized TP hits: take the explicit index token
tpidx=collections.Counter()
for r in rows:
    if r['class']=='update_tp_hit':
        m=re.search(r'\bTP\s*(\d)\b', r['text'], re.I)
        tpidx[m.group(1) if m else 'none']+=1
print('TP-hit claims by explicit TP index (n=%d):'%sum(tpidx.values()), dict(sorted(tpidx.items())))
# pips attached to explicit TP-hit templates
pv=[]
for r in rows:
    if r['class']=='update_tp_hit':
        m=re.search(r'\+\s*(\d+)\s*PIPS', r['text'], re.I)
        if m: pv.append(int(m.group(1)))
pv.sort(); n=len(pv)
print('TP-hit claims with a + pips figure: n=%d median=%s p10=%s p90=%s'%(n, pv[n//2], pv[n//10], pv[9*n//10]))
print('event link method', collections.Counter(e['link_method'] for e in ev))
