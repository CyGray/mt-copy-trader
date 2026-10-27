#!/usr/bin/env python3
"""B3 data prep (read-only). Reads B1 outputs and writes work/signals_clean.json and
work/trades.json (per signal x scenario x strategy legs). Nothing outside b3/ is written.
Run: nice -n 10 python3 -I data_prep.py
"""
import csv, json, os, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
B1 = '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/b1'
WORK = os.path.join(HERE, 'work')
CONTRACT = 100.0  # UNVERIFIED for Vantage XAUUSD (B1 assumption, kept for cross-checks)


def quantile(xs, q):
    xs = sorted(xs)
    if not xs:
        return float('nan')
    pos = (len(xs) - 1) * q
    lo, hi = int(pos), min(int(pos) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def main():
    os.makedirs(WORK, exist_ok=True)
    signals = []
    with open(os.path.join(B1, 'signals_universe.csv'), newline='') as fh:
        for r in csv.DictReader(fh):
            if r['in_clean'] != '1':
                continue
            tps = [float(r[f'tp{k}']) for k in range(1, 8) if r[f'tp{k}'] != '']
            signals.append({
                'message_id': r['message_id'], 't_ms': int(r['t_ms']), 'direction': r['direction'],
                'entry_low': float(r['entry_low']), 'entry_high': float(r['entry_high']),
                'entry_mid': float(r['entry_mid']), 'sl': float(r['sl']),
                'sl_dist': float(r['sl_dist']), 'tps': tps, 'num_tps': int(r['num_tps']),
                'hard_flags': r['hard_flags'], 'info_flags': r['info_flags'],
            })
    clean_ids = {s['message_id'] for s in signals}
    with open(os.path.join(B1, 'results.json')) as fh:
        res = json.load(fh)
    per = res['per_signal']

    trades = []
    checks = {'usd_mismatch': 0, 'frac_sum_bad': 0, 'n_checked': 0}
    for s in signals:
        mid = s['message_id']
        rec = per.get(mid)
        if rec is None:
            continue
        sgn = 1.0 if s['direction'] == 'buy' else -1.0
        for scen in ('BASE', 'PESS'):
            srec = rec['scen'][scen]
            if srec['status'] != 'FILLED':
                continue
            fill = srec['fill_px']
            for strat, out in srec['strat'].items():
                exits = out['exits']  # [kind, ms, price, fraction] per leg, planner order
                if out.get('usd_per_1lot') is None or not exits:
                    checks['skipped_or_unpriced'] = checks.get('skipped_or_unpriced', 0) + 1
                    continue
                fr = [e[3] for e in exits]
                checks['n_checked'] += 1
                if abs(sum(fr) - 1.0) > 1e-6:
                    checks['frac_sum_bad'] += 1
                legs = [{'kind': e[0], 'ms': e[1], 'price': e[2], 'fraction': e[3],
                         'move': sgn * (e[2] - fill)} for e in exits]
                usd = CONTRACT * sum(l['fraction'] * l['move'] for l in legs)
                if abs(usd - out['usd_per_1lot']) > 1e-6 * max(1.0, abs(usd)):
                    checks['usd_mismatch'] += 1
                trades.append({
                    'message_id': mid, 'scen': scen, 'strategy': strat, 'direction': s['direction'],
                    'fill_ms': srec['fill_ms'], 'fill_px': fill, 'sl': s['sl'],
                    'sl_dist_nominal': s['sl_dist'], 'r_usd_fill': abs(fill - s['sl']),
                    'close_ms': max(l['ms'] for l in legs), 'legs': legs,
                    'total_R': out['total_R'], 'usd_per_1lot': out['usd_per_1lot'],
                    'outcome': out['outcome'], 'exit_seq': out['exit_seq'],
                    'flags': out.get('flags', []),
                })
    trades.sort(key=lambda t: (t['fill_ms'], t['message_id'], t['scen'], t['strategy']))
    with open(os.path.join(WORK, 'signals_clean.json'), 'w') as fh:
        json.dump(signals, fh)
    with open(os.path.join(WORK, 'trades.json'), 'w') as fh:
        json.dump(trades, fh)

    dif = [t['r_usd_fill'] - t['sl_dist_nominal'] for t in trades if t['scen'] == 'BASE' and t['strategy'] == 'EQ3']
    sd = [s['sl_dist'] for s in signals]
    summary = {
        'clean_signals': len(signals), 'clean_ids_with_trades': len({t['message_id'] for t in trades}),
        'trade_legs_rows': len(trades), 'checks': checks,
        'sl_dist_clean_quantiles': {q: round(quantile(sd, q), 4) for q in (0.05, 0.10, 0.25, 0.5, 0.75, 0.90, 0.95, 0.99)},
        'sl_dist_clean_min_max': [min(sd), max(sd)],
        'sl_dist_clean_mean': round(statistics.mean(sd), 4),
        'BASE_EQ3_filled_n': len(dif),
        'fill_minus_nominal_sl_dist_usd': {'median': round(statistics.median(dif), 4),
                                           'p90': round(quantile(dif, 0.9), 4),
                                           'max': round(max(dif), 4), 'min': round(min(dif), 4)},
    }
    with open(os.path.join(WORK, 'data_prep_summary.json'), 'w') as fh:
        json.dump(summary, fh, indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == '__main__':
    sys.exit(main())
