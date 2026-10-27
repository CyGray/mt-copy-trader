#!/usr/bin/env python3
"""T3f: max concurrent positions of a percent policy under the 200% margin floor (closed form, checked
against compute_volume at HARD caps). Writes tables/T3f_max_concurrent_margin_floor.csv. nice -n 10 python3 -I t3f_margin_floor.py"""
import csv, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import risk_model as rm
rows = []
for lev in (100, 500, 1000):
    for P in (4500, 5600):
        for D in (5.0, 7.5):
            for r in (0.25, 0.5, 1, 2):
                nmax = math.floor(10000 * D * lev / (200 * r * P) + 1e-9)
                V = rm.compute_volume_at_distance(rm.sizing_policy('pct', r, 'skip'), D, 10000, rm.SPEC_UNVERIFIED, rm.effective_limits(rm.HARD_SAFETY))['volume']
                lvl1 = 100 * 10000 / (V * 100 * P / lev)
                assert abs(lvl1 - 10000 * D * lev / (r * P)) / lvl1 < 0.12
                rows.append({'leverage': f'1:{lev}', 'price_usd': P, 'D_usd': D, 'risk_percent': r,
                             'margin_level_1_position_pct_approx': round(10000 * D * lev / (r * P), 0),
                             'max_concurrent_at_200pct_floor': nmax,
                             'basis': 'Modelled: level = 10000*D*lev/(N*r*P); margin factor 1.0; leverage UNVERIFIED'})
with open(os.path.join(HERE, 'tables', 'T3f_max_concurrent_margin_floor.csv'), 'w', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print(len(rows))
