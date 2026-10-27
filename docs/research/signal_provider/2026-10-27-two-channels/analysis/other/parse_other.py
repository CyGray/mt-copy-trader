"""Parsers for the two extra channels (written 2026-10-27, before any outcome was looked at).

A  -1004427167750   "XAUUSD BUY NOW <a> <b> / TP¹ <t1> ... TP⁵ <t5> / TP. Open / SL <s>" (schematic)
   Zone typo rule (fixed in advance): if the second zone number differs from the first by more than 50 USD, rebuild it
   from the first number's leading digits plus its own last three digits; accept the rebuilt value only if it lies
   within 10 USD of the first (flag zone_typo_corrected), otherwise reject the signal (zone_typo_unresolved).
B  -1004426286726   "SELL GOLD NOW / ENTRY: 4155 / TP1: 4151 ... TP8: 4127 / SL: 4165"
usage: parse_other.py REVISIONS_JSON CHANNEL_TAG OUT_UNIVERSE_CSV   (final revision of each message; date = post time)"""
import csv, datetime as dt, json, re, sys, collections
SUP = str.maketrans('¹²³⁴⁵⁶⁷⁸⁹⁰', '1234567890')
def norm(t): return (t or '').translate(SUP)
def parse(t):
    t = norm(t); info = []
    m = re.search(r'\b(BUY|SELL)\b(?:\s+GOLD)?(?:\s+NOW)?\s*:?\s*(\d{4}(?:\.\d+)?)?(?:\s*[-–]?\s*(\d{4}(?:\.\d+)?))?', t, re.I)
    if not m: return None, 'no_direction'
    d = m.group(1).lower(); a = m.group(2); b = m.group(3)
    if not a:
        e = re.search(r'\bENTRY\s*:?\s*(\d{4}(?:\.\d+)?)(?:\s*[-–]\s*(\d{4}(?:\.\d+)?))?', t, re.I)
        if not e: return None, 'no_entry'
        a, b = e.group(1), e.group(2)
    a = float(a); b = float(b) if b else a
    if abs(b - a) > 50:
        fixed = float(str(int(a))[:-3] + str(int(b))[-3:])
        if abs(fixed - a) <= 10: info.append(f'zone_typo_corrected_{b:g}_to_{fixed:g}'); b = fixed
        else: return None, 'zone_typo_unresolved'
    sl = re.search(r'\bSL\s*:?\s*(\d{4}(?:\.\d+)?)', t, re.I)
    tps = [float(v) for _, v in sorted(re.findall(r'\bTP\s*(\d)\s*:?\s*(\d{4}(?:\.\d+)?)', t, re.I), key=lambda x: int(x[0]))]
    if not sl or not tps: return None, 'no_sl_or_tp'
    if re.search(r'\bTP\.?\s*Open', t, re.I): info.append('open_last_tp')
    lo, hi, sl = min(a, b), max(a, b), float(sl.group(1)); sgn = 1 if d == 'buy' else -1
    if (sl - (lo + hi) / 2) * sgn >= 0: return None, 'sl_wrong_side'
    for i in range(1, len(tps)):
        if (tps[i] - tps[i - 1]) * sgn <= 0: return None, 'tp_order'
    return dict(direction=d, lo=lo, hi=hi, sl=sl, tps=tps, info=info), None
if __name__ == '__main__':
    rows = json.load(open(sys.argv[1])); tag = sys.argv[2]
    by = collections.defaultdict(list)
    for r in rows: by[int(r['message_id'])].append(r)
    out, stats = [], collections.Counter()
    ms = lambda s: int(dt.datetime.fromisoformat(str(s).replace('Z', '+00:00')).timestamp() * 1000)
    for mid in sorted(by):
        fin = sorted(by[mid], key=lambda r: str(r.get('edit_date') or ''))[-1]
        s, err = parse(fin.get('text'))
        stats[err or 'signal'] += 1
        if not s: continue
        emid = (s['lo'] + s['hi']) / 2; tps = s['tps'][:7]
        out.append(dict(message_id=mid, t_iso=str(fin['date']), t_ms=ms(fin['date']), direction=s['direction'], entry_low=s['lo'],
                        entry_high=s['hi'], entry_mid=emid, sl=s['sl'], **{f'tp{k}': (tps[k - 1] if k <= len(tps) else '') for k in range(1, 8)},
                        num_tps=len(s['tps']), sl_dist=round(abs(s['sl'] - emid), 3), hard_flags='', info_flags=';'.join(s['info']), in_clean=1,
                        lead_in_prev_header=0))
    with open(sys.argv[3], 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()) if out else ['message_id']); w.writeheader(); w.writerows(out)
    print(tag, dict(stats)); [print(' ', r['message_id'], r['t_iso'][:16], r['direction'], r['entry_low'], r['entry_high'], 'sl', r['sl'], 'tps', [r[f'tp{k}'] for k in range(1, 8) if r[f'tp{k}'] != ''], r['info_flags']) for r in out]
