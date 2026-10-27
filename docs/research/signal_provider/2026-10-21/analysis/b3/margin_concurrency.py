#!/usr/bin/env python3
"""Task 3: margin per lot, margin-level floor, concurrency from observed signal times, correlated risk.
Margin model (UNVERIFIED for Vantage): margin_per_lot = contract(100 oz) * price / leverage * factor(1).
Outputs tables/T3a_margin_per_lot.csv, T3b_max_lots_at_floor.csv, T3c_margin_level_by_policy.csv,
T3d_concurrency.csv, T3e_total_risk_slots.csv; work/margin_summary.json. Run: nice -n 10 python3 -I margin_concurrency.py"""
import csv, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import risk_model as rm
OUT = os.path.join(HERE, 'tables')
SIG = json.load(open(os.path.join(HERE, 'work', 'signals_clean.json')))
TR = json.load(open(os.path.join(HERE, 'work', 'trades.json')))
PRICES = [3900, 4500, 5000, 5600]          # observed range in B1 qc (min 3915.07, max 5599.72)
LEV = [100, 500, 1000]
EQ = [500, 1000, 5000, 10000, 50000]
H = 3600 * 1000

def write_csv(path, rows):
    with open(path, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

def pick(vals, q):
    v = sorted(vals); p = (len(v) - 1) * q; lo = int(p); hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (p - lo)

def t3a():
    return [{'price_usd': P, 'leverage': f'1:{L}', 'margin_per_lot_usd': round(rm.margin_per_lot(P, L), 2),
             'basis': 'Modelled: 100 oz x price / leverage (UNVERIFIED)'} for P in PRICES for L in LEV]

def t3b():
    rows = []
    for E in EQ:
        for L in LEV:
            for P in PRICES:
                lots = E * L / (200 * P)  # margin <= E/2 at the 200% floor
                rows.append({'equity_usd': E, 'leverage': f'1:{L}', 'price_usd': P,
                             'max_total_lots_at_200pct_floor': round(lots, 3),
                             'equity_per_0.01_lot_margin_usd': round(rm.margin_per_lot(P, L) * 0.01, 3)})
    return rows

def t3c():
    """Margin level (%) for N concurrent positions. Percent policies: level is independent of equity
    (volume scales with equity). Fixed money / lots: equity needed to keep >= 200%."""
    rows = []
    D_med, D_p90 = pick([s['sl_dist'] for s in SIG], 0.5), pick([s['sl_dist'] for s in SIG], 0.9)
    pols = [('pct', 0.5), ('pct', 1), ('pct', 2), ('money', 25), ('money', 50), ('money', 100), ('lots', 0.01), ('lots', 0.05), ('lots', 0.10), ('lots', 0.20)]
    for kind, val in pols:
        for Dname, D in (('median', D_med), ('p90', D_p90)):
            for N in (1, 3):
                for P in (4500, 5600):
                    for L in (100, 500, 1000):
                        for E in (10000,):
                            sizing = rm.sizing_policy(kind, val, 'skip')
                            lim = rm.effective_limits(rm.HARD_SAFETY)  # margin only: no cap to hide the margin effect
                            r = rm.compute_volume_at_distance(sizing, D, E, rm.SPEC_UNVERIFIED, lim)
                            if not r['ok']:
                                continue
                            V = r['volume']
                            marg = N * rm.margin_per_lot(P, L) * V
                            level = 100 * E / marg if marg > 0 else float('nan')
                            # money/lots volumes do not depend on equity, so the 200% floor needs equity >= 2 x margin
                            Ebind = 2 * marg
                            rows.append({'policy': f'{kind}_{val}', 'distance': Dname, 'D_usd': round(D, 2),
                                         'N_concurrent': N, 'price_usd': P, 'leverage': f'1:{L}', 'equity_usd': E,
                                         'volume_lots': round(V, 2), 'margin_total_usd': round(marg, 2),
                                         'margin_level_pct': round(level, 0),
                                         'equity_for_200pct_usd': round(Ebind, 2) if kind != 'pct' else 'E-invariant (level=%.0f%%)' % level})
    return rows

def concurrency_rows():
    rows = []
    # (a) all 406 clean arrivals, assuming every signal fills (upper bound), hold H
    for hold_h in (24, 72):
        hold = hold_h * 3600 * 1000
        counts, same = [], []
        ts = sorted(SIG, key=lambda s: s['t_ms'])
        for i, s in enumerate(ts):
            opn = [j for j in range(i) if ts[j]['t_ms'] + hold > s['t_ms']]
            counts.append(len(opn) + 1)  # including this one
            same.append(len([j for j in opn if ts[j]['direction'] == s['direction']]) + 1)
        rows.append({'population': 'all_406_clean_assume_fill', 'hold_h': hold_h, 'n': len(counts),
                     'open_incl_new_p50': pick(counts, 0.5), 'open_p90': pick(counts, 0.9), 'open_p99': pick(counts, 0.99),
                     'open_max': max(counts), 'same_dir_max': max(same), 'same_dir_p90': pick(same, 0.9),
                     'share_arrivals_with_overlap_pct': round(100 * sum(1 for c in counts if c > 1) / len(counts), 1)})
    # (b) B1 BASE and PESS fills, EQ3 legs; actual close time = last exit
    for scen in ('BASE', 'PESS'):
        tr = [t for t in TR if t['scen'] == scen and t['strategy'] == 'EQ3']
        tr.sort(key=lambda t: t['fill_ms'])
        counts, same = [], []
        for i, t in enumerate(tr):
            opn = [j for j in range(i) if tr[j]['close_ms'] > t['fill_ms']]
            counts.append(len(opn) + 1)
            same.append(len([j for j in opn if tr[j]['direction'] == t['direction']]) + 1)
        rows.append({'population': f'B1_{scen}_EQ3_fills_actual_close', 'hold_h': 'actual', 'n': len(counts),
                     'open_incl_new_p50': pick(counts, 0.5), 'open_p90': pick(counts, 0.9), 'open_p99': pick(counts, 0.99),
                     'open_max': max(counts), 'same_dir_max': max(same), 'same_dir_p90': pick(same, 0.9),
                     'share_arrivals_with_overlap_pct': round(100 * sum(1 for c in counts if c > 1) / len(counts), 1)})
    return rows

def t3e():
    """How many same-direction positions of risk r fit the total-risk gate (openRisk + new <= total x E)."""
    rows = []
    for tot in (3, 20):
        for r in (0.25, 0.5, 1, 2):
            n = int(tot / r + 1e-9)
            rows.append({'max_total_risk_pct': tot, 'risk_per_trade_pct': r, 'max_positions_by_total_risk': n,
                         'worst_correlated_loss_pct_at_sl': round(n * r, 2),
                         'worst_correlated_loss_pct_with_2usd_adverse_p90D': round(n * r * (7.5 + 2) / 7.5, 2),
                         'note': 'Gate: planned risk only; per-symbol gate (default 1) binds first'})
    return rows

def main():
    write_csv(os.path.join(OUT, 'T3a_margin_per_lot.csv'), t3a())
    write_csv(os.path.join(OUT, 'T3b_max_lots_at_floor.csv'), t3b())
    write_csv(os.path.join(OUT, 'T3c_margin_level_by_policy.csv'), t3c())
    cc = concurrency_rows(); write_csv(os.path.join(OUT, 'T3d_concurrency.csv'), cc)
    write_csv(os.path.join(OUT, 'T3e_total_risk_slots.csv'), t3e())
    json.dump({'concurrency': cc}, open(os.path.join(HERE, 'work', 'margin_summary.json'), 'w'), indent=1)
    print(json.dumps(cc, indent=1))

if __name__ == '__main__':
    main()
