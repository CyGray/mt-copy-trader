import csv, re, collections
rows = list(csv.DictReader(open(S:='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1/classes.csv', encoding='utf-8')))
def show(c, n=8, maxlen=130):
    rs = [r for r in rows if r['class'] == c]
    print(f'== {c} ({len(rs)}) sample')
    for r in rs[:n]: print('  ', r['message_id'], repr(r['text'][:maxlen]))
for c in ['update_stopped_at_be','update_pips_result','update_close','update_running','update_sl_hit','tp_level_mention','signal_like_unparsed']:
    show(c, 8 if c!='signal_like_unparsed' else 20, 150)
print('== commentary containing TP/PIPS/HIT/SL/PROFIT/LOSS (sample 25)')
cm = [r for r in rows if r['class']=='commentary' and re.search(r'\bTP|PIPS|HIT|\bSL\b|PROFIT|LOSS|STOP|TARGET|WIN', r['text'], re.I)]
print('count', len(cm))
for r in cm[:25]: print('  ', r['message_id'], repr(r['text'][:150]))
