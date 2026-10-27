# Remaining numbers: templates, overlap/burst, local outliers, duplicates, comma-decimal verification, file order.
import json, csv, re, collections, statistics
from datetime import datetime, timezone
S='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
d=json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json',encoding='utf-8'))
cls=list(csv.DictReader(open(S+'/classes.csv',encoding='utf-8')))
sig=list(csv.DictReader(open(S+'/signals.csv',encoding='utf-8')))
def pdt(s):
    fmt='%Y-%m-%dT%H:%M:%S.%fZ' if '.' in s else '%Y-%m-%dT%H:%M:%SZ'
    return datetime.strptime(s,fmt).replace(tzinfo=timezone.utc)
# file order check
ids_file=[int(r['message_id']) for r in d]
print('file order: first 8 ids', ids_file[:8], ' sorted-as-string?', [int(x) for x in sorted([str(i) for i in ids_file], key=str)]==ids_file)
print('file order: is ascending int?', ids_file==sorted(ids_file), '; count of descents', sum(1 for a,b in zip(ids_file,ids_file[1:]) if b<a))
# templates for update classes
for c in ['update_tp_hit','update_stopped_at_be','update_be_mgmt','update_loss_claim','update_pips_claim','update_close','update_running','tp_level_mention','commentary','signal_header_only','empty']:
    rs=[r for r in cls if r['class']==c]
    cnt=collections.Counter(r['template'] for r in rs)
    print(f'== {c} n={len(rs)} distinct_templates={len(cnt)}')
    for k,v in cnt.most_common(12): print(f'     {v:4d}  {k}')
# overlap / bursts between consecutive signals
t=[pdt(r['date_utc']) for r in sig]
gaps=[(b-a).total_seconds()/60 for a,b in zip(t,t[1:])]
print('consecutive signal gaps (min): median',round(statistics.median(gaps),1),'p10',round(sorted(gaps)[len(gaps)//10],1),'n',len(gaps))
for th in [30,60,240]:
    print(f'   consecutive signals posted within {th} min of previous:', sum(1 for g in gaps if g<=th), f'({100*sum(1 for g in gaps if g<=th)/len(gaps):.1f}%)')
opp=sum(1 for a,b,ta,tb in zip(sig,sig[1:],t,t[1:]) if a['direction']!=b['direction'] and (tb-ta).total_seconds()<=3600)
print('consecutive opposite-direction signals within 60 min:', opp)
# duplicate signal texts
txt=collections.Counter(r['text_sha1'] for r in sig)
print('duplicate signal texts (same sha1, count>1):', sum(1 for v in txt.values() if v>1), [ (k[:8],v) for k,v in txt.items() if v>1][:5])
rawsig=[r for r in d if r['is_signal']]
rc=collections.Counter((r['text'] or '').strip() for r in rawsig)
dups=[(t_[:40],v) for t_,v in rc.items() if v>1]
print('identical signal texts posted more than once:', len(dups), dups[:5])
# signals with grouped_id or reply
print('signals with grouped_id:', sum(1 for r in d if r['is_signal'] and r['grouped_id']), ' signals that are replies:', sum(1 for r in d if r['is_signal'] and r['reply_to_msg_id']))
print('reply targets of signals (reply_to_msg_id):', [(r['message_id'],r['reply_to_msg_id']) for r in d if r['is_signal'] and r['reply_to_msg_id']])
# local level outliers: compare entry_mid to median of 2 previous and 2 next signals
mids=[float(r['entry_mid']) for r in sig]; ids=[r['message_id'] for r in sig]
out=[]
for i in range(2,len(sig)-2):
    nb=[mids[i-2],mids[i-1],mids[i+1],mids[i+2]]
    med=statistics.median(nb)
    if abs(mids[i]-med)/med>0.012: out.append((ids[i], sig[i]['date_utc'][:10], mids[i], round(med,2), round(100*(mids[i]-med)/med,2)))
print('local entry_mid outliers vs +-2 neighbours (>1.2%):', len(out))
for o in out[:25]: print('   id',o[0],o[1],'entry_mid',o[2],'neighbour_median',o[3],'pct',o[4])
# comma decimal: stored values vs text
byid={r['message_id']:r for r in d}
for mid in ['14','19','196','378']:
    r=byid[mid]; s=r['signal']
    print('COMMA',mid, 'stored entry',s['entryLow'],s['entryHigh'],'sl',s['stopLoss'],'tps',s['takeProfits'])
    print('      text lines:', [ln for ln in r['text'].split('\n') if re.search(r',\d',ln)])
# is_signal records lacking the BUY/SELL+SL+TP pattern
pat_dir=re.compile(r'^[ \t>]*(BUY|SELL)(ING)?\b',re.M|re.I)
bad=[r['message_id'] for r in d if r['is_signal'] and not (pat_dir.search(r['text']) and re.search(r'\b(SL|STOP\s*LOSS)\b',r['text'],re.I) and re.search(r'\bTP\s*\d',r['text'],re.I))]
print('is_signal=true without BUY/SELL line + SL + TPn:', bad)
