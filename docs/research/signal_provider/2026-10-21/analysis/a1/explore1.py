import json, collections
p='/home/kyle/projects/ByTrader/.data/vip_history.json'
d=json.load(open(p,encoding='utf-8'))
chats=collections.Counter(r['chat_id'] for r in d)
print('chats',chats)
print('is_signal',collections.Counter(r['is_signal'] for r in d))
print('is_post',collections.Counter(r['is_post'] for r in d))
print('signal types',collections.Counter(type(r['signal']).__name__ for r in d))
sig=[r for r in d if r['signal'] is not None]
print('signal keys',collections.Counter(tuple(sorted(r['signal'].keys())) for r in sig))
print('is_signal & signal None', sum(1 for r in d if r['is_signal'] and r['signal'] is None))
print('signal not None & is_signal False', sum(1 for r in d if (not r['is_signal']) and r['signal'] is not None))
print('grouped_id nonnull', sum(1 for r in d if r['grouped_id'] is not None))
print('reply nonnull', sum(1 for r in d if r['reply_to_msg_id'] is not None))
print('edit nonnull', sum(1 for r in d if r['edit_date'] is not None))
print('empty text', sum(1 for r in d if not (r['text'] or '').strip()))
print('text None', sum(1 for r in d if r['text'] is None))
print('---- sample signal record')
for r in sig[:2]:
    print(json.dumps(r,ensure_ascii=False,indent=1)[:1500])
print('---- sample is_signal record texts')
for r in [x for x in d if x['is_signal']][:2]:
    print(repr(r['text']))
