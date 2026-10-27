#!/usr/bin/env python3
"""Variant: EQ3 with infeasible_split=skip_trade (no merging) vs merge_into_next, deterministic path,
DEFAULT and HARD safety, BASE fills. Writes tables/T4h_skip_vs_merge.csv. nice -n 10 python3 -I skip_split_variant.py"""
import csv, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import equity_sim as es, risk_model as rm
rows = []
tr = es.trades('BASE', 'EQ3')
for sname, safety in es.SAFE.items():
    for E0 in es.EQS:
        for kind, val in [('pct', 0.25), ('pct', 0.5), ('pct', 1), ('pct', 2), ('money', 25), ('lots', 0.05)]:
            for pol in ('merge_into_next', 'skip_trade'):
                s = es.path_summary(tr, (kind, val), E0, safety, gates=True, infeasible=pol)
                rows.append({'safety': sname, 'equity0': E0, 'policy': f'{kind}_{val}', 'infeasible_split': pol,
                             'strategy': 'EQ3', 'scen': 'BASE', **s})
with open(os.path.join(HERE, 'tables', 'T4h_skip_vs_merge.csv'), 'w', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print(len(rows))
