# Task 2: classify every record. First matching rule wins (order below).
# Also reads ts_parse_all.json (output of ts_parse_all.mjs, run through the compiled TS parser)
# for the cancel verdict and parse error reason.
import json, re, collections, csv
S = '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
d = json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json', encoding='utf-8'))
ts = {(o['chat_id'], o['message_id']): o for o in json.load(open(S + '/ts_parse_all.json'))}

R = {
 'cancel_loose': re.compile(r'\bcancel(?:l?ed)?\b|\bdelete\s+this\s+signal\b|\bignore\s+this\s+signal\b|\binvalid\s+signal\b', re.I),
 'header_only_dir': re.compile(r'^\s*(BUY|SELL|SHORT|LONG)\b[^\n]{0,20}$', re.I),
 'dir': re.compile(r'\b(BUY|SELL|SHORT|LONG)\b', re.I),
 'sl_num': re.compile(r'\b(SL|STOP\s*LOSS)\s*:?\s*\d', re.I),
 'tp_num': re.compile(r'\bTP\s*\d+\s*:?\s*\d|(^|\n)\s*#\s*\d\s*:\s*\d|take\s*profit', re.I | re.M),
 'sl_hit': re.compile(r'\bSL\s*HIT\b|STOP\s*LOSS\s*HIT|STOPPED\s*OUT|\bSTOPPED\b', re.I),
 'tp_hit': re.compile(r'\bTP\s*\d+\s*(HITS?|REACHED|DONE)\b', re.I),
 'hit_with_tp': re.compile(r'\bHITS?\b', re.I),
 'tp_word': re.compile(r'\bTP\s*\d', re.I),
 'pips': re.compile(r'\bPIPS?\b', re.I),
 'pips_result': re.compile(r'\bOUT\b.*\bPIPS?\b|\bLOSS\b.*\bPIPS?\b|\bWIN\b.*\bPIPS?\b|[+-]\s*\d+(?:[.,]\d+)?\s*PIPS?\b|\bPIPS?\b.*\bLOSS\b|\bPIPS?\b.*\bPROFIT\b', re.I),
 'be': re.compile(r'BREAK\s*-?\s*EVEN|\bBE\b', re.I),
 'out_be': re.compile(r'\bOUT\b[^\n]{0,30}\b(BREAK\s*-?\s*EVEN|BE)\b|\bGOT\s+OUT\b|\bOUT\s+BE\b', re.I),
 'tp_at': re.compile(r'\bTP\s*\d+\s*(AT|at)\s*[\d.]+', re.I),
 'close_claim': re.compile(r'\bCLOSE\s+(NOW|ALL|THE\s+TRADE|OUT|IT|THE\s+POSITION|POSITION|PART|\d|HALF|YOUR|THIS|BOTH|MY)\b|\bFULLY\s+CLOSE\b|\bCLOSED\s+(THE\s+)?(TRADE|POSITION|BUY|SELL|TRADES?)\b|\bCLOSING\s+(THE\s+)?(TRADE|POSITION)\b', re.I),
 'running': re.compile(r'\bRUNNING\b|\bLEAVING\s+\d|\bLEFT\s+\d+\s+LOTS?\b', re.I),
}
def norm_template(t):
    x = t.strip().upper()
    x = re.sub(r'[^\x00-\x7F]', '', x)          # drop emoji / non-ascii symbols
    x = re.sub(r'\d+(?:[.,]\d+)*', '#', x)      # numbers -> #
    x = re.sub(r'\s+', ' ', x).strip(' .!:-')
    return x[:90]

def classify(r):
    t = (r['text'] or '').strip()
    key = (r['chat_id'], r['message_id'])
    if r['is_signal']:
        return 'new_signal', 'parsed_ok'
    if not t:
        return 'empty', 'no_text'
    if ts[key]['ts_cancel'] or R['cancel_loose'].search(t):
        return 'cancel', 'cancel_phrase'
    if R['header_only_dir'].search(t) and len(t) <= 40 and not R['sl_num'].search(t):
        return 'signal_header_only', 'no_levels'
    if R['dir'].search(t) and R['sl_num'].search(t) and R['tp_num'].search(t):
        return 'signal_like_unparsed', ts[key]['ts_error'] or 'unknown'
    if R['sl_hit'].search(t):
        return 'update_sl_hit', 'sl_hit_word'
    if R['tp_hit'].search(t) or (R['hit_with_tp'].search(t) and R['tp_word'].search(t)):
        return 'update_tp_hit', 'tp_hit_word'
    if R['out_be'].search(t):
        return 'update_stopped_at_be', 'out_be'
    if R['pips_result'].search(t):
        return 'update_pips_result', 'pips_result'
    if R['close_claim'].search(t):
        return 'update_close', 'close_claim'
    if R['running'].search(t):
        return 'update_running', 'running_partial'
    if R['be'].search(t):
        return 'update_be_mgmt', 'be_mention'
    if R['tp_at'].search(t):
        return 'tp_level_mention', 'tp_at_price'
    return 'commentary', 'other'

rows = []
for r in d:
    c, sub = classify(r)
    rows.append({'message_id': int(r['message_id']), 'chat_id': r['chat_id'], 'date': r['date'], 'class': c, 'subclass': sub,
                 'is_signal': r['is_signal'], 'reply_to': r['reply_to_msg_id'], 'len': len((r['text'] or '').strip()),
                 'template': norm_template(r['text'] or '') if c not in ('new_signal',) else 'SIGNAL',
                 'text': (r['text'] or '').strip()})
with open(S + '/classes.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)
cnt = collections.Counter(x['class'] for x in rows)
print('CLASS COUNTS (all 3317)')
for k, v in cnt.most_common(): print(f'  {k:24s} {v:5d}  {100*v/len(rows):5.1f}%')
print('subclass counts')
for k, v in collections.Counter((x['class'], x['subclass']) for x in rows).most_common(): print('  ', k, v)
