"""C2: provider TP-hit claims vs own strict entry (E3 FT, BASE) and own touch test. Claims are data, never inputs to entries."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, collections, json, os
import numpy as np
import c2_ticks as T_
import c2_sim as S
from c2_run import load_signals, H
ev = list(csv.DictReader(open(os.path.join(T_.SCRATCH, 'a1', 'provider_claim_events.csv'))))
print('event classes', collections.Counter(e['claim_class'] for e in ev).most_common(8))
print('link methods', collections.Counter(e['link_method'] for e in ev).most_common(8))
tp = [e for e in ev if e['claim_class'] == 'update_tp_hit']
print('TP-hit events', len(tp), 'by link', collections.Counter(e['link_method'] for e in tp))
print('candidates_n for temporal', collections.Counter(e['candidates_n'] for e in tp if e['link_method'].startswith('temporal')))
unamb = [e for e in tp if e['signal_msg_id'] and (e['link_method'] == 'reply' or (e['link_method'].startswith('temporal') and e['candidates_n'] == '1'))]
print('unambiguous linked TP-hit claims (own rule):', len(unamb))
sigs = {s['msg']: s for s in load_signals()}
store = T_.HourStore(max_hours=300)
out = collections.Counter()
per = []
for e in unamb:
    s = sigs.get(e['signal_msg_id'])
    if s is None:
        out['signal_not_found'] += 1
        continue
    if not e['tp_index']:
        out['blank_tp_index'] += 1
        continue
    k = int(e['tp_index']) - 1
    tp_k = s['tps'][k] if k < len(s['tps']) else None
    ts, a, b = store.window(s['t'] - 120000, s['t'] + 147 * H)
    Eq = a if s['dir'] > 0 else b
    Xr = b if s['dir'] > 0 else a
    fill_status = None
    i0 = int(np.searchsorted(ts, s['t'] + 5000, 'left'))
    if i0 < len(ts):
        q = Eq[i0]
        fill_status = 'FILLED' if (s['low'] - 0.5 <= q <= s['high'] + 0.5) else 'NOT_FILLED'
    else:
        fill_status = 'NO_PRICE'
    if fill_status == 'NOT_FILLED':
        out['NA_NOT_FILLED_E3FT_BASE'] += 1
        per.append((e['signal_msg_id'], k + 1, 'NA'))
        continue
    if tp_k is None:
        out['tp_absent_on_signal'] += 1
        continue
    # touch test from the strict-market fill at i0 (BASE): first TP_k touch vs first SL touch within 72 h
    fill = Eq[i0]
    d = s['dir']
    end = int(np.searchsorted(ts, ts[i0] + 72 * H, 'right'))
    seg_x = (Xr[i0 + 1:end] * d)
    tp_thr = d * tp_k
    sl_thr = d * s['sl']
    t_tp = np.flatnonzero(seg_x >= tp_thr)
    t_sl = np.flatnonzero(seg_x <= sl_thr)
    first_tp = t_tp[0] if t_tp.size else None
    first_sl = t_sl[0] if t_sl.size else None
    if first_tp is None:
        verdict = 'NOT_TOUCHED_IN_HORIZON'
    elif first_sl is not None and first_sl < first_tp:
        verdict = 'SL_FIRST'
    else:
        verdict = 'SUPPORTED'
    out['filled_' + verdict] += 1
    per.append((e['signal_msg_id'], k + 1, verdict))
print('own-rule results:', dict(out))
tot_filled = out['filled_SUPPORTED'] + out['filled_SL_FIRST'] + out['filled_NOT_TOUCHED_IN_HORIZON']
if tot_filled:
    print('agreement (SUPPORTED / filled claims): %.3f' % (out['filled_SUPPORTED'] / tot_filled))
json.dump(per, open(os.path.join(T_.SCRATCH, 'c2', 'out', 'c2_claim_verdicts.json'), 'w'))
