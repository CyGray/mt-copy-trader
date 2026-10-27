"""Parser and classifier check against hand labels. usage: eval_parser.py REVISIONS_JSON CHANNEL OUT_JSON
Prints aggregates only (no text)."""
import json, sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parser_multi as pm, labels as L

rows = json.load(open(sys.argv[1])); ch = sys.argv[2].upper(); lab = getattr(L, ch)
by = collections.defaultdict(list)
for r in rows: by[int(r['message_id'])].append(r)
conf = collections.Counter(); tp = fp = fn = 0; level_ok = level_bad = 0; per = []
for mid in sorted(by):
    revs = sorted(by[mid], key=lambda r: (r.get('edit_date') or r['date'], r.get('timestamp') or ''))
    fin = revs[-1]
    cls = pm.classify_message(fin['text'], any(r.get('has_media') for r in revs), bool(fin.get('reply_to')))
    truth = lab[mid]; conf[(truth, cls)] += 1
    sigs, err = pm.parse_message(fin['text'])
    exp = L.SIGNALS_FINAL.get(mid, []) if ch == 'LUCAS' else []
    got = [(s['label'], s['direction'], s['entryLow'], s['entryHigh'], s['stopLoss'], s['takeProfits'], s['open_tp']) for s in sigs]
    tp += sum(1 for g in got if g in exp); fp += sum(1 for g in got if g not in exp); fn += sum(1 for e in exp if e not in got)
    for rv in revs:  # every revision of signal messages: compare with the first/final expectation
        if mid in L.SIGNALS_FINAL and ch == 'LUCAS':
            g = [(s['label'], s['direction'], s['entryLow'], s['entryHigh'], s['stopLoss'], s['takeProfits'], s['open_tp']) for s in pm.parse_message(rv['text'])[0]]
            ok = g in (L.SIGNALS_FINAL[mid], L.SIGNALS_FIRST[mid]); level_ok += ok; level_bad += (not ok)
    per.append(dict(message_id=mid, truth=truth, predicted=cls, n_signals=len(sigs), info=[i for s in sigs for i in s['info']]))
n = len(by)
acc = sum(v for (t, p), v in conf.items() if t == p) / n
sig_truth = sum(1 for m in lab if lab[m] == 'signal'); sig_pred = sum(1 for p in per if p['predicted'] == 'signal')
sig_both = sum(1 for p in per if p['predicted'] == 'signal' and p['truth'] == 'signal')
out = dict(channel=ch, messages=n, class_accuracy=round(acc, 3),
           signal_message_precision=(sig_both / sig_pred) if sig_pred else None,
           signal_message_recall=(sig_both / sig_truth) if sig_truth else None,
           signals_expected=sum(len(v) for v in (L.SIGNALS_FINAL.values() if ch == 'LUCAS' else [])),
           signal_levels_tp=tp, signal_levels_fp=fp, signal_levels_fn=fn,
           revisions_levels_ok=level_ok, revisions_levels_bad=level_bad,
           confusion={f'{t}->{p}': v for (t, p), v in sorted(conf.items())},
           info_flags=[p for p in per if p['info']])
json.dump(out, open(sys.argv[3], 'w'), indent=1); print(json.dumps(out, indent=1))
