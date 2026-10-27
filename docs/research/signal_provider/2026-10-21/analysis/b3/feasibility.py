#!/usr/bin/env python3
"""Task 2 feasibility maps over the 406 clean signals (SL distance = signal entry mid to SL).
Sizing uses the nominal distance (decision reference assumed = entry mid; flagged). Realised risk uses
distance + adverse fill a in {0,1,2} USD (a is always adverse: it widens the stop distance).
Outputs (tables/): T2a_policy_feasibility.csv, T2b_alloc_lot_grid.csv, T2c_alloc_signal_share.csv,
T2d_min_equity.csv; work/feas_summary.json.  Run: nice -n 10 python3 -I feasibility.py"""
import csv, json, math, os, statistics, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import risk_model as rm

SIG = json.load(open(os.path.join(HERE, 'work', 'signals_clean.json')))
SD = [s['sl_dist_nominal'] if 'sl_dist_nominal' in s else s['sl_dist'] for s in SIG]
EQUITY = [500, 1000, 5000, 10000, 50000]
SAFETY = {'DEFAULT': rm.DEFAULT_SAFETY, 'HARD': rm.HARD_SAFETY}
POLICIES = [('pct', v) for v in (0.25, 0.5, 1, 2)] + [('money', v) for v in (2, 5, 10, 25, 50, 100)] \
           + [('lots', v) for v in (0.01, 0.02, 0.03, 0.05, 0.10, 0.20)]
ALLOCS = {'A100': [100], 'A50_50': [50, 50], 'A50_30_20': [50, 30, 20], 'A40_30_30': [40, 30, 30],
          'A33_33_34': [33, 33, 34], 'R10_30_30_30_10': [30, 30, 30, 10],
          'R20_27_27_26_20': [26.67, 26.67, 26.66, 20], 'R30_23_23_24_30': [23.33, 23.33, 23.34, 30]}
SPEC = rm.SPEC_UNVERIFIED
OUT = os.path.join(HERE, 'tables')
os.makedirs(OUT, exist_ok=True)

def pick(vals, q):
    v = sorted(vals)
    if not v: return float('nan')
    p = (len(v) - 1) * q; lo = int(p); hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (p - lo)

def pol_dict(kind, val, below):
    return rm.sizing_policy(kind, val, below)

def run_policy_rows():
    rows = []
    for sname, safety in SAFETY.items():
        lim = rm.effective_limits(safety)
        for E in EQUITY:
            for kind, val in POLICIES:
                for below in ('skip', 'use_min_if_within_cap'):
                    for a in (0.0, 1.0, 2.0):
                        n = len(SD); ok_n = 0; below_n = 0; risk_n = 0; vol_n = 0; forced_n = 0
                        vols, real_pct, plan_pct, forced_pct, rounding_short = [], [], [], [], []
                        for d in SD:
                            r = rm.compute_volume_at_distance(pol_dict(kind, val, below), d, E, SPEC, lim)
                            if not r['ok']:
                                if r['reason'] == 'volume_below_min': below_n += 1
                                elif r['reason'] == 'risk_exceeds_limit': risk_n += 1
                                elif r['reason'] == 'volume_exceeds_max': vol_n += 1
                                continue
                            ok_n += 1
                            vols.append(r['volume'])
                            plan_pct.append(100 * r['volume'] * d * 100 / E)
                            real_pct.append(100 * r['volume'] * (d + a) * 100 / E)
                            # forced minimum: rounded volume below min, accepted via use_min_if_within_cap
                            raw = rm.round_volume_down(min(E * val / 100 if kind == 'pct' else val, r['cap']) / rm.risk_per_lot(d, SPEC), SPEC['volumeStep']) if kind in ('pct', 'money') else None
                            if below == 'use_min_if_within_cap' and raw is not None and raw + 1e-9 < SPEC['volumeMin']:
                                forced_n += 1; forced_pct.append(100 * SPEC['volumeMin'] * (d + a) * 100 / E)
                            if kind in ('pct', 'money'):
                                target = min(E * val / 100 if kind == 'pct' else val, r['cap'])
                                rounding_short.append(100 * (1 - r['riskMoney'] / target) if target > 0 else 0.0)
                        rows.append({
                            'safety': sname, 'equity_usd': E, 'policy_kind': kind, 'policy_value': val,
                            'below_min': below, 'adverse_usd': a, 'n_signals': n,
                            'tradeable_n': ok_n, 'tradeable_pct': round(100 * ok_n / n, 1),
                            'below_min_refused_pct': round(100 * below_n / n, 1),
                            'risk_exceeds_limit_pct': round(100 * risk_n / n, 1),
                            'volume_exceeds_max_pct': round(100 * vol_n / n, 1),
                            'forced_min_pct': round(100 * forced_n / n, 1),
                            'lots_median_tradeable': round(pick(vols, 0.5), 2) if vols else '',
                            'planned_risk_pct_median_nominal': round(pick(plan_pct, 0.5), 4) if plan_pct else '',
                            'realised_risk_pct_median': round(pick(real_pct, 0.5), 4) if real_pct else '',
                            'realised_risk_pct_p90': round(pick(real_pct, 0.9), 4) if real_pct else '',
                            'realised_risk_pct_max': round(max(real_pct), 4) if real_pct else '',
                            'rounding_shortfall_pct_median': round(pick(rounding_short, 0.5), 2) if rounding_short else '',
                            'forced_min_realised_risk_pct_median': round(pick(forced_pct, 0.5), 4) if forced_pct else '',
                        })
    return rows

