"""Feasibility-only outcome reconstruction for a seeded sample of signals (seed 42).

usage: recon_demo.py RAWDIR DERIVED_DIR [N=20] [SEED=42]
Model (explicit assumptions; see report):
  entry window     2 h after message time (ENTRY_WINDOW_H)
  BUY  fills when ask <= entry_high (fill at that tick's ask); SELL fills when bid >= entry_low (fill at bid)
  BUY  exits at bid: SL when bid <= SL; TP_k when bid >= TP_k.  SELL exits at ask: SL when ask >= SL; TP_k when ask <= TP_k
  horizon          48 h after fill (HORIZON_H)
  ticks            Dukascopy bi5 ticks (ground truth for this check)
  1m-bar model     per-minute bid/ask high/low derived from the same ticks, to measure same-candle ambiguity
Outputs derived/recon_sample.csv and prints a summary.
"""
import sys, os, csv, random, bisect, datetime as dt, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dukas_lib import window_ticks

RAW, DER = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 20
SEED = int(sys.argv[4]) if len(sys.argv) > 4 else 42
ENTRY_WINDOW_H = 2
HORIZON_H = 48
P = 1000.0

def ms_of(iso):
    return int(dt.datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp() * 1000)

sigs = list(csv.DictReader(open(os.path.join(DER, 'signals_a3.csv'), encoding='utf-8')))
sigs.sort(key=lambda r: (r['date_utc'], r['msg_id']))
rng = random.Random(SEED)
idx = sorted(rng.sample(range(len(sigs)), N))
chosen = [sigs[i] for i in idx]

outcomes = list(csv.DictReader(open(os.path.join(DER, 'outcomes_a3.csv'), encoding='utf-8')))
claims_by_sig = {}
for o in outcomes:
    if o['linked_signal_msg']:
        claims_by_sig.setdefault(o['linked_signal_msg'], []).append(o)

