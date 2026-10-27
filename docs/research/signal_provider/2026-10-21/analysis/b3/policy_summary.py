#!/usr/bin/env python3
"""Task 5: three sizing policies per equity scenario, assembled from the other tables (no new simulation).
Reads tables/*.csv and work/trades.json; writes tables/T5a_policy_summary.csv, tables/T5b_runner_min_equity.csv,
tables/T5c_observed_streaks.csv. Run after feasibility.py, equity_sim.py.  nice -n 10 python3 -I policy_summary.py"""
import csv, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
OUT = os.path.join(HERE, 'tables')
POL = {'Conservative': 'pct_0.25', 'Balanced': 'pct_0.5', 'Aggressive': 'pct_1'}
EQS = ['500', '1000', '5000', '10000', '50000']

def rd(name):
    return list(csv.DictReader(open(os.path.join(OUT, name))))

def pick(rows, **kw):
    out = [r for r in rows if all(str(r.get(k)) == str(v) for k, v in kw.items())]
    return out

def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None

def main():
    T2a = rd('T2a_policy_feasibility.csv'); T2c = rd('T2c_alloc_signal_share.csv')
    T4a = rd('T4a_path_sim.csv'); T4b = rd('T4b_bootstrap.csv'); T4c = rd('T4c_daily_breach.csv'); T4d = rd('T4d_full_loss_streaks.csv')
    T2d = rd('T2d_min_equity.csv')
    trades = json.load(open(os.path.join(HERE, 'work', 'trades.json')))
    eq3 = sorted([t for t in trades if t['scen'] == 'BASE' and t['strategy'] == 'EQ3'], key=lambda t: t['fill_ms'])
    seq = [t['usd_per_1lot'] < 0 for t in eq3]
    best = cur = 0
    for x in seq:
        cur = cur + 1 if x else 0; best = max(best, cur)
    rows_c = [{'sample': 'B1 BASE EQ3 fills (chronological, n=%d)' % len(eq3), 'observed_losing_streak_max': best,
               'losses': sum(seq), 'wins_or_flat': len(seq) - sum(seq)}]
    write(os.path.join(OUT, 'T5c_observed_streaks.csv'), rows_c)

    rows = []
    for name, pol in POL.items():
        for E in EQS:
            a0 = pick(T2a, safety='DEFAULT', equity_usd=E, policy_kind='pct', policy_value=pol.split('_')[1], below_min='skip', adverse_usd='0.0')
            a2 = pick(T2a, safety='DEFAULT', equity_usd=E, policy_kind='pct', policy_value=pol.split('_')[1], below_min='skip', adverse_usd='2.0')
            a0 = a0[0] if a0 else {}; a2 = a2[0] if a2 else {}
            a4 = pick(T4a, safety='DEFAULT', strategy='EQ3', equity0=E, policy=pol, gates='on', adverse_usd='0')
            a4 = a4[0] if a4 else {}
            b5 = pick(T4b, strategy='EQ3', safety='DEFAULT', resample='block5', equity0=E, policy=pol)
            b5 = b5[0] if b5 else {}
            bi = pick(T4b, strategy='EQ3', safety='DEFAULT', resample='iid', equity0=E, policy=pol)
            bi = bi[0] if bi else {}
            d8 = pick(T4d, safety='DEFAULT', equity0=E, policy=pol, adverse_usd='2.0', sizing_distance_name='median_406')
            d8 = d8[0] if d8 else {}
            dd = pick(T4c, equity0=E, policy=pol, daily_limit='100 USD')
            dd = dd[0] if dd else {}
            dd1 = pick(T4c, equity0=E, policy=pol, daily_limit='1% of E0')
            dd1 = dd1[0] if dd1 else {}
            s10 = pick(T2c, safety='DEFAULT', equity_usd=E, policy=pol, allocation='R10_30_30_30_10')
            s10 = s10[0] if s10 else {}
            s3 = pick(T2c, safety='DEFAULT', equity_usd=E, policy=pol, allocation='A50_30_20')
            s3 = s3[0] if s3 else {}
            rows.append({
                'policy': name, 'sizing': pol, 'equity_usd': E,
                'signals_tradeable_pct_of_406': a0.get('tradeable_pct'),
                'signals_below_min_refused_pct': a0.get('below_min_refused_pct'),
                'planned_risk_pct_median_tradeable': a0.get('planned_risk_pct_median_nominal'),
                'realised_risk_pct_median_adverse2': a2.get('realised_risk_pct_median'),
                'realised_risk_pct_p90_adverse2': a2.get('realised_risk_pct_p90'),
                'B1_EQ3_taken_of_67': a4.get('taken'), 'B1_EQ3_skipped_by_gates': a4.get('skip_reasons'),
                'B1_EQ3_path_max_dd_pct': a4.get('max_dd_closed_pct'), 'B1_EQ3_return_pct': a4.get('return_pct'),
                'boot_block5_maxdd_p50_pct': b5.get('maxdd_p50_pct'), 'boot_block5_maxdd_p95_pct': b5.get('maxdd_p95_pct'),
                'boot_block5_maxdd_p99_pct': b5.get('maxdd_p99_pct'),
                'boot_iid_maxdd_p95_pct': bi.get('maxdd_p95_pct'),
                'boot_block5_P_dd_ge_20pct': b5.get('P_dd_ge_20pct'), 'boot_block5_P_dd_ge_30pct': b5.get('P_dd_ge_30pct'),
                'boot_block5_P_equity_le_50pct': b5.get('P_ruin_equity_le_50pct'),
                'boot_block5_losing_streak_p95': b5.get('losing_streak_p95'), 'boot_block5_losing_streak_p99': b5.get('losing_streak_p99'),
                'loss_pct_after_8_full_losses_adverse2': d8.get('loss_pct_after_8_full_losses'),
                'loss_pct_after_10_full_losses_adverse2': d8.get('loss_pct_after_10_full_losses'),
                'P_daily_gate_per_day_100USD': dd.get('P_gate_triggers_per_day_slot'),
                'P_daily_gate_per_day_1pct_E0': dd1.get('P_gate_triggers_per_day_slot'),
                'R10_3cp_runner_exact_pct_of_406': s10.get('exact_pct'),
                'R10_3cp_runner_merged_if_merge_pct': s10.get('merged_if_merge_into_next_pct'),
                'A50_30_20_exact_pct_of_406': s3.get('exact_pct'),
            })
    write(os.path.join(OUT, 'T5a_policy_summary.csv'), rows)

    mins = []
    for alloc in ('R10_30_30_30_10', 'R20_27_27_26_20', 'R30_23_23_24_30', 'A50_30_20'):
        for pr in ('0.25', '0.5', '1', '2'):
            r = {'allocation': alloc, 'risk_percent': pr}
            for dc in ('median', 'p90', 'max_clean'):
                m = pick(T2d, safety='DEFAULT', allocation=alloc, risk_percent=pr, distance_case=dc)
                r['min_equity_default_%s' % dc] = m[0]['min_equity_exact_split_usd'] if m else ''
            m = pick(T2d, safety='HARD', allocation=alloc, risk_percent=pr, distance_case='median')
            r['min_equity_hard_median'] = m[0]['min_equity_exact_split_usd'] if m else ''
            mins.append(r)
    write(os.path.join(OUT, 'T5b_runner_min_equity.csv'), mins)
    print('observed longest losing streak (B1 BASE EQ3):', best, 'of', len(eq3))

def write(path, rows):
    keys = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    with open(path, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=keys); w.writeheader(); w.writerows(rows)

if __name__ == '__main__':
    main()
