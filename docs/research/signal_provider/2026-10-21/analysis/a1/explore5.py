import json, collections, re, random
d = json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json', encoding='utf-8'))
ns = [r for r in d if not r['is_signal'] and (r['text'] or '').strip()]
def show(label, rs, n=6, maxlen=160):
    print('==', label, len(rs))
    for r in rs[:n]:
        print('   ', r['message_id'], repr(r['text'][:maxlen]))
show('CLOSE', [r for r in ns if re.search(r'\bCLOSE', r['text'], re.I)], 10)
show('RUNNING', [r for r in ns if re.search(r'RUNNING', r['text'], re.I)], 5)
show('SL HIT', [r for r in ns if re.search(r'SL\s*HIT|STOPPED', r['text'], re.I)], 5)
show('SIGNAL', [r for r in ns if re.search(r'SIGNAL', r['text'], re.I)], 10)
show('TP AT', [r for r in ns if re.search(r'\bTP\s*\d+\s*AT\b', r['text'], re.I)], 8)
show('n/n', [r for r in ns if re.search(r'\d+/\d+', r['text'])], 8)
show('hash style', [r for r in ns if re.search(r'(^|\n)\s*#\s*\d\s*:', r['text'])], 3, 300)
show('TP colon style', [r for r in ns if re.search(r'\bTP\s*\d\s*:', r['text'], re.I)], 4, 300)
show('LOTS', [r for r in ns if re.search(r'\bLOTS?\b', r['text'], re.I)], 6)
