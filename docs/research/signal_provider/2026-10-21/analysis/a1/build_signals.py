# Task 3: build signals.csv from every is_signal record (stored parsed fields; parity verified by compare_parsers.py).
import json, csv, hashlib, re, collections, sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1')
import parser_port as pp
from datetime import datetime, timezone
S='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
d = json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json', encoding='utf-8'))
def pdt(s):
    fmt = '%Y-%m-%dT%H:%M:%S.%fZ' if '.' in s else '%Y-%m-%dT%H:%M:%SZ'
    return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
def iso(dt): return dt.strftime('%Y-%m-%dT%H:%M:%SZ')
sigs = [r for r in d if r['is_signal']]
maxtp = max(len(r['signal']['takeProfits']) for r in sigs)
hdr = ['message_id','chat_id','date_utc','edit_date_utc','edit_delay_s','fetched_at_utc','reply_to_msg_id','text_sha1','text_len',
       'symbol','direction','order_type','entry_key','entry_low','entry_high','entry_width','entry_mid','sl','sl_dist_from_mid',
       'num_tps'] + [f'tp{i}' for i in range(1, maxtp+1)] + ['tp1_dist_from_mid','tp_last_dist_from_mid','sl_side_ok','tp_side_ok',
       'tp_monotonic_ok','comma_decimal_in_text','layout_first_line']
out=[]
for r in sigs:
    t = r['text']; s = r['signal']
    em = pp.ENTRY_REGEX.search(t)
    entry_key = re.sub(r'\s+', ' ', em.group(0).split(':')[0].split('-')[0].strip().upper())
    entry_key = re.sub(r'[\d.\s-]+$', '', entry_key)
    mid = (s['entryLow'] + s['entryHigh']) / 2
    tps = s['takeProfits']
    edit = r['edit_date']
    delay = (pdt(edit) - pdt(r['date'])).total_seconds() if edit else ''
    first = re.sub(r'[^\x00-\x7F]', '', t.strip().split('\n')[0]).upper()
    first = re.sub(r'\s+', ' ', first).strip()
    if s['direction']=='buy':
        sl_side = s['stopLoss'] < s['entryLow']; tp_side = tps[0] > s['entryHigh']
    else:
        sl_side = s['stopLoss'] > s['entryHigh']; tp_side = tps[0] < s['entryLow']
    mono = all((tps[i]>tps[i-1]) if s['direction']=='buy' else (tps[i]<tps[i-1]) for i in range(1,len(tps)))
    row = {'message_id': int(r['message_id']), 'chat_id': r['chat_id'], 'date_utc': iso(pdt(r['date'])),
           'edit_date_utc': iso(pdt(edit)) if edit else '', 'edit_delay_s': int(delay) if delay!='' else '',
           'fetched_at_utc': iso(pdt(r['fetched_at'])), 'reply_to_msg_id': r['reply_to_msg_id'] or '',
           'text_sha1': hashlib.sha1(t.encode('utf-8')).hexdigest(), 'text_len': len(t),
           'symbol': s['symbol'], 'direction': s['direction'], 'order_type': s['orderType'], 'entry_key': entry_key,
           'entry_low': s['entryLow'], 'entry_high': s['entryHigh'], 'entry_width': round(s['entryHigh']-s['entryLow'],4),
           'entry_mid': mid, 'sl': s['stopLoss'], 'sl_dist_from_mid': round(abs(s['stopLoss']-mid),4), 'num_tps': len(tps)}
    for i in range(1, maxtp+1):
        row[f'tp{i}'] = tps[i-1] if i <= len(tps) else ''
    row['tp1_dist_from_mid'] = round(abs(tps[0]-mid),4)
    row['tp_last_dist_from_mid'] = round(abs(tps[-1]-mid),4)
    row['sl_side_ok'] = sl_side; row['tp_side_ok'] = tp_side; row['tp_monotonic_ok'] = mono
    row['comma_decimal_in_text'] = bool(re.search(r'\d,\d{1,2}(?!\d)', t))
    row['layout_first_line'] = first
    out.append(row)
with open(S+'/signals.csv','w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f, fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
print('rows', len(out), 'columns', len(out[0]), 'maxtp', maxtp)
print('num_tps distribution', sorted(collections.Counter(r['num_tps'] for r in out).items()))
print('layouts (first line, top 15):')
for k,v in collections.Counter(r['layout_first_line'] for r in out).most_common(15): print('  ', v, repr(k))
print('entry_key', collections.Counter(r['entry_key'] for r in out))
print('order_type', collections.Counter(r['order_type'] for r in out), 'direction', collections.Counter(r['direction'] for r in out), 'symbol', collections.Counter(r['symbol'] for r in out))
print('edit_date present', sum(1 for r in out if r['edit_date_utc']), 'of', len(out))
print('comma_decimal_in_text true', [r['message_id'] for r in out if r['comma_decimal_in_text']])
print('sl_side_ok all', all(r['sl_side_ok'] for r in out), 'tp_side_ok all', all(r['tp_side_ok'] for r in out), 'mono all', all(r['tp_monotonic_ok'] for r in out))
