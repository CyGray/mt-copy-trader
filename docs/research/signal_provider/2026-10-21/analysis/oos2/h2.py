import csv,numpy as np
rng=np.random.default_rng(7)
def load(p): return list(csv.DictReader(open(p)))
Tf=load('oos2/final_trades.csv'); Tl=load('oos2/first_trades.csv')
def pick(T,en,v,cost='MID'): return {t['message_id']:t for t in T if t['entry']==en and t['cost']==cost and t['variant']==v and t['total_R']!=''}
print('H2: late(>300s) minus stable(<=300s) mean R, E2/MID, final universe, bootstrap 95% CI')
for v in ('S_TP4|M5','S_TP4|M0','S_TP1|M0','Q_25x4|M0'):
    d=pick(Tf,'E2',v); a=np.array([float(t['total_R']) for t in d.values() if float(t['edit_delay_s'])>300]); b=np.array([float(t['total_R']) for t in d.values() if float(t['edit_delay_s'])<=300])
    diffs=[rng.choice(a,len(a)).mean()-rng.choice(b,len(b)).mean() for _ in range(10000)]
    print(f'  {v:10s} late n={len(a)} {a.mean():+.2f}  stable n={len(b)} {b.mean():+.2f}  diff {a.mean()-b.mean():+.2f} [{np.percentile(diffs,2.5):+.2f},{np.percentile(diffs,97.5):+.2f}]')
print('Paired: first-version levels minus final levels, E2/MID (same message ids)')
for v in ('S_TP4|M5','S_TP1|M0'):
    f=pick(Tf,'E2',v); l=pick(Tl,'E2',v); ids=sorted(set(f)&set(l))
    d=np.array([float(l[i]['total_R'])-float(f[i]['total_R']) for i in ids]); ch=[i for i in ids if int(float(f[i]['levels_changed']))]
    dd=np.array([float(l[i]['total_R'])-float(f[i]['total_R']) for i in ch])
    print(f'  {v}: paired n={len(ids)} mean diff {d.mean():+.3f}; among level-changed n={len(ch)} mean diff {dd.mean():+.3f}')
