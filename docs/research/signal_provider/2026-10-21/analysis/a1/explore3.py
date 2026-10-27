import json, collections, re
d = json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json', encoding='utf-8'))
ns = [r for r in d if not r['is_signal'] and (r['text'] or '').strip()]
def show(rs, n=3, maxlen=260):
    for r in rs[:n]:
        print('  id', r['message_id'], 'reply', r['reply_to_msg_id'], 'len', len(r['text']))
        print('    ', repr(r['text'][:maxlen]))
print('== SELL/BUY GOLD NOW header-only non-signals (count, sample)')
hdr = [r for r in ns if re.match(r'^\s*(BUY|SELL)\s+GOLD\s+NOW', r['text'], re.I)]
print('count', len(hdr), 'with OPEN/ENTRY', sum(1 for r in hdr if re.search(r'\b(OPEN|ENTRY)', r['text'], re.I)), 'with SL', sum(1 for r in hdr if re.search(r'\bSL|STOP\s*LOSS', r['text'], re.I)), 'with TP', sum(1 for r in hdr if re.search(r'\bTP\s*\d', r['text'], re.I)))
print('length distribution', collections.Counter(min(len(r['text'])//20*20,200) for r in hdr))
show(hdr, 6)
print('== SHORT / LONG POSITION')
sh = [r for r in ns if re.search(r'\b(SHORT|LONG)\b', r['text'], re.I)]
print('count', len(sh))
show(sh, 8, 400)
print('== Buy/Sell position setup active')
show([r for r in ns if re.search(r'setup', r['text'], re.I)], 5, 300)
print('== texts with OPEN/ENTRY and SL and TP not signal')
x=[r for r in ns if re.search(r'\b(OPEN|ENTRY)\b',r['text'],re.I) and re.search(r'\bSL\b|STOP\s*LOSS',r['text'],re.I) and re.search(r'\bTP\s*\d',r['text'],re.I)]
print('count', len(x)); show(x, 6, 400)
