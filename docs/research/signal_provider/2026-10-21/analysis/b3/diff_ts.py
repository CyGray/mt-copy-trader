#!/usr/bin/env python3
"""Differential test: Python risk_model port vs the repo's positionSizing.ts (compiled to work/ts_build).
Run: nice -n 10 python3 -I diff_ts.py   -> prints mismatch counts; writes work/diff_ts_report.json"""
import json, os, random, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import risk_model as rm

BUILD = os.path.join(HERE, 'work', 'ts_build')

def rand_cases(n, seed=42):
    rng = random.Random(seed)
    cases = []
    spec_choices = [rm.SPEC_UNVERIFIED,
                    {'tickSize': 0.01, 'tickValueLoss': 1.0, 'volumeMin': 0.01, 'volumeMax': 2.0, 'volumeStep': 0.01},
                    {'tickSize': 0.01, 'tickValueLoss': 1.0, 'volumeMin': 0.05, 'volumeMax': 100.0, 'volumeStep': 0.01},
                    {'tickSize': 0.001, 'tickValueLoss': 0.1, 'volumeMin': 0.1, 'volumeMax': 50.0, 'volumeStep': 0.1}]
    for _ in range(n):
        spec = rng.choice(spec_choices)
        limits = {'maxRiskMoney': rng.choice([5, 25, 50, 500, 5000]), 'maxRiskPercent': rng.choice([0.5, 1, 2, 5]),
                  'maxLots': rng.choice([0.2, 1, 2, 20])}
        mode = rng.choice(['equity_risk_percent', 'fixed_risk_money', 'fixed_lots'])
        sizing = {'mode': mode, 'below_min_volume': rng.choice(['skip', 'use_min_if_within_cap'])}
        if mode == 'equity_risk_percent': sizing['risk_percent'] = rng.choice([0.25, 0.5, 1, 2, 0.0])
        if mode == 'fixed_risk_money': sizing['risk_money'] = rng.choice([2, 5, 10, 25, 50, 100, 0.0])
        if mode == 'fixed_lots': sizing['fixed_lots'] = rng.choice([0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.105, 1.0, 25.0])
        entry = 4000 + rng.random() * 1500
        d = rng.choice([0.5, 2.0, 3.0, 5.0, 7.5, 8.5, 12.0, 0.004]) if rng.random() < 0.9 else 0.0
        sl = entry - d if rng.random() < 0.5 else entry + d
        equity = rng.choice([0.0, 300, 500, 1000, 5000, 10000, 50000, 1e6])
        cases.append({'kind': 'volume', 'sizing': sizing, 'entry': entry, 'sl': sl, 'equity': equity,
                      'spec': spec, 'limits': limits})
    # checkpoint planning
    pct_sets = [[100], [50, 50], [50, 30, 20], [40, 30, 30], [33.33333333333333, 33.33333333333333, 33.33333333333334],
                [30, 30, 30, 10], [26.67, 26.67, 26.66, 20]]
    for _ in range(n):
        pcts = rng.choice(pct_sets)
        direction = rng.choice(['buy', 'sell'])
        entry = 4000.0
        base = [entry + (i + 1) * 5 for i in range(len(pcts))] if direction == 'buy' else [entry - (i + 1) * 5 for i in range(len(pcts))]
        if rng.random() < 0.1:
            base = list(reversed(base))
        if rng.random() < 0.05 and len(base) > 1:
            base = base[:-1]
        tp_cfg = {'checkpoints': [{'tp_index': i + 1, 'close_percent': p} for i, p in enumerate(pcts)],
                  'missing_tp': rng.choice(['skip_trade', 'merge_into_last_available']),
                  'infeasible_split': rng.choice(['skip_trade', 'merge_into_next']),
                  'broker_tp': rng.choice(['final_checkpoint', 'none'])}
        spec = {'volumeMin': rng.choice([0.01, 0.05, 0.1]), 'volumeStep': rng.choice([0.01, 0.1])}
        total = rng.choice([0.0, 0.005, 0.01, 0.02, 0.03, 0.04, 0.07, 0.1, 0.11, 0.25, 0.5, 1.0, 3.3])
        cases.append({'kind': 'plan', 'total': total, 'direction': direction, 'entry': entry, 'tps': base,
                      'takeProfit': tp_cfg, 'spec': spec})
    return cases

def py_eval(c):
    if c['kind'] == 'volume':
        r = rm.compute_volume(c['sizing'], c['entry'], c['sl'], c['equity'], c['spec'], c['limits'])
        if r['ok']:
            return {'ok': True, 'volume': r['volume'], 'riskMoney': r['riskMoney'], 'clampedBy': r.get('clampedBy')}
        return {'ok': False, 'reason': r['reason']}
    tps = c['tps']
    r = rm.plan_checkpoints(c['total'], c['direction'], c['entry'], tps, c['takeProfit'], c['spec'])
    if not r['ok']:
        return {'ok': False, 'reason': r['reason']}
    return {'ok': True, 'checkpoints': [[k['tpIndex'], k['closeVolume'], k['targetRemainingVolume']] for k in r['checkpoints']],
            'brokerTp': r['brokerTp'], 'warnings': len(r['warnings'])}

def same(a, b):
    if a.get('ok') != b.get('ok'):
        return False
    if not a['ok']:
        return a['reason'] == b['reason']
    if 'volume' in a:
        return abs(a['volume'] - b['volume']) < 1e-12 and abs(a['riskMoney'] - b['riskMoney']) < 1e-9 \
            and (a.get('clampedBy') or None) == (b.get('clampedBy') or None)
    return a['checkpoints'] == b['checkpoints'] and abs(a['brokerTp'] - b['brokerTp']) < 1e-12 and a['warnings'] == b['warnings']

def main():
    cases = rand_cases(3000)
    p = subprocess.run(['node', os.path.join(HERE, 'diff_ts_node.js'), BUILD], input=json.dumps(cases),
                       capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        print(p.stderr); return 1
    ts = json.loads(p.stdout)
    mism, counts = [], {'volume': 0, 'plan': 0}
    reasons = {}
    for c, t in zip(cases, ts):
        counts[c['kind']] += 1
        q = py_eval(c)
        if not t.get('ok', False):
            reasons[t.get('reason')] = reasons.get(t.get('reason'), 0) + 1
        if not same(q, t):
            mism.append({'case': c, 'py': q, 'ts': t})
    rep = {'cases': len(cases), 'by_kind': counts, 'mismatches': len(mism), 'ts_failure_reasons': reasons,
           'first_mismatches': mism[:5]}
    with open(os.path.join(HERE, 'work', 'diff_ts_report.json'), 'w') as fh:
        json.dump(rep, fh, indent=1, default=str)
    print(json.dumps({k: v for k, v in rep.items() if k != 'first_mismatches'}, indent=1))
    return 0 if not mism else 2

if __name__ == '__main__':
    sys.exit(main())
