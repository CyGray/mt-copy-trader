import json, collections, re
d = json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json', encoding='utf-8'))
ns = [r for r in d if not r['is_signal'] and (r['text'] or '').strip()]
pats = {
 'TPn HIT': r'\bTP\s*\d+\s*HIT\b',
 'TPn hit (any case)': r'\bTP\s*\d+\s*hit',
 'TPn AT': r'\bTP\s*\d+\s*AT\b',
 'TPn word': r'\bTP\s*\d',
 'HIT word': r'\bHIT\b',
 'PIPS': r'PIPS?\b',
 'SL HIT': r'\bSL\s*HIT\b|STOP\s*LOSS\s*HIT|\bSTOPPED\b|\bSL\s*HIT',
 'BREAK EVEN': r'BREAK\s*-?\s*EVEN|\bBE\b',
 'SL word': r'\bSL\b|STOP\s*LOSS',
 'CLOSE': r'\bCLOSE(D|S)?\b',
 'CLOSE NOW': r'CLOSE\s+NOW',
 'RUNNING': r'RUNNING',
 'LOTS': r'\bLOTS?\b',
 'CANCEL': r'CANCEL',
 'DELETE': r'DELETE',
 'IGNORE': r'IGNORE',
 'INVALID': r'INVALID',
 'SIGNAL word': r'SIGNAL',
 'BUY/SELL word': r'\b(BUY|SELL)\b',
 'SHORT/LONG': r'\b(SHORT|LONG)\b',
 'OPEN word': r'\bOPEN\b',
 'ENTRY word': r'\bENTRY\b',
 'OPEN RANGE': r'OPEN\s*RANGE',
 'Hash-1 TP style': r'(^|\n)\s*#\s*\d\s*:',
 'TP colon style': r'\bTP\s*\d\s*:',
 'emoji any': r'[\U0001F300-\U0001FAFF☀-➿⭐✅❌]',
 'Q/?': r'\?',
}
for k, p in pats.items():
    n = sum(1 for r in ns if re.search(p, r['text'], re.I))
    print(f'{k:22s} {n:5d} of {len(ns)} non-signal non-empty')
print('-- counts over ALL records (incl is_signal)')
for k in ['cancel','CANCEL','close','Close','CLOSE','running','HIT','hit','BE','break']:
    print(k, sum(1 for r in d if k in (r['text'] or '')))
