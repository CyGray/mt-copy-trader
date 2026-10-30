"""Parse every GAB FX signal format (Feb-Oct 2026) into normalized records."""
import json, re, sys, collections, datetime as dt
SRC = "/tmp/claude-1001/twochan/gab/live/messages.json"
NUM = r"(\d{1,6}(?:\.\d+)?)"
FX = ['EURUSD','GBPUSD','AUDUSD','NZDUSD','USDCHF','USDCAD','EURGBP','EURCHF','EURAUD','GBPCHF','GBPAUD','AUDCAD','AUDNZD',
      'USDJPY','EURJPY','GBPJPY','AUDJPY','CADJPY','CHFJPY','NZDJPY','EURCAD','EURNZD','GBPCAD','GBPNZD']
PIP = lambda s: 0.1 if s == 'XAUUSD' else (0.01 if s.endswith('JPY') else 0.0001)

def symbol_of(t):
    u = t.upper()
    if re.search(r"XAU+USD|\bGOLD\b", u): return 'XAUUSD'
    for s in FX:
        if s in u.replace('/', ''): return s
    if re.search(r"BTC", u): return 'BTCUSD'
    if re.search(r"US30|US100|NAS|STEP|VOLATILITY|BOOM|CRASH", u): return 'INDEX'
    return None

def parse(text):
    t = text.replace('\u00a0', ' ').translate(str.maketrans('¹²³⁴⁵⁶', '123456'))
    head = t[:200]
    m = re.search(r"\b(BUY|SELL)\b", head, re.I) or re.search(r"_(BUY|SELL)\b", head, re.I)
    if not m: return None
    side = m.group(1).upper()
    sym = symbol_of(head)
    if not sym: return None
    slm = re.search(r"(?:\bSL\b|STOP\s*LOSS|STOPLOSS)[^\d\n]{0,6}?" + NUM, t, re.I)
    if not slm: return None
    sl = float(slm.group(1))
    # entry: "@ a - b", "@a", "SYMBOL a", "_Buy a/b", "SELL a"
    RNG = r"(?:\s*[-/–_]\s*" + NUM + r")?"
    em = (re.search(r"@\s*" + NUM + RNG, head) or re.search(r"(?:ENTRY\s*:?|STOP AT|LIMIT AT)\s*" + NUM + RNG, head, re.I)
          or re.search(r"(?:XAU+USD|" + "|".join(FX) + r")\s*(?:_?(?:BUY|SELL))?\s*/?" + NUM + RNG, head, re.I)
          or re.search(r"\b(?:BUY|SELL)\b\s*(?:NOW)?\s*" + NUM + RNG, head, re.I))
    market_only = False
    if em:
        e1 = float(em.group(1)); e2 = float(em.group(2)) if em.group(2) else e1
    elif re.search(r"\bNOW\b", head, re.I):
        market_only = True; e1 = e2 = None
    else:
        return None
    tps = [float(x) for x in re.findall(r"(?:\bTP|TAKE\s*PROFIT)\s*(?:\.?\d\.?\s*[:\-=]\s*|\.?\d\.?\s+(?=\d{2})|[:\-=]?\s*)" + NUM + r"\b(?!\s*pips)", t, re.I)]
    pip_tps = []
    pm = re.search(r"\bTP\s*[:\-]?\s*(.*)", t, re.I)
    if not tps and pm:
        pip_tps = [float(x) for x in re.findall(NUM + r"\s*pips", t[pm.start():pm.start() + 80], re.I)]
    sgn = 1 if side == 'BUY' else -1
    # gold prices sometimes written without the thousands (e.g. 4180 vs 180): ignore
    if market_only:
        return dict(side=side, symbol=sym, entry_lo=None, entry_hi=None, sl=sl, tps=tps, pip_tps=False, market_only=True) if tps else None
    lo, hi = min(e1, e2), max(e1, e2)
    ref = hi if side == 'BUY' else lo   # first edge price reaches when the zone is approached from a trend-continuation view
    if pip_tps:
        tps = [round(ref + sgn * p * PIP(sym), 5) for p in pip_tps]
    if not tps: return None
    return dict(side=side, symbol=sym, entry_lo=lo, entry_hi=hi, sl=sl, tps=tps, pip_tps=bool(pip_tps), market_only=False)

def sane(r):
    sgn = 1 if r['side'] == 'BUY' else -1
    if r['market_only']:
        return 'ok' if sgn * (r['tps'][0] - r['sl']) > 0 else 'tp_wrong_side'
    mid = (r['entry_lo'] + r['entry_hi']) / 2
    if sgn * (mid - r['sl']) <= 0: return 'sl_wrong_side'
    if any(sgn * (tp - mid) <= 0 for tp in r['tps'][:1]): return 'tp_wrong_side'
    if r['symbol'] == 'XAUUSD' and not (1500 < mid < 7000): return 'price_scale'
    return 'ok'

def load():
    M = json.load(open(SRC)); M.sort(key=lambda m: m['ID'])
    out = []
    for m in M:
        t = m.get('Text') or ''
        r = parse(t)
        if not r: continue
        r.update(id=m['ID'], date=m['Date'], edit=m.get('EditDate'), fwd=bool(m.get('Fwd')),
                 fwd_from=(m.get('Fwd') or {}).get('from'), views=m.get('Views'), first=t.strip().split('\n')[0][:30])
        r['check'] = sane(r)
        out.append(r)
    # dedupe reposts: same side/symbol/sl/entry within 24h -> keep earliest
    seen = {}; 
    for r in out:
        k = (r['symbol'], r['side'], r['sl'], r['entry_lo'], r['entry_hi'])
        if k in seen and r['date'] - seen[k]['date'] < 86400:
            r['dup_of'] = seen[k]['id']
        else:
            seen[k] = r
    return out

if __name__ == '__main__':
    S = load()
    print('parsed', len(S), collections.Counter(r['symbol'] for r in S))
    print('checks', collections.Counter(r['check'] for r in S), 'dups', sum('dup_of' in r for r in S))
    by = collections.defaultdict(list)
    for r in S: by[re.sub(r'\d+(\.\d+)?', '#', r['first'])].append(r)
    for k, v in sorted(by.items(), key=lambda kv: -len(kv[1]))[:14]:
        r = v[len(v) // 2]
        print(f"{len(v):4d} {k!r}: id={r['id']} {r['side']} {r['symbol']} {r['entry_lo']}-{r['entry_hi']} sl={r['sl']} tps={r['tps']} {r['check']}")
    bad = [r for r in S if r['check'] != 'ok']
    for r in bad[:10]: print('BAD', r['id'], r['check'], r['side'], r['entry_lo'], r['entry_hi'], r['sl'], r['tps'])
    json.dump(S, open('/tmp/claude-1001/twochan/gab/study/signals.json', 'w'))