def fmt_t(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')

def run_one(s):
    d = s['direction']; buy = d == 'buy'
    lo = float(s['reparse_entry_low']); hi = float(s['reparse_entry_high'])
    sl = float(s['reparse_sl']) if s['reparse_sl'] else None
    tps = [float(x) for x in s['reparse_tps'].split(';') if x]
    t0 = ms_of(s['date_utc'])
    rec = dict(msg_id=s['msg_id'], date_utc=s['date_utc'], direction=d, entry_low=lo, entry_high=hi,
               sl=sl, tps=';'.join(str(x) for x in tps), n_tp=len(tps))
    # geometry sanity
    mid = (lo + hi) / 2
    geom_ok = (sl is not None) and ((sl < mid < min(tps) if buy else sl > mid > max(tps)) if tps else False)
    rec['geometry_ok'] = int(bool(geom_ok))
    entry_end = t0 + ENTRY_WINDOW_H * 3600000
    horizon_end = None
    ticks = list(window_ticks(RAW, t0, t0 + (ENTRY_WINDOW_H + HORIZON_H) * 3600000))
    if not ticks:
        rec['result'] = 'no_ticks'; return rec
    # entry
    fill_i = None
    first_exec = None
    for i, (ts, b, a) in enumerate(ticks):
        if ts > entry_end:
            break
        ex = a / P if buy else b / P
        if first_exec is None:
            first_exec = (ts, ex)
        if (buy and a / P <= hi) or ((not buy) and b / P >= lo):
            fill_i = i
            break
    if fill_i is None:
        rec['result'] = 'no_entry_touch'
        rec['first_exec_after_msg'] = first_exec[1] if first_exec else ''
        rec['first_exec_lag_s'] = round((first_exec[0] - t0) / 1000, 1) if first_exec else ''
        return rec
    fts, fb, fa = ticks[fill_i]
    fill = (fa / P) if buy else (fb / P)
    rec.update(fill_time=fmt_t(fts), fill_lag_s=round((fts - t0) / 1000, 1), fill_price=round(fill, 3),
               fill_vs_entry_mid=round(fill - mid, 3) if buy else round(mid - fill, 3))
    # first-touch scan after fill
    hz = fts + HORIZON_H * 3600000
    touch = {'SL': None}
    for k in range(len(tps)):
        touch[f'TP{k+1}'] = None
    for ts, b, a in ticks[fill_i + 1:]:
        if ts > hz:
            break
        px = b / P if buy else a / P
        if sl is not None and touch['SL'] is None:
            if (buy and b / P <= sl) or ((not buy) and a / P >= sl):
                touch['SL'] = ts
        for k, tp in enumerate(tps):
            key = f'TP{k+1}'
            if touch[key] is None and ((buy and b / P >= tp) or ((not buy) and a / P <= tp)):
                touch[key] = ts
    for k, v in touch.items():
        rec[f'first_{k}'] = fmt_t(v) if v else ''
        rec[f'{k}_after_fill_min'] = round((v - fts) / 60000, 2) if v else ''
    events = sorted([(v, k) for k, v in touch.items() if v is not None])
    rec['first_event'] = events[0][1] if events else 'none_within_48h'
    rec['tp_before_sl'] = int(bool(events) and events[0][1] != 'SL')
    # ---- 1-minute bar model from the same ticks (per UTC minute after fill) ----
    bars = {}
    for ts, b, a in ticks[fill_i:]:
        if ts > hz: break
        m = ts // 60000
        x = bars.get(m)
        if x is None:
            bars[m] = [b, b, a, a]
        else:
            if b < x[0]: x[0] = b
            if b > x[1]: x[1] = b
            if a < x[2]: x[2] = a
            if a > x[3]: x[3] = a
    # exit price side per bar: buy exits use bid low/high, sell exits use ask low/high
    first_bar_event = None; amb = False
    for m in sorted(bars):
        bl, bh, al, ah = bars[m]
        if buy:
            sl_hit = sl is not None and bl / P <= sl
            tp_hit = [k for k, tp in enumerate(tps) if bh / P >= tp]
        else:
            sl_hit = sl is not None and ah / P >= sl
            tp_hit = [k for k, tp in enumerate(tps) if al / P <= tp]
        if sl_hit or tp_hit:
            if sl_hit and tp_hit:
                amb = True
                first_bar_event = 'AMBIG'
            elif sl_hit:
                first_bar_event = 'SL'
            else:
                first_bar_event = f'TP{tp_hit[0]+1}'
            rec['bar_first_minute'] = fmt_t(m * 60000)
            break
    rec['bar_first_event'] = first_bar_event or 'none_within_48h'
    rec['bar_same_minute_ambiguous'] = int(amb)
    tick_ev = rec['first_event']
    if first_bar_event == 'AMBIG':
        rec['bar_model_agrees'] = 'ambiguous'
    else:
        rec['bar_model_agrees'] = int((first_bar_event or 'none_within_48h') == tick_ev)
    # ---- provider claims linked to this signal ----
    cl = claims_by_sig.get(s['msg_id'], [])
    tpc = [c for c in cl if c['kind'] == 'TP_HIT']
    rec['claims_TP'] = ';'.join(f"TP{c['tp_index']}@{c['date_utc'][:16]}" for c in tpc)
    lossc = [c for c in cl if c['kind'] == 'LOSS']
    rec['claims_LOSS'] = ';'.join(c['date_utc'][:16] for c in lossc)
    agree = []
    for c in tpc:
        k = f"TP{c['tp_index']}"
        ours = touch.get(k)
        if ours is None:
            agree.append('claim_TP_not_reproduced')
        else:
            dtm = (ms_of(c['date_utc']) - ours) / 60000
            agree.append(f'{k}:claim_minus_model_min={dtm:+.1f}')
    rec['claim_check'] = ' | '.join(agree)
    return rec

rows = [run_one(s) for s in chosen]
keys = []
for r in rows:
    for k in r:
        if k not in keys: keys.append(k)
with open(os.path.join(DER, 'recon_sample.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(rows)

print('sample msg_ids (seed %d, N=%d, index into date-sorted signals):' % (SEED, N), [r['msg_id'] for r in rows])
from collections import Counter
print('results', dict(Counter(r.get('result', 'entered') for r in rows)))
print('geometry_ok', sum(int(r['geometry_ok']) for r in rows), 'of', len(rows))
print('first_event', dict(Counter(r.get('first_event', '-') for r in rows)))
print('bar_first_event', dict(Counter(r.get('bar_first_event', '-') for r in rows)))
print('bar_same_minute_ambiguous', sum(int(r.get('bar_same_minute_ambiguous', 0) or 0) for r in rows), 'of', len(rows))
print('bar_model_agrees', dict(Counter(str(r.get('bar_model_agrees', '-')) for r in rows)))
for r in rows:
    print(r['msg_id'], r['date_utc'][:16], r['direction'], r.get('result', 'entered'), 'entry', r['entry_low'], r['entry_high'], 'sl', r['sl'],
          'fill', r.get('fill_price', ''), 'lag_s', r.get('fill_lag_s', ''), 'first', r.get('first_event', ''), 'bar', r.get('bar_first_event', ''),
          'claims', r.get('claims_TP', ''), '|', r.get('claim_check', ''), 'LOSS', r.get('claims_LOSS', ''))
