# Task 2 (refined): classify every record. First matching rule wins.
# Reads ts_parse_all.json (compiled TS parser output) for cancel verdict and parse error reason.
import json, re, collections, csv
S = '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
d = json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json', encoding='utf-8'))
ts = {(o['chat_id'], o['message_id']): o for o in json.load(open(S + '/ts_parse_all.json'))}
RX = {
 'cancel_loose': r'\bcancel(?:l?ed)?\b|\bdelete\s+this\s+signal\b|\bignore\s+this\s+signal\b|\binvalid\s+signal\b',
 'header_dir': r'^\s*(BUY|SELL|SHORT|LONG)\b[^\n]{0,20}$',
 'dir': r'\b(BUY|SELL|SHORT|LONG)\b',
 'sl_num': r'\b(SL|STOP\s*LOSS)\s*:?\s*\d',
 'tp_num': r'\bTP\s*\d+\s*:?\s*\d|(^|\n)\s*#\s*\d\s*:\s*\d|take\s*profit\s*levels',
 'sl_hit': r'\bSL\s*HITS?\b|STOP\s*LOSS\s*HITS?\b|\bSTOPPED\s*OUT\b',
 'tp_hit': r'\bTP\s*\d*\s*(HITS?|REACHED|DONE|TOUCHED)\b|\bTP\s*\d+\b[^\n]{0,20}(?<![\w.])\+\s*\d+(?:[.,]\d+)?\s*PIPS?\b',
 'tp_hit_loose': r'\bHITS?\b[^\n]{0,40}\bTP|\bTP\b[^\n]{0,40}\bHITS?\b',
 'out_claim': r'^\s*(FULLY\s+|REST\s+|JUST\s+|GOT\s+|WE\s+GOT\s+)?OUT\b|\bGOT\s+OUT\s+(AT\s+)?(BREAK\s*-?\s*EVEN|BE)\b|\bOUT\s+(AT\s+|FOR\s+THE\s+REST\s*)?(BREAK\s*-?\s*EVEN|BE)\b|\bREST\s+OUT\b|\bOUT\s+FOR\s+THE\s+REST\b',
 'pips_claim': r'(?<![\w.])[+-]\s*\d+(?:[.,]\d+)?\s*PIPS?\b|\b\d+\s*PIPS?\s*(LOSS|PROFIT|WIN)\b|\b(TOOK|TAKE)\s+A?\s*\d+\s*PIPS?\s*LOSS|\bUP\s+\d+\s*PIPS?\b|\bMADE\s+\d+\s*PIPS?\b|\b(WIN|LOSS)\s+(OF\s+)?\d+\s*PIPS?\b',
 'close_claim': r'\bCLOSE\s+(NOW|ALL|THE\s+TRADE|OUT|IT|THE\s+POSITION|POSITION|PART|PARTIAL|\d|HALF|YOUR|THIS|BOTH|MY)\b|\bFULLY\s+CLOSE\b|\bCLOSED\s+(\d+\s+)?(LOTS?\s+|THE\s+)?(TRADE|POSITION|BUY|SELL|TRADES?)?\b|\bCLOSING\s+(THE\s+)?(TRADE|POSITION)\b|\bCLOSE\s+PARTIALS?\b',
 'running': r'\bRUNNING\b|\bLEAVING\s+\d|\bLEFT\s+\d+\s+LOTS?\b|\bLEAVE\s+\d+\s+LOTS?\b',
 'be': r'BREAK\s*-?\s*EVEN|\bBE\b',
 'tp_at': r'\bTP\s*\d+\s*(AT|at)\s*[\d.]+',
 'sl_only': r'^\s*(SL|STOP\s*LOSS)\s*:?\s*[\d.]+\s*\S{0,6}\s*$',
}
C = {k: re.compile(v, re.I | re.M) for k, v in RX.items()}
def norm_template(t):
    x = t.strip().upper()
    x = re.sub(r'[^\x00-\x7F]', '', x)
    x = re.sub(r'\d+(?:[.,]\d+)*', '#', x)
    x = re.sub(r'\s+', ' ', x).strip(' .!:-')
    return x[:90]
def classify(r):
    t = (r['text'] or '').strip()
    key = (r['chat_id'], r['message_id'])
    if r['is_signal']:
        return 'new_signal', 'parsed_ok'
    if not t:
        return 'empty', 'no_text'
    if ts[key]['ts_cancel'] or C['cancel_loose'].search(t):
        return 'cancel', 'cancel_phrase'
    if C['header_dir'].search(t) and len(t) <= 40 and not C['sl_num'].search(t):
        return 'signal_header_only', 'no_levels'
    if C['dir'].search(t) and C['sl_num'].search(t) and C['tp_num'].search(t):
        return 'signal_like_unparsed', ts[key]['ts_error'] or 'unknown'
    if C['sl_hit'].search(t):
        return 'update_sl_hit', 'sl_hit'
    if C['tp_hit'].search(t) or C['tp_hit_loose'].search(t):
        return 'update_tp_hit', 'tp_hit'
    if C['out_claim'].search(t):
        return 'update_stopped_at_be', 'out_claim'
    if C['pips_claim'].search(t):
        return 'update_pips_claim', 'pips_claim'
    if C['close_claim'].search(t):
        return 'update_close', 'close_claim'
    if C['running'].search(t):
        return 'update_running', 'running_partial'
    if C['tp_at'].search(t):
        return 'tp_level_mention', 'tp_at_price'
    if C['sl_only'].search(t):
        return 'sl_level_mention', 'sl_price_only'
    if C['be'].search(t):
        return 'update_be_mgmt', 'be_mention'
    return 'commentary', 'other'
rows = []
for r in d:
    c, sub = classify(r)
    rows.append({'message_id': int(r['message_id']), 'chat_id': r['chat_id'], 'date': r['date'], 'class': c, 'subclass': sub,
                 'is_signal': r['is_signal'], 'reply_to': r['reply_to_msg_id'], 'len': len((r['text'] or '').strip()),
                 'template': norm_template(r['text'] or '') if c != 'new_signal' else 'SIGNAL',
                 'text': (r['text'] or '').strip()})
with open(S + '/classes.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
cnt = collections.Counter(x['class'] for x in rows)
print('CLASS COUNTS (all', len(rows), ')')
for k, v in cnt.most_common(): print(f'  {k:24s} {v:5d}  {100*v/len(rows):5.1f}%')
print('subclass counts')
for k, v in collections.Counter((x['class'], x['subclass']) for x in rows).most_common(): print('  ', k, v)
