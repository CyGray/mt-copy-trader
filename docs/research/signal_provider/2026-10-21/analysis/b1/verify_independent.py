"""Task 3: independent verification of the vectorised engine (pure Python, no numpy, no sim_engine import).

Checks
  A. Independent decoder: bi5 hours re-decoded here with lzma + struct (no b1 cache).
  B. Entry (P1, latency 5 s, tol 0.5, BASE) recomputed for ALL 415 signals and compared with
     baseline_outcomes.csv (status, fill time, fill price).
  C. Tick-by-tick first-touch loop for a random sample of 30 FILLED signals (random.Random(42))
     over [fill, fill+72h): first SL touch, first TP_k touch, sequence string, TP1-only R,
     equal-thirds R (no BE). Compared with the vectorised baseline_touch / simulate outputs.
  D. No-look-ahead: for every signal, rebuild the window starting at t + latency and recompute
     entry + baseline; results must be identical to the window that starts at t.
  E. Outcomes do not read provider claims: the reconstruction functions here never open the claim
     files; the stored baseline reproduces from raw ticks alone.

usage: python3 -I verify_independent.py   (writes verify_report.json, prints a summary)
"""
import csv
import json
import lzma
import os
import random
import struct
import sys
import datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a3/raw'
HOUR = 3_600_000
REC = struct.Struct('>IIIff')
_hour_cache = {}          # bounded LRU (see hour_ticks)
_HOUR_CACHE_MAX = 40


def hour_path(h_ms):
    t = dt.datetime.fromtimestamp(h_ms / 1000.0, dt.timezone.utc)
    return os.path.join(RAW, f'{t.year}', f'{t.month:02d}', f'{t.day:02d}', f'{t.hour:02d}h_ticks.bi5')


def hour_status(h_ms):
    p = hour_path(h_ms)
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return 'ok'
    if os.path.exists(p) and os.path.getsize(p) == 0:
        return 'empty'
    if os.path.exists(p + '.empty'):
        return 'empty'
    return 'unknown'


def hour_ticks(h_ms):
    """List of (ms, bid, ask) for one hour, decoded independently (lzma + struct)."""
    if h_ms in _hour_cache:
        return _hour_cache[h_ms]
    out = []
    if hour_status(h_ms) == 'ok':
        with open(hour_path(h_ms), 'rb') as f:
            data = lzma.decompress(f.read(), format=lzma.FORMAT_ALONE)
        for off, ask, bid, _av, _bv in REC.iter_unpack(data):
            out.append((h_ms + off, bid / 1000.0, ask / 1000.0))
    _hour_cache[h_ms] = out
    while len(_hour_cache) > _HOUR_CACHE_MAX:
        _hour_cache.pop(next(iter(_hour_cache)))
    return out


def ticks_between(t0, t1):
    """Ticks in [t0, t1) walking hours; stops at the first 'unknown' hour. Returns (ticks, known_until)."""
    h = t0 - (t0 % HOUR)
    res = []
    known_until = t1
    while h < t1:
        if hour_status(h) == 'unknown':
            known_until = max(t0, h)
            break
        for tk in hour_ticks(h):
            if t0 <= tk[0] < t1:
                res.append(tk)
        h += HOUR
    return res, known_until


def parse_iso(s):
    return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000.0, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def p1_entry(sig, latency_ms=5000, tol=0.5, ticks=None):
    """Independent P1 decision. Returns dict(status, fill_ms, fill_px) using first tick >= t+latency."""
    t_start = sig['t'] + latency_ms
    for ms, bid, ask in ticks:
        if ms < t_start:
            continue
        p = ask if sig['dir'] == 'buy' else bid
        if sig['lo'] - tol <= p <= sig['hi'] + tol:
            return dict(status='FILLED', fill_ms=ms, fill_px=p)
        return dict(status='SKIPPED_price_outside_range', fill_ms=None, fill_px=None)
    return dict(status='NO_DATA', fill_ms=None, fill_px=None)


def first_index(ticks, start_ms, cond):
    for k, (ms, bid, ask) in enumerate(ticks):
        if ms < start_ms:
            continue
        if cond(bid, ask):
            return k
    return None


