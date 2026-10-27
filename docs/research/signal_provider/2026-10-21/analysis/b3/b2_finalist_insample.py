#!/usr/bin/env python3
"""IN-SAMPLE sizing check of B2's top frozen finalist S_TP4|M0 (cost MID), TRAIN + VAL trades only.
The OOS trade file is never opened (B2 evaluates OOS once; oos_evaluated.lock exists).
Single-leg (TP4 100%), so P&L per lot = usd_per_1lot exactly. Writes tables/T4i_b2_finalist_insample.csv.
Run: nice -n 10 python3 -I b2_finalist_insample.py"""
import csv, gzip, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import risk_model as rm
import equity_sim as es
SRC = '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/b2/out/phase1_trades.csv.gz'
trades = {'E1': [], 'E2': []}
with gzip.open(SRC, 'rt') as fh:
    for r in csv.DictReader(fh):
        if r['variant'] != 'S_TP4|M0' or r['cost'] != 'MID' or r['entry'] not in trades:
            continue
        if r['split'] not in ('train', 'val') or r['status'] != 'FILLED':
            continue
        trades[r['entry']].append({'id': r['message_id'], 'open_ms': int(r['fill_ms']), 'close_ms': int(r['last_exit_ms']),
                                   'sd': float(r['sl_dist_signal']), 'entry_px': float(r['fill_px']),
                                   'legs': [(100.0, float(r['usd_per_1lot']) / 100.0)], 'r': float(r['total_R']),
                                   'R_usd': float(r['R_usd'])})
rows = []
for E_name, tr in trades.items():
    tr.sort(key=lambda t: t['open_ms'])
    for E0 in (1000, 5000, 10000):
        for kind, val in [('pct', 0.25), ('pct', 0.5), ('pct', 1), ('money', 25), ('lots', 0.05)]:
            cfg = rm.make_cfg(rm.DEFAULT_SAFETY, adverse=0.0)
            out = rm.run_path(tr, rm.sizing_policy(kind, val, 'skip'), E0, cfg, gates=True)
            mdd, mdd_usd = rm.max_drawdown(out['curve'])
            rows.append({'label': 'IN-SAMPLE TRAIN+VAL (B2 finalist S_TP4|M0, not OOS)', 'entry': E_name, 'equity0': E0,
                         'policy': f'{kind}_{val}', 'n_trades_TV': len(tr), 'taken': len(out['taken']),
                         'final_equity': round(out['final_equity'], 2), 'return_pct': round(100 * (out['final_equity'] / E0 - 1), 2),
                         'max_dd_closed_pct': round(mdd, 2), 'skips': str(out['skips']),
                         'mean_R_TV': round(sum(t['r'] for t in tr) / len(tr), 4),
                         'winrate_TV_pct': round(100 * sum(1 for t in tr if t['r'] > 0) / len(tr), 1)})
# iid bootstrap (10,000, seed 42) of max closed-equity DD at 1% and 0.5% for E=5000, DEFAULT caps
for E_name, tr in trades.items():
    lim = rm.effective_limits(rm.DEFAULT_SAFETY)
    for kind, val in [('pct', 0.5), ('pct', 1)]:
        rng = random.Random(42); mdds = []
        for _ in range(10000):
            E = 5000.0; peak = E; mdd = 0.0
            for _k in range(len(tr)):
                t = tr[rng.randrange(len(tr))]
                L = es.fast_L(kind, val, E, t['sd'], lim)
                if L is None: continue
                E += L * t['legs'][0][1] * 100
                peak = max(peak, E); mdd = max(mdd, (peak - E) / peak)
            mdds.append(100 * mdd)
        mdds.sort()
        rows.append({'label': 'IN-SAMPLE iid bootstrap 10k seed 42 (DEFAULT, E0=5000)', 'entry': E_name, 'equity0': 5000,
                     'policy': f'{kind}_{val}', 'n_trades_TV': len(tr), 'taken': '', 'final_equity': '',
                     'return_pct': '', 'max_dd_closed_pct': f'p50 {mdds[5000]:.2f} / p95 {mdds[9500]:.2f} / p99 {mdds[9900]:.2f}',
                     'skips': '', 'mean_R_TV': '', 'winrate_TV_pct': ''})
with open(os.path.join(HERE, 'tables', 'T4i_b2_finalist_insample.csv'), 'w', newline='') as fh:
    keys = []
    for r in rows:
        for k in r:
            if k not in keys: keys.append(k)
    w = csv.DictWriter(fh, fieldnames=keys); w.writeheader(); w.writerows(rows)
for E_name, tr in trades.items():
    print(E_name, 'n_TV', len(tr), 'mean R', round(sum(t['r'] for t in tr)/len(tr), 4))
