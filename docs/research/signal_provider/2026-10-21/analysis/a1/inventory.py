# Task 1: dataset inventory for .data/vip_history.json (read-only).
import json, os, collections, statistics
from datetime import datetime, timezone
P = '/home/kyle/projects/ByTrader/.data/vip_history.json'
def pdt(s):
    return datetime.strptime(s, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc) if '.' in s else datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
print('file_bytes', os.path.getsize(P))
d = json.load(open(P, encoding='utf-8'))
print('records', len(d))
pairs = collections.Counter((r['chat_id'], r['message_id']) for r in d)
print('unique (chat_id,message_id)', len(pairs), 'dup_pairs', sum(1 for v in pairs.values() if v > 1), 'extra_rows', sum(v-1 for v in pairs.values() if v > 1))
print('distinct chat_ids', len(set(r['chat_id'] for r in d)))
print('distinct message_id', len(set(r['message_id'] for r in d)))
# dates
dates = [pdt(r['date']) for r in d]
print('date min', min(dates).isoformat(), 'max', max(dates).isoformat())
fetched = [pdt(r['fetched_at']) for r in d]
print('fetched_at min', min(fetched).isoformat(), 'max', max(fetched).isoformat(), 'distinct', len(set(r['fetched_at'] for r in d)))
# file order
ids = [int(r['message_id']) for r in d]
print('file order sorted by message_id asc', ids == sorted(ids))
print('message_id min', min(ids), 'max', max(ids))
# gaps in message_id
s = sorted(set(ids))
rng = max(s) - min(s) + 1
print('id range size', rng, 'present', len(s), 'missing_in_range', rng - len(s))
gaps = [(s[i+1]-s[i], s[i], s[i+1]) for i in range(len(s)-1)]
gaps.sort(reverse=True)
print('largest id gaps (gap, prev_id, next_id):', gaps[:10])
gc = collections.Counter(g for g,_,_ in gaps)
print('gap-size histogram (gap:count) top:', sorted(gc.items())[:20])
# time gaps between consecutive messages in message_id order
byid = sorted(d, key=lambda r: int(r['message_id']))
tg = []
for a, b in zip(byid, byid[1:]):
    dt = (pdt(b['date']) - pdt(a['date'])).total_seconds()
    tg.append((dt, a['message_id'], b['message_id'], a['date'], b['date']))
tg_sorted = sorted(tg, reverse=True)
print('time gaps (s) largest 10 (gap_s, prev_id, next_id, prev_date, next_date):')
for t in tg_sorted[:10]: print('  ', t)
# is date monotonic with message_id?
nonmono = sum(1 for a,b in zip(byid, byid[1:]) if pdt(b['date']) < pdt(a['date']))
print('date decreasing when message_id increases (count):', nonmono)
print('median time gap s', statistics.median([t[0] for t in tg]), 'mean', round(statistics.mean([t[0] for t in tg]),1))
# empty text
empty = [r for r in d if not (r['text'] or '').strip()]
print('empty/whitespace text', len(empty))
print('empty text ids sample', [r['message_id'] for r in empty][:20])
print('empty text: is_signal true', sum(1 for r in empty if r['is_signal']))
# duplicate text
tc = collections.Counter((r['text'] or '') for r in d if (r['text'] or '').strip())
print('distinct non-empty texts', len(tc), 'texts occurring >1', sum(1 for v in tc.values() if v>1), 'max occurrences', tc.most_common(1)[0][1])
# edits
ed = [r for r in d if r['edit_date'] is not None]
print('edit_date non-null', len(ed), 'of', len(d), f"({100*len(ed)/len(d):.1f}%)")
delays = []
neg = []
for r in ed:
    dd = (pdt(r['edit_date']) - pdt(r['date'])).total_seconds()
    if dd < 0: neg.append(r['message_id'])
    delays.append(dd)
if delays:
    delays_sorted = sorted(delays)
    n=len(delays_sorted)
    print('edit delay seconds: min', delays_sorted[0], 'p25', delays_sorted[n//4], 'median', statistics.median(delays_sorted), 'p75', delays_sorted[3*n//4], 'max', delays_sorted[-1])
    print('edit before post (negative delay) count', len(neg), neg[:10])
    zero = sum(1 for x in delays if x == 0)
    print('edit delay exactly 0 s', zero)
    print('edit delay <= 60s', sum(1 for x in delays if x <= 60), ' <= 1h', sum(1 for x in delays if x <= 3600), ' <= 1d', sum(1 for x in delays if x <= 86400), ' >1d', sum(1 for x in delays if x > 86400))
    print('edit_date min', min(pdt(r['edit_date']) for r in ed).isoformat(), 'max', max(pdt(r['edit_date']) for r in ed).isoformat())
    print('edit_date after fetched_at count', sum(1 for r in ed if pdt(r['edit_date']) > pdt(r['fetched_at'])))
# edits by signal status
print('edited & is_signal', sum(1 for r in ed if r['is_signal']), 'of is_signal', sum(1 for r in d if r['is_signal']))
print('non-edited & is_signal', sum(1 for r in d if r['edit_date'] is None and r['is_signal']))
print('non-edited records message_ids', [r['message_id'] for r in d if r['edit_date'] is None][:30])
print('non-edited records dates', [r['date'] for r in d if r['edit_date'] is None][:5])
print('is_post', collections.Counter(r['is_post'] for r in d), 'grouped_id nonnull', sum(1 for r in d if r['grouped_id']), 'distinct grouped', len(set(r['grouped_id'] for r in d if r['grouped_id'])))
print('reply_to nonnull', sum(1 for r in d if r['reply_to_msg_id'] is not None))
print('reply_to values sample', [(r['message_id'], r['reply_to_msg_id']) for r in d if r['reply_to_msg_id']][:15])
