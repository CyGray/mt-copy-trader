"""Build the OOS2 signal universes from telegram_messages revisions (Firestore export).

usage: oos2_build.py REVISIONS_JSON OUTDIR [--min-id N]
Writes (B1 signals_universe.csv schema + extras):
  universe_final.csv  t = message date, levels = FINAL text (max edit_date)  -> same method as the main study
  universe_live.csv   t = observation time of the FIRST revision that parses as a signal, levels of that revision,
                      only signals observed <= 120 s after the message date (default AutoTrader age gate)
  universe_first.csv  as live but WITHOUT the age gate (first parseable revision, any lag)
  revisions_summary.json  descriptive counts (no text)
Hard flags replicate b1/prepare_signals.py.
"""
import csv, json, re, sys, os, datetime as dt, collections
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a1')
import parser_port as pp  # python port of vipSignalParser (verified 3317/3317 vs repo parser)

rev_path, outdir = sys.argv[1], sys.argv[2]
min_id = int(sys.argv[sys.argv.index('--min-id') + 1]) if '--min-id' in sys.argv else 0
AGE_GATE_S = 120

def pdt(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))

def ms(s):
    return int(pdt(s).timestamp() * 1000)

def iso(t_ms):
    return dt.datetime.fromtimestamp(t_ms / 1000, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

rows = json.load(open(rev_path))
by = collections.defaultdict(list)
for r in rows:
    if int(r['message_id']) >= min_id:
        by[int(r['message_id'])].append(r)

def rev_time(r):  # when this revision came into existence on Telegram
    return r.get('edit_date') or r.get('date')

def observed(r):  # when our system recorded it
    return r.get('timestamp') or rev_time(r)

_PC = {}
def sig_of(r):
    t = r.get('text') or ''
    if t not in _PC:
        p = pp.parse_gold_signal(t)
        _PC[t] = p['signal'] if p['ok'] else None
    s = _PC[t]
    if not s or (s.get('symbol') or '').upper() != 'XAUUSD':
        return None
    return s

def hard_flags(s, text):
    lo, hi, sl = float(s['entryLow']), float(s['entryHigh']), float(s['stopLoss'])
    tps = [float(x) for x in s['takeProfits']]
    emid = (lo + hi) / 2
    f = []
    if re.search(r'\d,\d', text or ''):
        f.append('comma_decimal_truncated')
    if abs(sl - emid) > 50:
        f.append(f'sl_implausible_dist{abs(sl - emid):.1f}')
    for k, tp in enumerate(tps, 1):
        if abs(tp - emid) > 300:
            f.append(f'tp{k}_implausible_{tp:g}')
    sgn = 1 if s['direction'] == 'buy' else -1
    if (sl - emid) * sgn >= 0:
        f.append('sl_wrong_side')
    prev = None
    for k, tp in enumerate(tps, 1):
        if (tp - emid) * sgn <= 0 or (prev is not None and (tp - prev) * sgn <= 0):
            f.append(f'tp{k}_order_invalid')
        prev = tp
    labels = re.findall(r'TP\s*(\d)\s*:', text or '')
    if len(labels) != len(set(labels)):
        f.append('duplicate_tp_label_in_text')
    return f

FIELDS = ['message_id', 't_iso', 't_ms', 'direction', 'entry_low', 'entry_high', 'entry_mid', 'sl',
          'tp1', 'tp2', 'tp3', 'tp4', 'tp5', 'tp6', 'tp7', 'num_tps', 'sl_dist', 'hard_flags', 'info_flags',
          'in_clean', 'lead_in_prev_header', 'edit_delay_s', 'layout_first_line', 'comma_decimal_text',
          'first_obs_lag_s', 'levels_changed', 'n_revisions', 'first_is_edit']

def make_row(mid, s, text, t_ms, extra):
    lo, hi, sl = float(s['entryLow']), float(s['entryHigh']), float(s['stopLoss'])
    tps = [float(x) for x in s['takeProfits']][:7]
    emid = (lo + hi) / 2
    return dict(message_id=mid, t_iso=iso(t_ms), t_ms=t_ms, direction=s['direction'], entry_low=lo, entry_high=hi,
                entry_mid=emid, sl=sl, **{f'tp{k}': (tps[k - 1] if k <= len(tps) else '') for k in range(1, 8)},
                num_tps=len(tps), sl_dist=round(abs(sl - emid), 3), hard_flags='', info_flags='', in_clean=1,
                lead_in_prev_header=0, layout_first_line='', comma_decimal_text=0, **extra)

def key(s):
    return (s['direction'], float(s['entryLow']), float(s['entryHigh']), float(s['stopLoss']),
            tuple(float(x) for x in s['takeProfits']))

final, live, first = [], [], []
summ = collections.Counter()
for mid in sorted(by):
    revs = sorted(by[mid], key=lambda r: (rev_time(r), observed(r)))
    summ['messages'] += 1
    summ['revisions'] += len(revs)
    date = revs[0]['date']
    sigs = [(r, sig_of(r)) for r in revs]
    parseable = [(r, s) for r, s in sigs if s]
    if not parseable:
        continue
    summ['messages_with_parseable_revision'] += 1
    fr, fs = revs[-1], sig_of(revs[-1])
    if not fs:  # final text no longer a signal (cancelled/pulled): not an accepted signal in the main study
        summ['final_not_signal'] += 1
        continue
    summ['signals'] += 1
    first_r, first_s = parseable[0]
    edit_delay = (ms(fr['edit_date']) - ms(date)) / 1000 if fr.get('edit_date') else 0.0
    obs_lag = (ms(observed(first_r)) - ms(date)) / 1000
    changed = int(key(first_s) != key(fs))
    first_is_edit = int(first_r is not revs[0] or first_r.get('type') == 'edit')
    common = dict(first_obs_lag_s=round(obs_lag, 1), levels_changed=changed, n_revisions=len(revs),
                  first_is_edit=first_is_edit, edit_delay_s=edit_delay)
    final.append(make_row(mid, fs, fr.get('text', ''), ms(date), common))
    first_row = make_row(mid, first_s, first_r.get('text', ''), ms(observed(first_r)), common)
    first.append(first_row)
    if obs_lag <= AGE_GATE_S:
        live.append(first_row)
    else:
        summ['skipped_by_120s_gate'] += 1
    summ['levels_changed_first_vs_final'] += changed
    summ['first_parseable_is_edit'] += first_is_edit
    summ['final_edit_gt_300s'] += int(edit_delay > 300)

def finalize(rs, texts):
    seen = []
    for r in sorted(rs, key=lambda x: x['t_ms']):
        fl = hard_flags(texts[r['message_id']][0], texts[r['message_id']][1])
        tp1 = r['tp1']
        for (pm, pd, plo, phi, psl, ptp1, pt) in seen:
            if (pd == r['direction'] and plo == r['entry_low'] and phi == r['entry_high'] and psl == r['sl']
                    and ptp1 == tp1 and 0 < r['t_ms'] - pt <= 3600_000):
                fl.append(f'duplicate_of_{pm}'); break
        seen.append((r['message_id'], r['direction'], r['entry_low'], r['entry_high'], r['sl'], tp1, r['t_ms']))
        r['hard_flags'] = ';'.join(fl)
        r['in_clean'] = 0 if fl else 1
        r['comma_decimal_text'] = int('comma_decimal_truncated' in fl)

# hard flags are evaluated on each universe's own levels/text
def texts_for(rowset, use_first):
    out = {}
    for mid in {r['message_id'] for r in rowset}:
        revs = sorted(by[mid], key=lambda r: (rev_time(r), observed(r)))
        if use_first:
            r0, s0 = [(r, sig_of(r)) for r in revs if sig_of(r)][0]
        else:
            r0, s0 = revs[-1], sig_of(revs[-1])
        out[mid] = (s0, r0.get('text', ''))
    return out

os.makedirs(outdir, exist_ok=True)
for name, rs, uf in (('universe_final.csv', final, False), ('universe_live.csv', live, True), ('universe_first.csv', first, True)):
    finalize(rs, texts_for(rs, uf))
    rs.sort(key=lambda x: (x['t_ms'], int(x['message_id'])))
    with open(os.path.join(outdir, name), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=FIELDS); w.writeheader(); w.writerows(rs)
    summ[f'{name}:rows'] = len(rs); summ[f'{name}:clean'] = sum(r['in_clean'] for r in rs)
json.dump(dict(summ), open(os.path.join(outdir, 'revisions_summary.json'), 'w'), indent=1)
print(json.dumps(dict(summ), indent=1))
