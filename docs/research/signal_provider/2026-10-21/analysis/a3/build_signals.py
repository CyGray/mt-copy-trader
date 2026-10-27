"""Independent signal + outcome extraction from .data/vip_history.json (read-only input).

Outputs (in derived/):
  signals_a3.csv   one row per is_signal message, re-parsed from raw text, plus stored-parse comparison
  outcomes_a3.csv  one row per outcome-like non-signal message (TP hit / BE / loss) with linked signal
usage: build_signals.py HISTORY_JSON OUTDIR
"""
import json, re, csv, sys, os, datetime as dt, collections

HIST, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
msgs = json.load(open(HIST, encoding='utf-8'))
msgs.sort(key=lambda m: m['date'])
by_id = {m['message_id']: m for m in msgs}

NUM = r'(\d+(?:[.,]\d+)?)'

def num(s):
    return float(s.replace(',', '.'))

def parse_signal_text(t):
    """Return dict with entry_low/high, sl, tps (list), dir, or None fields."""
    up = t.upper()
    d = None
    if re.search(r'\bSELL\b|\bSHORT\b', up):
        d = 'sell'
    if re.search(r'\bBUY\b|\bLONG\b', up):
        d = 'buy' if d is None or re.search(r'\bBUY\b', up) and up.find('BUY') < (up.find('SELL') if 'SELL' in up else 10**9) else d
    m = re.search(r'(?:OPEN(?:\s*RANGE)?|ENTRY(?:\s*ZONE)?)\s*:?\s*' + NUM + r'(?:\s*-\s*(\d+(?:[.,]\d+)?))?', t, re.I)
    el = eh = None
    if m:
        el = num(m.group(1))
        if m.group(2):
            h = m.group(2)
            if '.' not in h and ',' not in h and len(h) < len(m.group(1).split('.')[0].split(',')[0]):
                h = m.group(1).split('.')[0].split(',')[0][:-len(h)] + h  # '4976-79' -> 4979
            eh = num(h)
        else:
            eh = el
    sl = None
    m = re.search(r'(?:\bSL|STOP\s*LOSS)\s*:?\s*' + NUM, t, re.I)
    if m:
        sl = num(m.group(1))
    tps = []
    for k, v in re.findall(r'\bTP\s*(\d)\s*:?\s*' + NUM, t, re.I):
        tps.append((int(k), num(v)))  # appearance order kept below
    tps = [v for _, v in tps]
    return dict(dir=d, entry_low=el, entry_high=eh, sl=sl, tps=tps)

rows = []
mism = collections.Counter()
for m in msgs:
    if not m.get('is_signal'):
        continue
    p = parse_signal_text(m['text'] or '')
    s = m.get('signal') or {}
    stored_tps = s.get('takeProfits') or []
    cmp = {
        'entry_match': p['entry_low'] == s.get('entryLow') and p['entry_high'] == s.get('entryHigh'),
        'sl_match': p['sl'] == s.get('stopLoss'),
        'tp_match': [round(x, 6) for x in p['tps']] == [round(float(x), 6) for x in stored_tps],
        'dir_match': p['dir'] == s.get('direction'),
    }
    for k, v in cmp.items():
        if not v:
            mism[k] += 1
    has_comma_sl = bool(re.search(r'\bSL\s*:?\s*\d+,\d', m['text'] or '', re.I))
    rows.append(dict(
        msg_id=m['message_id'], date_utc=m['date'], edit_date=m.get('edit_date') or '',
        direction=s.get('direction'), dir_reparse=p['dir'],
        entry_low=s.get('entryLow'), entry_high=s.get('entryHigh'), stop_loss=s.get('stopLoss'),
        tps=';'.join(str(x) for x in stored_tps),
        reparse_entry_low=p['entry_low'], reparse_entry_high=p['entry_high'],
        reparse_sl=p['sl'], reparse_tps=';'.join(str(x) for x in p['tps']),
        entry_match=int(cmp['entry_match']), sl_match=int(cmp['sl_match']),
        tp_match=int(cmp['tp_match']), dir_match=int(cmp['dir_match']),
        sl_decimal_comma=int(has_comma_sl), edited=int(bool(m.get('edit_date'))),
        text=(m['text'] or '').replace('\n', ' | ')[:400],
    ))

with open(os.path.join(OUT, 'signals_a3.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)

# ---- outcomes ----
TP_RE = re.compile(r'\bTP\s*(\d)\s*(?:HIT|AT|JUST HIT|Hit)\b', re.I)
PIPS_RE = re.compile(r'(\d+(?:[.,]\d+)?)\s*PIPS?', re.I)
BE_RE = re.compile(r'BREAK\s*EVEN|(?<![A-Za-z])BE(?![A-Za-z])')
LOSS_RE = re.compile(r'\bOUT\b|LOSS|SL\s*HIT|STOP\s*HIT', re.I)
sig_msgs = [m for m in msgs if m.get('is_signal')]
sig_times = [(dt.datetime.fromisoformat(m['date'].replace('Z', '+00:00')), m) for m in sig_msgs]
orows = []
kinds = collections.Counter()
for m in msgs:
    if m.get('is_signal'):
        continue
    t = m['text'] or ''
    kind = None
    k = None
    mt = TP_RE.search(t)
    if mt:
        kind = 'TP_HIT'; k = int(mt.group(1))
    elif BE_RE.search(t):
        kind = 'BE'
    elif LOSS_RE.search(t) and PIPS_RE.search(t) and re.search(r'LOSS', t, re.I):
        kind = 'LOSS'
    if kind is None:
        continue
    kinds[kind] += 1
    tm = dt.datetime.fromisoformat(m['date'].replace('Z', '+00:00'))
    link = None
    for st, sm in reversed(sig_times):
        if st <= tm:
            if (tm - st).total_seconds() <= 72 * 3600:
                link = sm
            break
    pips = None
    pm = PIPS_RE.search(t)
    if pm:
        pips = num(pm.group(1))
    orows.append(dict(
        msg_id=m['message_id'], date_utc=m['date'], kind=kind, tp_index=k or '',
        claimed_pips=pips if pips is not None else '',
        linked_signal_msg=link['message_id'] if link else '',
        linked_signal_date=link['date'] if link else '',
        reply_to=m.get('reply_to_msg_id') or '',
        text=t.replace('\n', ' | ')[:300],
    ))
with open(os.path.join(OUT, 'outcomes_a3.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=list(orows[0].keys()))
    w.writeheader(); w.writerows(orows)

print('signals', len(rows), 'mismatch vs stored parse', dict(mism))
print('sl_decimal_comma', sum(r['sl_decimal_comma'] for r in rows), 'edited', sum(r['edited'] for r in rows))
print('dir_match', sum(r['dir_match'] for r in rows), 'of', len(rows))
print('outcome kinds', dict(kinds), 'linked', sum(1 for r in orows if r['linked_signal_msg']))
