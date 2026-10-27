import json, collections, re, random
d = json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json', encoding='utf-8'))
ns = [r for r in d if not r['is_signal'] and (r['text'] or '').strip()]
print('non-signal non-empty', len(ns))
# first-line normalized
def norm(t):
    t = re.sub(r'\d+(?:[.,]\d+)?', '#', t)
    return t
c = collections.Counter(norm(r['text'].strip().split('\n')[0])[:70] for r in ns)
print('distinct first-line templates', len(c))
for k,v in c.most_common(60): print(v, repr(k))