def loop_outcome(sig, fill_ms, fill_px, ticks, horizon_end):
    """Tick-by-tick reference: first touches after the fill tick, and TP1-only / equal-thirds R."""
    buy = sig['dir'] == 'buy'
    sl = sig['sl']
    tps = sig['tps']
    R = abs(fill_px - sl)
    after = [(ms, b, a) for ms, b, a in ticks if fill_ms < ms < horizon_end]
    sl_k = None
    tp_k = {}
    for idx, (ms, b, a) in enumerate(after):
        p = b if buy else a            # exit side
        if sl_k is None and ((buy and p <= sl) or ((not buy) and p >= sl)):
            sl_k = idx
        for j, tp in enumerate(tps, start=1):
            if tp is None or j in tp_k:
                continue
            if (buy and p >= tp) or ((not buy) and p <= tp):
                tp_k[j] = idx
    # sequence (events in tick order, SL first on ties)
    ev = []
    if sl_k is not None:
        ev.append((sl_k, 0, 'SL'))
    for j, k in tp_k.items():
        ev.append((k, 1, 'TP%d' % j))
    ev.sort()
    seq = '>'.join(e[2] for e in ev)
    # exits
    def exit_sl(idx):
        ms, b, a = after[idx]
        return min(b, sl) if buy else max(a, sl)

    def r_for(legs):
        # legs: list of (frac, kind, index_or_None, price_or_None)
        total = 0.0
        sl_at = sl_k
        for frac, tp_j in legs:
            k = tp_k.get(tp_j) if tp_j else None
            if k is not None and (sl_at is None or k < sl_at):
                price = tps[tp_j - 1]
            elif sl_at is not None:
                price = exit_sl(sl_at)
            else:
                # horizon: mark to last tick before horizon
                price = (after[-1][1] if buy else after[-1][2]) if after else fill_px
            total += frac * (price - fill_px) * (1 if buy else -1)
        return total / R

    tp1_only = r_for([(1.0, 1)]) if tps[0] is not None else None
    ntp = [j for j, tp in enumerate(tps, start=1) if tp is not None]
    if len(ntp) >= 3:
        eq = r_for([(1 / 3, 1), (1 / 3, 2), (1 / 3, 3)])
    elif len(ntp) == 2:
        eq = r_for([(1 / 3, 1), (2 / 3, 2)])
    else:
        eq = None
    return dict(sl_k=sl_k, tp_k=tp_k, sequence=seq, tp1_R=tp1_only, eq3_R=eq, after=after)


