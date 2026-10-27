# Task 2 (final): classify every record. First matching rule wins. Writes classes.csv.
# Reads ts_parse_all.json (compiled TS parser output) for cancel verdict and parse error reason.
import json, re, collections, csv
S = '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
d = json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json', encoding='utf-8'))
ts = {(o['chat_id'], o['message_id']): o for o in json.load(open(S + '/ts_parse_all.json'))}
RX = {
 'cancel_loose': r'\bcancel(?:l?ed)?\b|\bdelete\s+this\s+signal\b|\bignore\s+this\s+signal\b|\binvalid\s+signal\b',
 'header_dir': r'^\s*(BUY|SELL|SHORT|LONG)\b[^\n]{0,20}$',
 'dir': r'\b(BUY|SELL|SHORT|LONG)\b',
 'sl_num': r'\b(SL|STOP\s*LOSS)\s*[:;]?\s*\d',
 'tp_num': r'\bTP\s*\d+\s*:?\s*\d|(^|\n)\s*#\s*\d\s*:\s*\d|take\s*profit\s*levels',
 'sl_hit': r'\bSL\s*HITS?\b|STOP\s*LOSS\s*HITS?\b|\bSTOPPED\s*OUT\b',
 'tp_hit': r'\bTP\s*\d*\s*(GOT\s+)?(HITS?|REACHED|DONE|TOUCHED)\b|\bTP\s*\d+\b[^\n]{0,20}(?<![\w.])\+\s*\d+(?:[.,]\d+)?\s*PIPS?\b',
 'tp_hit_loose': r'\bHITS?\b[^\n]{0,40}\bTP|\bTP\b[^\n]{0,40}\bHITS?\b',
 'tp_implicit': r'\b(CONGRATS?|CONGRATULATIONS?)\b[^\n]{0,60}\bTP\s*\d|\bGOOD\s+JOB\s+(TEAM\s+)?FOR\s+(THE\s+)?TP\s*\d|\bWINS?\s+AT\s+TP\s*\d|\bFULL\s+TP\b',
 'out_claim': r'^\s*(FULLY\s+|REST\s+|JUST\s+|GOT\s+|WE\s+GOT\s+)?OUT\b|\bGOT\s+OUT\s+(AT\s+)?(BREAK\s*-?\s*EVEN|BE)\b|\bOUT\s+(AT\s+|FOR\s+THE\s+REST\s*)?(BREAK\s*-?\s*EVEN|BE)\b|\bREST\s+OUT\b|\bOUT\s+FOR\s+THE\s+REST\b',
 'exit_generic': r'\bI\s+(TOOK|CLOSED)\b|\bI[’\']?M\s+OUT\b|\bIM\s+OUT\b|^\s*IM\s+OUT\b|\bTOOK\s+(MY\s+)?(BE|PROFIT)\b|\bGRAB(BED)?\s+MY\s+BE\b|\bPUT\s+ME\s+OUT\b|\bPUTTED\s+ME\s+OUT\b',
 'loss': r'\bTOOK\s+(AN?\s+|A\s+\d+\s*(PIPS?\s+)?)?(SL|STOP\s*LOSS|LOSS)\b|\bSMALL\s+LOSS\b|\bLOSS\s+(OF\s+)?\d+\s*PIPS?\b|\b\d+\s*PIPS?\s*(LOSS|SL)\b|\bSL\s+ON\s+THAT\b|\bSTOPPED\s+OUT\b|\bSL\s+HITS?\b|\b(LOST|LOSE|MINUS|DOWN|GAVE)\b[^\n.!?]{0,25}?\b\d+\s*PIPS?\b|\b(\d+|FIRST|VALID|SMALL|ONE|ANOTHER)\s+LOSS(ES)?\b|\bLOST\s+\d+\s+TRADES?\b',
 'pips_claim': r'(?<![\w.])[+-]\s*\d+(?:[.,]\d+)?\s*PIPS?\b|\b\d+\s*PIPS?\s*(PROFIT|WIN|DONE|SECURED|GAIN|UP|✅)|\bUP\s+\d+\s*PIPS?\b|\bMADE\s+\d+\s*PIPS?\b|\b(WIN|LOSS)\s+(OF\s+)?\d+\s*PIPS?\b|\bPIPS?\s+✅',
 'close_claim': r'\bCLOSE[D]?\s+(\d+(\.\d+)?\s+)?LOTS?\b|\bCLOSING\s+(\d+(\.\d+)?\s+)?LOTS?\b|\bCLOSING\s+(HALF|PART|THE\s+TRADE|THE\s+POSITION|ALL)\b|\bCLOSE\s+(NOW|ALL|HALF|PARTIALS?|THE\s+TRADE|THE\s+POSITION)\b|\bFULLY\s+CLOSE[D]?\b|\bCLOSE\s+HALF\b|\bI\s+CLOSED\b',
 'running': r'\bRUNNING\b|\bLEAVING\s+\d|\bLEFT\s+\d+\s+LOTS?\b|\bLEAVE\s+\d+\s+LOTS?\b',
 'tally': r'\b\d+\s+(WINS?|WON|LOSSES?)\b|\bWON\s+(OUR\s+)?(LAST\s+)?\d+|\bWIN\s+STREAK\b|\bWIN\s+RATE\b|\bSTREAK\b|(^|\n)\s*\d+/\d+\s*(,|✅|⌛|$)',
 'be': r'BREAK\s*-?\s*EVEN|\b(AT|TO|IN)\s+BE\b|^\s*BE\s*$|\bSTOP\s+LOSS\s+(AT\s+|TO\s+)?BE\b|\bSL\s+(AT\s+|TO\s+)?BE\b|\bMY\s+BE\b',
 'tp_at': r'\bTP\s*\d+\s*(AT|at)\s*[\d.]+|^\s*TP\s*\d+\s+\d{3,5}(\.\d+)?\s*$|^\s*\d{3,5}(\.\d+)?\s*TP\s*\d\s*$|(^|\n)\s*TP\s*\d+\s+\d{3,5}',
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
    if C['tp_implicit'].search(t):
        return 'update_tp_hit', 'tp_implicit'
    if C['out_claim'].search(t):
        return 'update_stopped_at_be', 'out_claim'
    if C['loss'].search(t):
        return 'update_loss_claim', 'loss_claim'
    if C['pips_claim'].search(t):
        return 'update_pips_claim', 'pips_claim'
    if C['exit_generic'].search(t):
        return 'update_exit_generic', 'exit_generic'
    if C['close_claim'].search(t):
        return 'update_close', 'close_claim'
    if C['running'].search(t):
        return 'update_running', 'running_partial'
    if C['tp_at'].search(t):
        return 'tp_level_mention', 'tp_at_price'
    if C['sl_only'].search(t):
        return 'sl_level_mention', 'sl_price_only'
    if C['tally'].search(t) and not re.search(r'FUNDED|ACCOUNT|GIVEAWAY', t, re.I):
        return 'update_tally', 'win_loss_tally'
    if C['be'].search(t):
        return 'update_be_mgmt', 'be_mention'
    return 'commentary', 'other'
rows = []
for r in d:
    c, sub = classify(r)
    rows.append({'message_id': int(r['message_id']), 'chat_id': r['chat_id'], 'date': r['date'], 'class': c, 'subclass': sub,
                 'is_signal': r['is_signal'], 'reply_to': r['reply_to_msg_id'] or '', 'len': len((r['text'] or '').strip()),
                 'template': norm_template(r['text'] or '') if c != 'new_signal' else 'SIGNAL',
                 'text': (r['text'] or '').strip()})
with open(S + '/classes.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
cnt = collections.Counter(x['class'] for x in rows)
print('CLASS COUNTS (all', len(rows), ')')
for k, v in cnt.most_common(): print(f'  {k:24s} {v:5d}  {100*v/len(rows):5.1f}%')
print('subclass counts')
for k, v in collections.Counter((x['class'], x['subclass']) for x in rows).most_common(): print('  ', k, v)
