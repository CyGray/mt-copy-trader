# Task 5: edited messages and signal edits.
import json, csv, re, statistics, collections
from datetime import datetime, timezone
S='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
d=json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json',encoding='utf-8'))
def pdt(s):
    fmt='%Y-%m-%dT%H:%M:%S.%fZ' if '.' in s else '%Y-%m-%dT%H:%M:%SZ'
    return datetime.strptime(s,fmt).replace(tzinfo=timezone.utc)
ed=[r for r in d if r['edit_date']]
print('edited messages (edit_date non-null)', len(ed), 'of', len(d))
print('edited signals', sum(1 for r in ed if r['is_signal']), 'of', sum(1 for r in d if r['is_signal']))
ns=[r for r in d if r['is_signal'] and not r['edit_date']]
print('non-edited signals', len(ns), [r['message_id'] for r in ns])
sigs=[r for r in d if r['is_signal'] and r['edit_date']]
dl=[(pdt(r['edit_date'])-pdt(r['date'])).total_seconds() for r in sigs]
print('signal edit delay s quantiles: min',min(dl),'median',statistics.median(dl),'max',max(dl))
print('signal edit delay <=60s', sum(1 for x in dl if x<=60), ' 60s<x<=1h', sum(1 for x in dl if 60<x<=3600), ' 1h<x<=1d', sum(1 for x in dl if 3600<x<=86400), ' >1d', sum(1 for x in dl if x>86400))
late=[(r['message_id'], round(x/3600,2)) for r,x in zip(sigs,dl) if x>3600]
print('signals edited more than 1h after posting (id, hours):', late)
print('all-message edit delay >1d (id, days):', [(r['message_id'], round((pdt(r['edit_date'])-pdt(r['date'])).total_seconds()/86400,1)) for r in ed if (pdt(r['edit_date'])-pdt(r['date'])).total_seconds()>86400])
# text mentions of edits/corrections
pat=re.compile(r'misclick|typo|edit|correct|mistake|sorry|ignore|wrong|ajust|adjust|update the|changed', re.I)
hits=[r for r in d if not r['is_signal'] and pat.search(r['text'] or '')]
print('non-signal messages with correction/edit words:', len(hits))
for r in hits[:12]: print('  ', r['message_id'], repr(r['text'][:120]))
# fetched_at structure
fa=collections.Counter(r['fetched_at'][:16] for r in d)
print('fetched_at distinct minutes', len(fa), 'range', min(fa), max(fa))
print('edit_date vs fetched_at: max edit_date', max(r['edit_date'] for r in ed), 'max fetched', max(r['fetched_at'] for r in d))