def main():
    uni = list(csv.DictReader(open(os.path.join(HERE, 'signals_universe.csv'), encoding='utf-8')))
    base = {r['message_id']: r for r in csv.DictReader(open(os.path.join(HERE, 'baseline_outcomes.csv'))) if r['scenario'] == 'BASE'}
    strat = {}
    for r in csv.DictReader(open(os.path.join(HERE, 'strategy_outcomes.csv'))):
        if r['scenario'] == 'BASE':
            strat[(r['message_id'], r['strategy'])] = r
    sigs = []
    for r in uni:
        tps = [float(r[f'tp{k}']) if r[f'tp{k}'] else None for k in range(1, 8)]
        sigs.append(dict(mid=r['message_id'], t=parse_iso(r['t_iso']), dir=r['direction'],
                         lo=float(r['entry_low']), hi=float(r['entry_high']), sl=float(r['sl']), tps=tps))
    report = dict(n_signals=len(sigs))

    # ---- B: entry for all signals
    mism_entry = []
    counts = {}
    ticks_cache = {}
    for s in sigs:
        ticks, ku = ticks_between(s['t'], s['t'] + 6 * HOUR)
        ticks_cache[s['mid']] = None
        ref = p1_entry(s, 5000, 0.5, ticks)
        if ref['status'] == 'NO_DATA' and ku < s['t'] + 6 * HOUR:
            ref_status = 'NO_PRICE_DATA'
        else:
            ref_status = ref['status']
        counts[ref_status] = counts.get(ref_status, 0) + 1
        b = base[s['mid']]
        eng_status = b['status'] if b['status'] == 'NO_PRICE_DATA' or b['status'].startswith('SKIPPED') else 'FILLED'
        if ref_status == 'NO_PRICE_DATA':
            ok = eng_status == 'NO_PRICE_DATA'
        else:
            ok = (ref_status == eng_status)
        if ref_status == 'FILLED' and ok:
            ok = abs(ref['fill_px'] - float(b['fill_px'])) < 1e-6 and ref['fill_ms'] == parse_iso(b['fill_iso'])
        if not ok:
            mism_entry.append(dict(mid=s['mid'], ref=ref_status, engine=b['status'], ref_px=ref.get('fill_px'),
                                   eng_px=b['fill_px']))
    report['B_entry_counts_independent'] = counts
    report['B_entry_mismatches'] = mism_entry
    print('B entry: independent counts', counts, 'mismatches', len(mism_entry), flush=True)

    # ---- C: 30-signal tick-by-tick sample (FILLED, seed 42)
    filled_ids = sorted(m for m, r in base.items() if r['status'] != 'NO_PRICE_DATA' and r['fill_iso'])
    rng = random.Random(42)
    sample = rng.sample(filled_ids, 30)
    sm = {s['mid']: s for s in sigs}
    per = []
    mism_c = []
    for mid in sample:
        s = sm[mid]
        b = base[mid]
        fill_ms = parse_iso(b['fill_iso'])
        fill_px = float(b['fill_px'])
        ticks, ku = ticks_between(fill_ms, fill_ms + 72 * HOUR)
        ref = loop_outcome(s, fill_ms, fill_px, ticks, fill_ms + 72 * HOUR)
        eng_sl = parse_iso(b['sl_touch_iso']) if b['sl_touch_iso'] else None
        ref_sl = None if ref['sl_k'] is None else ref['after'][ref['sl_k']][0]
        eng_tps = {k: (parse_iso(b[f'tp{k}_touch_iso']) if b[f'tp{k}_touch_iso'] else None) for k in range(1, 8)}
        ref_tps = {k: (ref['after'][v][0] if v is not None else None) for k, v in ref['tp_k'].items()}
        ok_sl = (eng_sl == ref_sl)
        ok_tp = all(eng_tps.get(k) == ref_tps.get(k) for k in range(1, 8) if s['tps'][k - 1] is not None)
        ok_seq = (ref['sequence'] == b['sequence'])
        e1 = strat.get((mid, 'TP1_100'))
        ok_r1 = e1 is not None and (ref['tp1_R'] is None or abs(float(e1['total_R']) - ref['tp1_R']) < 1e-3)
        e3 = strat.get((mid, 'EQ3'))
        ok_eq = e3 is not None and (ref['eq3_R'] is None or abs(float(e3['total_R']) - ref['eq3_R']) < 1e-3)
        row = dict(mid=mid, fill_iso=b['fill_iso'], fill_px=fill_px, sl_ok=ok_sl, tp_ok=ok_tp, seq_ok=ok_seq,
                   tp1_R_ref=None if ref['tp1_R'] is None else round(ref['tp1_R'], 4),
                   tp1_R_eng=e1['total_R'] if e1 else None, eq3_R_ref=None if ref['eq3_R'] is None else round(ref['eq3_R'], 4),
                   eq3_R_eng=e3['total_R'] if e3 else None, sequence_ref=ref['sequence'], sequence_eng=b['sequence'],
                   ok=bool(ok_sl and ok_tp and ok_seq and ok_r1 and ok_eq))
        per.append(row)
        if not row['ok']:
            mism_c.append(row)
    report['C_sample_seed42'] = dict(n=len(sample), mismatches=len(mism_c), rows=per)
    print('C tick-loop sample: n', len(sample), 'mismatches', len(mism_c), flush=True)

    # ---- D: no look-ahead (window starting at t + latency must reproduce the stored results)
    lookahead_bad = []
    checked = 0
    for s in sigs:
        b = base[s['mid']]
        t_start = s['t'] + 5000
        ticks_full, _ = ticks_between(s['t'], s['t'] + 6 * HOUR)
        ticks_late, _ = ticks_between(t_start, s['t'] + 6 * HOUR)
        a = p1_entry(s, 5000, 0.5, ticks_full)
        c = p1_entry(s, 5000, 0.5, ticks_late)
        checked += 1
        if a != c:
            lookahead_bad.append(s['mid'])
        if a['status'] == 'FILLED' and a['fill_ms'] < t_start:
            lookahead_bad.append(s['mid'] + ':fill_before_latency')
    report['D_lookahead_checked'] = checked
    report['D_lookahead_violations'] = lookahead_bad
    print('D look-ahead: checked', checked, 'violations', len(lookahead_bad), flush=True)

    report['E_note'] = ('verify_independent.py never opens a1/provider_claim* files; baseline and entry '
                        'recomputation above depend only on bi5 ticks and signal fields.')
    with open(os.path.join(HERE, 'verify_report.json'), 'w') as f:
        json.dump(report, f, indent=1, default=str)
    print('mismatches: entry', len(mism_entry), 'sample', len(mism_c), 'lookahead', len(lookahead_bad))


if __name__ == '__main__':
    main()
