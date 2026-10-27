"""Lot-rounded feasibility of each intended allocation (project rule: volume_min 0.01, step 0.01, non-final closes
round down, final takes remainder, undersized splits merge into next). Uses sim_engine_b2.plan_legs on a
synthetic BUY with all TPs beyond entry, so only lot arithmetic decides the outcome. Fill-independent.
Output: out/feasibility.csv (Simulated arithmetic, n = 1 synthetic trade per cell)."""
import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402
import sim_engine_b2 as se  # noqa: E402

LOTS = (0.01, 0.02, 0.03, 0.05, 0.10)


def run():
    sig = se.Signal('syn', 0, 'buy', 4000.0, 4000.0, 3995.0, (4005.0, 4010.0, 4015.0, 4020.0, 4025.0, 4030.0, 4035.0))
    rows = []
    cells = [(an, cps, 0.0, None) for an, cps in c.ALLOCS.items() if len(cps) > 1]
    cells += [('CA_T33_at_TP2', c.ALLOCS['T_33_33_34'], 0.0, 2), ('CA_Q25_at_TP3', c.ALLOCS['Q_25x4'], 0.0, 3)]
    for r in (20.0,):
        cells += [(f'RUN2_r{r:g}', ((1, (100 - r) / 2), (2, (100 - r) / 2)), r, None),
                  (f'RUN3_r{r:g}', ((1, (100 - r) / 3), (2, (100 - r) / 3), (3, (100 - r) / 3)), r, None)]
    for an, cps, runner, ca in cells:
        for lot in LOTS:
            strat = se.Strategy('x', checkpoints=cps, runner_pct=runner, close_all_at=ca, units='lots',
                                total_lots=lot, volume_min=0.01, volume_step=0.01, missing_tp='merge_into_last_available',
                                infeasible_split='merge_into_next')
            try:
                legs, warns = se.plan_legs(sig, 4000.0, strat)
            except se.Skip as e:
                rows.append(dict(allocation=an, lots=lot, outcome='SKIP_' + e.reason, legs=0, intact=0,
                                 max_pct_dev=None, warnings=''))
                continue
            merged = any('merged' in w for w in warns)
            intended = [k for k, _ in cps if ca is None or k <= ca]
            ks_out = [l['tp_index'] for l in legs if l['kind'] == 'tp']
            dev = 0.0
            for l in legs:
                if l['kind'] == 'tp':
                    want = dict(cps).get(l['tp_index'], 0.0)
                    dev = max(dev, abs(100 * l['frac'] - want))
            rows.append(dict(allocation=an, lots=lot, outcome='MERGED' if merged else 'INTACT',
                             legs=len(legs), intact=int(not merged), max_pct_dev=round(dev, 2),
                             warnings=';'.join(warns), cps_kept=' '.join(map(str, ks_out)),
                             intended_cps=len(intended)))
    with open(os.path.join(c.OUT, 'feasibility.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return rows


if __name__ == '__main__':
    rs = run()
    for r in rs:
        print(r['allocation'], r['lots'], r['outcome'], r.get('cps_kept', ''), r['max_pct_dev'], r['warnings'][:70])
