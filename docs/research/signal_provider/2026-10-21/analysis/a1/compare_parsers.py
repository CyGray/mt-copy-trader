# Cross-check: Python port vs stored signal field vs compiled TS parser, over all records and a seeded 200-signal sample.
import json, random, sys, collections
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1')
import parser_port as pp
S='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1'
d = json.load(open('/home/kyle/projects/ByTrader/.data/vip_history.json', encoding='utf-8'))
ts = {(o['chat_id'], o['message_id']): o for o in json.load(open(S+'/ts_parse_all.json'))}
def same_sig(stored, py):
    if stored is None or py is None: return stored is None and py is None
    return (stored['symbol']==py['symbol'] and stored['direction']==py['direction'] and stored['orderType']==py['orderType']
            and float(stored['entryLow'])==py['entryLow'] and float(stored['entryHigh'])==py['entryHigh']
            and float(stored['stopLoss'])==py['stopLoss'] and [float(x) for x in stored['takeProfits']]==py['takeProfits'])
mism_ok=0; py_ok_total=0; ts_py_disagree=[]; stored_mismatch=[]; cancel_py=0
for r in d:
    p = pp.parse_gold_signal(r['text'] or '')
    key=(r['chat_id'], r['message_id'])
    if p['ok']: py_ok_total+=1
    if p['ok'] != ts[key]['ts_ok'] or (p['ok'] and not same_sig(ts[key]['ts_signal'], p['signal'])) or ((not p['ok']) and p['error']!=ts[key]['ts_error']):
        ts_py_disagree.append(r['message_id'])
    if p['ok'] != bool(r['is_signal']) or (p['ok'] and not same_sig(r['signal'], p['signal'])):
        stored_mismatch.append(r['message_id'])
    if pp.detect_cancel_intent(r['text'] or ''): cancel_py+=1
print('ALL RECORDS n=%d' % len(d))
print('  python port parse ok:', py_ok_total)
print('  python vs TS disagreements (ok flag, error reason, or signal values):', len(ts_py_disagree), ts_py_disagree[:20])
print('  python vs stored (is_signal and signal values):', len(stored_mismatch), stored_mismatch[:20])
print('  python cancel_intent true:', cancel_py)
sig = [r for r in d if r['is_signal']]
random.seed(20261021)
sample = random.sample(sig, 200)
agree = sum(1 for r in sample if pp.parse_gold_signal(r['text'])['ok'] and same_sig(r['signal'], pp.parse_gold_signal(r['text'])['signal']))
print('SAMPLE 200 signals (seed 20261021): python port reproduces stored signal:', agree, 'of 200')
ts_agree = sum(1 for r in sample if ts[(r['chat_id'], r['message_id'])]['ts_ok'] and same_sig(r['signal'], ts[(r['chat_id'], r['message_id'])]['ts_signal']))
print('SAMPLE 200 signals: compiled TS reproduces stored signal:', ts_agree, 'of 200')
print('SAMPLE 200 message_ids:', sorted(int(r['message_id']) for r in sample)[:12], '...')
json.dump([r['message_id'] for r in sample], open(S+'/sample200_message_ids.json','w'))
