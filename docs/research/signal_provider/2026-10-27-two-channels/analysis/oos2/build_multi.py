"""Build signal universes from telegram_messages revisions with the channel-agnostic parser (several signals per
message allowed). usage: build_multi.py REVISIONS_JSON OUTDIR
Same three universes and hard flags as oos2_build.py (final / first / live), plus: symbol, signal_label, info
flags (open_last_tp, symbol_inferred, sl_annotation_mismatch...). Signal id = message_id * 100 + label number
(label 0 if unnumbered; k-th unlabelled block gets k). Hard-flag distance limits scale with symbols.spec unit."""
import csv, json, os, re, sys, collections, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ROOT, 'a1'), os.path.join(ROOT, 'a3')]
import parser_multi as pm, symbols  # noqa: E402

rev_path, outdir = sys.argv[1], sys.argv[2]
AGE_GATE_S = 120
ms = lambda s: int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)  # noqa: E731
iso = lambda t: dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'  # noqa: E731
rows = json.load(open(rev_path))
by = collections.defaultdict(list)
for r in rows: by[int(r['message_id'])].append(r)
rev_time = lambda r: r.get('edit_date') or r.get('date')  # noqa: E731
observed = lambda r: r.get('timestamp') or rev_time(r)  # noqa: E731

def sigs_of(r):
    out = {}
    for k, s in enumerate(pm.parse_message(r.get('text') or '')[0], 1):
        out[int(s['label']) if s['label'] and s['label'].isdigit() else k] = s
    return out

def hard_flags(s, text):
    u = symbols.spec(s['symbol'])['unit']
    lo, hi, sl, tps = s['entryLow'], s['entryHigh'], s['stopLoss'], s['takeProfits']
    emid = (lo + hi) / 2; sgn = 1 if s['direction'] == 'buy' else -1; f = []
    if re.search(r'\d,\d', text or ''): f.append('comma_decimal_truncated')
    if abs(sl - emid) > 50 * u: f.append('sl_implausible_dist')
    prev = None
    for k, tp in enumerate(tps, 1):
        if abs(tp - emid) > 300 * u: f.append(f'tp{k}_implausible')
        if (tp - emid) * sgn <= 0 or (prev is not None and (tp - prev) * sgn <= 0): f.append(f'tp{k}_order_invalid')
        prev = tp
    if (sl - emid) * sgn >= 0: f.append('sl_wrong_side')
    return f

FIELDS = ['message_id', 'source_message_id', 'signal_label', 'symbol', 't_iso', 't_ms', 'direction', 'entry_low',
          'entry_high', 'entry_mid', 'sl', 'tp1', 'tp2', 'tp3', 'tp4', 'tp5', 'tp6', 'tp7', 'num_tps', 'sl_dist',
          'hard_flags', 'info_flags', 'in_clean', 'lead_in_prev_header', 'edit_delay_s', 'layout_first_line',
          'comma_decimal_text', 'first_obs_lag_s', 'levels_changed', 'n_revisions', 'first_is_edit']

def row(mid, k, s, text, t_ms, extra):
    tps = s['takeProfits'][:7]; emid = (s['entryLow'] + s['entryHigh']) / 2
    return dict(message_id=mid * 100 + k, source_message_id=mid, signal_label=k, symbol=s['symbol'], t_iso=iso(t_ms),
                t_ms=t_ms, direction=s['direction'], entry_low=s['entryLow'], entry_high=s['entryHigh'], entry_mid=emid,
                sl=s['stopLoss'], **{f'tp{i}': (tps[i - 1] if i <= len(tps) else '') for i in range(1, 8)},
                num_tps=len(tps), sl_dist=round(abs(s['stopLoss'] - emid), 6), hard_flags='',
                info_flags=';'.join(s['info']), in_clean=1, lead_in_prev_header=0, layout_first_line='',
                comma_decimal_text=0, **extra)

key = lambda s: (s['direction'], s['entryLow'], s['entryHigh'], s['stopLoss'], tuple(s['takeProfits']))  # noqa: E731
U = dict(final=[], first=[], live=[]); summ = collections.Counter()
for mid in sorted(by):
    revs = sorted(by[mid], key=lambda r: (rev_time(r), observed(r)))
    summ['messages'] += 1; summ['revisions'] += len(revs)
    date = revs[0]['date']; parsed = [(r, sigs_of(r)) for r in revs]
    labels = sorted({k for _, d in parsed for k in d})
    for k in labels:
        firsts = [(r, d[k]) for r, d in parsed if k in d]
        fin = parsed[-1][1].get(k)
        if not fin:
            summ['final_not_signal'] += 1; continue
        fr = revs[-1]; r0, s0 = firsts[0]
        edit_delay = (ms(fr['edit_date']) - ms(date)) / 1000 if fr.get('edit_date') else 0.0
        lag = (ms(observed(r0)) - ms(date)) / 1000
        ex = dict(first_obs_lag_s=round(lag, 1), levels_changed=int(key(s0) != key(fin)), n_revisions=len(revs),
                  first_is_edit=int(r0 is not revs[0] or r0.get('type') == 'edit'), edit_delay_s=edit_delay)
        summ['signals'] += 1; summ['levels_changed_first_vs_final'] += ex['levels_changed']
        U['final'].append((row(mid, k, fin, fr.get('text'), ms(date), ex), fin, fr.get('text')))
        U['first'].append((row(mid, k, s0, r0.get('text'), ms(observed(r0)), ex), s0, r0.get('text')))
        if lag <= AGE_GATE_S: U['live'].append(U['first'][-1])
        else: summ['skipped_by_120s_gate'] += 1
os.makedirs(outdir, exist_ok=True)
for name, items in U.items():
    seen = []; out = []
    for r, s, text in sorted(items, key=lambda x: (x[0]['t_ms'], x[0]['message_id'])):
        fl = hard_flags(s, text)
        for (pm_, pd, plo, phi, psl, ptp1, pt) in seen:
            if (pd, plo, phi, psl, ptp1) == (r['direction'], r['entry_low'], r['entry_high'], r['sl'], r['tp1']) and 0 < r['t_ms'] - pt <= 3600_000:
                fl.append(f'duplicate_of_{pm_}'); break
        seen.append((r['message_id'], r['direction'], r['entry_low'], r['entry_high'], r['sl'], r['tp1'], r['t_ms']))
        r['hard_flags'] = ';'.join(fl); r['in_clean'] = 0 if fl else 1; r['comma_decimal_text'] = int('comma_decimal_truncated' in fl)
        out.append(r)
    with open(os.path.join(outdir, f'universe_{name}.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=FIELDS); w.writeheader(); w.writerows(out)
    summ[f'universe_{name}:rows'] = len(out); summ[f'universe_{name}:clean'] = sum(r['in_clean'] for r in out)
json.dump(dict(summ), open(os.path.join(outdir, 'revisions_summary.json'), 'w'), indent=1)
print(json.dumps(dict(summ), indent=1))
