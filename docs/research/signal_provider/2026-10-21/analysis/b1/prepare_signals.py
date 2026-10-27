"""Build the signal universe (all 415 accepted XAUUSD signals) with explicit quality flags.

Inputs (read-only):
  a1/signals.csv                  accepted signals (A1)
  a3/derived/signals_a3.csv       raw message text (A3 re-parse; used for comma-decimal checks)
  a1/ts_parse_all.json            per-message parse outcomes (used only for the lead-in heuristic)

Output: b1/signals_universe.csv   one row per signal. quality_flag lists every hard flag (exclusion
reasons, in_clean=0) and info flags (kept in the clean universe, reported separately).
A signal with no hard flag is in the 'clean' universe. Nothing is dropped from the 'all' universe.
"""
import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sim_engine as se  # noqa: E402

SCR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # scratchpad root
A1 = os.path.join(SCR, 'a1')
A3 = os.path.join(SCR, 'a3')
OUT = os.path.join(HERE, 'signals_universe.csv')

sigs = list(csv.DictReader(open(os.path.join(A1, 'signals.csv'), encoding='utf-8')))
a3 = {r['msg_id']: r for r in csv.DictReader(open(os.path.join(A3, 'derived', 'signals_a3.csv'), encoding='utf-8'))}
parse = {int(x['message_id']): x for x in json.load(open(os.path.join(A1, 'ts_parse_all.json')))}

rows = []
dup_pairs = []
seen = []  # (message_id, direction, lo, hi, sl, tp1, t_ms)
for r in sigs:
    mid = r['message_id']
    t_ms = se.utc_ms(r['date_utc'])
    lo, hi = float(r['entry_low']), float(r['entry_high'])
    sl = float(r['sl'])
    tps = [float(r[f'tp{k}']) if r[f'tp{k}'] else None for k in range(1, 8)]
    emid = (lo + hi) / 2
    flags = []
    info = []

    text = a3.get(mid, {}).get('text', '')
    if re.search(r'\d,\d', text):
        flags.append('comma_decimal_truncated')
    sl_dist = abs(sl - emid)
    if sl_dist > 50:
        flags.append(f'sl_implausible_dist{sl_dist:.1f}')
    for k, tp in enumerate(tps, start=1):
        if tp is not None and abs(tp - emid) > 300:
            flags.append(f'tp{k}_implausible_{tp:g}')
    # side and ordering checks (A1 reports these all pass; re-checked here)
    sgn = 1 if r['direction'] == 'buy' else -1
    if (sl - emid) * sgn >= 0:
        flags.append('sl_wrong_side')
    prev_tp = None
    for k, tp in enumerate(tps, start=1):
        if tp is None:
            continue
        if (tp - emid) * sgn <= 0 or (prev_tp is not None and (tp - prev_tp) * sgn <= 0):
            flags.append(f'tp{k}_order_invalid')
        prev_tp = tp
    # duplicate TP label in the source text (e.g. "TP4 : 4850 | TP4 : 4806")
    labels = re.findall(r'TP\s*(\d)\s*:', text)
    if len(labels) != len(set(labels)):
        flags.append('duplicate_tp_label_in_text')
    # duplicate signal: same side, same entry range, SL and TP1 within 60 min of an earlier accepted signal
    for (pm, pd, plo, phi, psl, ptp1, pt) in seen:
        if (pd == r['direction'] and plo == lo and phi == hi and psl == sl and ptp1 == tps[0]
                and 0 < t_ms - pt <= 60 * 60 * 1000):
            flags.append(f'duplicate_of_{pm}')
            dup_pairs.append((mid, pm))
            break
    seen.append((mid, r['direction'], lo, hi, sl, tps[0], t_ms))

    p = parse.get(int(mid))
    prev = parse.get(int(mid) - 1)
    lead_in = 1 if (prev and prev.get('ts_error') == 'missing_entry') else 0
    if lead_in:
        info.append('lead_in_prev_header_post')
    try:
        ed = float(r['edit_delay_s']) if r['edit_delay_s'] else 0.0
    except ValueError:
        ed = 0.0
    edited_late = 1 if ed > 600 else 0
    if edited_late:
        info.append('edited_after_10min')

    hard = [f for f in flags]
    rows.append({
        'message_id': mid, 't_iso': se.iso_utc(t_ms), 't_ms': t_ms, 'direction': r['direction'],
        'entry_low': lo, 'entry_high': hi, 'entry_mid': emid, 'sl': sl,
        **{f'tp{k}': ('' if tp is None else tp) for k, tp in enumerate(tps, start=1)},
        'num_tps': sum(1 for tp in tps if tp is not None), 'sl_dist': round(sl_dist, 3),
        'hard_flags': ';'.join(hard), 'info_flags': ';'.join(info),
        'in_clean': 0 if hard else 1, 'lead_in_prev_header': lead_in, 'edit_delay_s': ed,
        'layout_first_line': r['layout_first_line'], 'comma_decimal_text': 1 if 'comma_decimal_truncated' in hard else 0,
    })

fields = ['message_id', 't_iso', 't_ms', 'direction', 'entry_low', 'entry_high', 'entry_mid', 'sl',
          'tp1', 'tp2', 'tp3', 'tp4', 'tp5', 'tp6', 'tp7', 'num_tps', 'sl_dist',
          'hard_flags', 'info_flags', 'in_clean', 'lead_in_prev_header', 'edit_delay_s',
          'layout_first_line', 'comma_decimal_text']
with open(OUT, 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=fields)
    w.writeheader()
    w.writerows(rows)

n = len(rows)
clean = sum(r['in_clean'] for r in rows)
print('signals', n, 'clean', clean, 'excluded', n - clean)
print('dup pairs', dup_pairs)
import collections
c = collections.Counter()
for r in rows:
    for f_ in (r['hard_flags'].split(';') if r['hard_flags'] else []):
        c[f_.split('_dist')[0].split('_of_')[0].split('_implausible')[0]] += 1
    for f_ in (r['info_flags'].split(';') if r['info_flags'] else []):
        c['INFO:' + f_] += 1
print(dict(c))
