# Stratified random audit (seed fixed) of derived classes, for precision review.
import csv, random
S='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
rows=list(csv.DictReader(open(S+'/classes.csv',encoding='utf-8')))
random.seed(7)
by={}
for r in rows: by.setdefault(r['class'],[]).append(r)
for c in sorted(by):
    if c in ('new_signal',): continue
    k=min(6,len(by[c]))
    for r in random.sample(by[c],k):
        print(f"[{c}] id={r['message_id']} :: {r['text'][:140]!r}")
