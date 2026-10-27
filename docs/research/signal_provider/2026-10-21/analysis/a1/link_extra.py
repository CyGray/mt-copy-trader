# Task 4 extras: unambiguous share, unlinked-claim mapping to rejected signal-like posts, pip-scale check.
import csv, json, re, statistics, collections
S='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
ev=list(csv.DictReader(open(S+'/provider_claim_events.csv',encoding='utf-8')))
cls={int(r['message_id']):r for r in csv.DictReader(open(S+'/classes.csv',encoding='utf-8'))}
sig={int(r['message_id']):r for r in csv.DictReader(open(S+'/signals.csv',encoding='utf-8'))}
print('events', len(ev))
tp=[e for e in ev if e['claim_class']=='update_tp_hit']
print('TP claims', len(tp), 'linked', sum(1 for e in tp if e['link_method']!='unlinked'), 'unlinked', sum(1 for e in tp if e['link_method']=='unlinked'))
print('TP claims unambiguous (exactly 1 candidate)', sum(1 for e in tp if e['link_method']=='temporal' and e['candidates_n']=='1'))
print('TP claims ambiguous (>1 candidate)', sum(1 for e in tp if e['link_method']=='temporal' and int(e['candidates_n'])>1))
allc=[e for e in ev if e['link_method']!='unlinked']
print('ALL claims unambiguous', sum(1 for e in allc if e['link_method']=='temporal' and e['candidates_n']=='1'), 'of', len(ev))
# unlinked -> nearest prior signal-ish message
unl=[e for e in ev if e['link_method']=='unlinked']
cnt=collections.Counter()
for e in unl:
    m=int(e['claim_msg_id'])
    prior=[k for k in cls if k<m and cls[k]['class'] in ('new_signal','signal_like_unparsed','signal_header_only')]
    p=max(prior) if prior else None
    if p is None: cnt['no_prior_signal_ish']+=1
    elif cls[p]['class']=='signal_like_unparsed' and m-p<=5: cnt['within5_after_REJECTED_signal_like']+=1
    elif cls[p]['class']=='new_signal' and m-p<=10: cnt['within10_after_accepted_signal(state_closed)']+=1
    else: cnt['other']+=1
print('unlinked claims mapping:', dict(cnt), 'total', len(unl))
print('unlinked claims by class', collections.Counter(e['claim_class'] for e in unl))
print('unlinked ids:', [int(e['claim_msg_id']) for e in unl])
# pip-scale check on TP claims with pips in text, linked and unambiguous
rat=[]; rat_all=[]
for e in tp:
    if e['link_method']=='unlinked' or not e['pips_mentioned']: continue
    sid=int(e['signal_msg_id']); s=sig[sid]
    n=int(e['tp_index']) if e['tp_index'] else None
    if n is None or n>int(s['num_tps']): continue
    tpv=float(s[f'tp{n}']); mid=float(s['entry_mid'])
    dist=abs(tpv-mid)
    if dist==0: continue
    pips=abs(float(e['pips_mentioned'].replace('+','').replace('-','')))
    r=pips/dist
    rat_all.append(r)
    if e['candidates_n']=='1': rat.append(r)
def summ(x,lab):
    if not x: print(lab,'none'); return
    x=sorted(x); n=len(x)
    print(f'{lab}: n={n} median={statistics.median(x):.2f} p25={x[n//4]:.2f} p75={x[3*n//4]:.2f} min={x[0]:.2f} max={x[-1]:.2f}')
summ(rat_all,'pips / |TPn - entry_mid| (all linked TP claims with pips)')
summ(rat,'same, unambiguous links only')