def fixed_lot_rows():
    """Fixed-lot policies: risk per signal from its own distance (never resized)."""
    rows = []
    return rows

def lot_grid_rows():
    rows = []
    for name, pcts in ALLOCS.items():
        for i in range(1, 21):
            V = round(0.01 * i, 2)
            m = rm.plan_volume_split(V, pcts, SPEC, 'merge_into_next')
            s = rm.plan_volume_split(V, pcts, SPEC, 'skip_trade')
            rows.append({'allocation': name, 'pcts': '/'.join(str(p) for p in pcts), 'volume_lots': V,
                         'status_merge_into_next': m[0], 'legs_after_merge': ' '.join('TP%d:%.2f' % (k, v) for k, v in m[1]),
                         'status_skip_trade': s[0]})
    return rows

def signal_share_rows():
    rows = []
    for sname, safety in SAFETY.items():
        lim = rm.effective_limits(safety)
        for E in EQUITY:
            for kind, val in POLICIES:
                if kind == 'lots':
                    continue
                for name, pcts in ALLOCS.items():
                    c = {'exact': 0, 'merged': 0, 'skip_trade_refuses': 0, 'not_tradeable': 0}
                    for d in SD:
                        r = rm.compute_volume_at_distance(pol_dict(kind, val, 'skip'), d, E, SPEC, lim)
                        if not r['ok']:
                            c['not_tradeable'] += 1; continue
                        st = rm.plan_volume_split(r['volume'], pcts, SPEC, 'merge_into_next')[0]
                        ss = rm.plan_volume_split(r['volume'], pcts, SPEC, 'skip_trade')[0]
                        if ss == 'exact': c['exact'] += 1
                        else: c['skip_trade_refuses'] += 1
                        if st == 'merged': c['merged'] += 1
                    n = len(SD)
                    rows.append({'safety': sname, 'equity_usd': E, 'policy': '%s_%s' % (kind, val),
                                 'allocation': name, 'n': n,
                                 'not_tradeable_pct': round(100 * c['not_tradeable'] / n, 1),
                                 'exact_pct': round(100 * c['exact'] / n, 1),
                                 'merged_if_merge_into_next_pct': round(100 * c['merged'] / n, 1),
                                 'refused_if_skip_trade_pct': round(100 * c['skip_trade_refuses'] / n, 1)})
    return rows

def min_equity_for(alloc_pcts, pct_risk, d, safety, need='exact'):
    lim = rm.effective_limits(safety)
    def ok(E):
        r = rm.compute_volume_at_distance(rm.sizing_policy('pct', pct_risk, 'skip'), d, E, SPEC, lim)
        if not r['ok']: return False
        st = rm.plan_volume_split(r['volume'], alloc_pcts, SPEC, 'skip_trade')[0]
        return st == 'exact'
    lo, hi = 1.0, 2.0e6
    if not ok(hi): return None
    if ok(lo): return lo
    for _ in range(80):
        mid = (lo + hi) / 2
        if ok(mid): hi = mid
        else: lo = mid
        if hi - lo < 0.01: break
    return round(hi, 2)

def min_equity_rows():
    rows = []
    dq = {'median': pick(SD, 0.5), 'p90': pick(SD, 0.9), 'p95': pick(SD, 0.95), 'max_clean': max(SD)}
    for sname, safety in SAFETY.items():
        for name, pcts in ALLOCS.items():
            for pr in (0.25, 0.5, 1, 2):
                for dname, d in dq.items():
                    E = min_equity_for(pcts, pr, d, safety)
                    rows.append({'safety': sname, 'allocation': name, 'risk_percent': pr,
                                 'distance_case': dname, 'distance_usd': d,
                                 'min_equity_exact_split_usd': E if E is not None else 'never (cap)'})
    return rows

def write_csv(path, rows):
    with open(path, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

def main():
    t2a = run_policy_rows(); write_csv(os.path.join(OUT, 'T2a_policy_feasibility.csv'), t2a)
    t2b = lot_grid_rows(); write_csv(os.path.join(OUT, 'T2b_alloc_lot_grid.csv'), t2b)
    t2c = signal_share_rows(); write_csv(os.path.join(OUT, 'T2c_alloc_signal_share.csv'), t2c)
    t2d = min_equity_rows(); write_csv(os.path.join(OUT, 'T2d_min_equity.csv'), t2d)
    summ = {'n_signals': len(SD), 'sl_quantiles': {q: pick(SD, q) for q in (0.05, 0.5, 0.9, 0.95)},
            'sl_max': max(SD), 'rows': {'T2a': len(t2a), 'T2b': len(t2b), 'T2c': len(t2c), 'T2d': len(t2d)}}
    json.dump(summ, open(os.path.join(HERE, 'work', 'feas_summary.json'), 'w'), indent=1)
    print(json.dumps(summ, indent=1))

if __name__ == '__main__':
    main()
