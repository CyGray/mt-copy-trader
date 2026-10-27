"""Multiplicity-aware analysis.
 (1) OOS paired bootstrap (10,000, seed 42) of each frozen finalist minus the frozen benchmark, per entry and cost,
     on the common fill set; Holm correction across the 5 finalists within entry x cost.
 (2) TRAIN+VALIDATION (in-sample, exploratory) White Reality Check over the full grid vs the benchmark (E1, E2; MID).
 (3) TRAIN+VAL landscape by family, TP1-sacrifice (single exits, paired) and runner-vs-schema (paired).
Writes out/oos_paired.csv, out/tv_paired.csv, out/landscape.csv, out/analysis.json."""
import csv
import gzip
import json
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402
import b2_stats as st  # noqa: E402
import numpy as np  # noqa: E402


def load(path):
    with gzip.open(path, 'rt', newline='') as f:
        return list(csv.DictReader(f))


def r_map(trades, en, cn, vn):
    return {r['message_id']: float(r['total_R']) for r in trades
            if r['entry'] == en and r['cost'] == cn and r['variant'] == vn and r['total_R'] not in ('', None)}


def holm(pvals):
    order = sorted(range(len(pvals)), key=lambda i: pvals[i])
    adj = [None] * len(pvals)
    m = len(pvals); run = 0.0
    for rank, i in enumerate(order):
        v = min(1.0, (m - rank) * pvals[i])
        run = max(run, v)
        adj[i] = run
    return adj


def main():
    fin = json.load(open(os.path.join(c.OUT, 'finalists.json')))
    fnames = [d['variant'] for d in fin['finalists']]
    bench = fin['benchmark']
    oos = load(os.path.join(c.OUT, 'oos_trades.csv.gz'))
    tv = load(os.path.join(c.OUT, 'phase1_trades.csv.gz'))
    res = {'oos_paired': [], 'tv_paired': []}
    # (1) OOS paired, Holm across finalists within entry x cost
    for en in ('E1', 'E2'):
        for cn in ('BASE', 'MID', 'PESS'):
            pv = []; rows = []
            bm = r_map(oos, en, cn, bench)
            for fv in fnames:
                fm = r_map(oos, en, cn, fv)
                d = st.paired_diff(fm, bm)
                rows.append(dict(entry=en, cost=cn, finalist=fv, benchmark=bench, split='oos', **d,
                                 n_finalist=len(fm), n_bench=len(bm)))
                pv.append(d.get('p_two_sided', 1.0))
            for rr, pa in zip(rows, holm(pv)):
                rr['p_holm_within_entry_cost'] = round(pa, 4)
            res['oos_paired'] += rows
    # TV paired (in-sample, descriptive)
    for en in ('E1', 'E2'):
        for cn in ('MID',):
            bm = r_map(tv, en, cn, bench)
            for fv in fnames:
                fm = r_map(tv, en, cn, fv)
                d = st.paired_diff(fm, bm)
                res['tv_paired'].append(dict(entry=en, cost=cn, finalist=fv, benchmark=bench, split='train+val', **d))
    # (2) White Reality Check over the grid, TRAIN+VAL, MID, vs benchmark
    names = [v['name'] for v in c.build_grid() if v['name'] != bench]
    rc = {}
    for en in ('E1', 'E2'):
        bm = r_map(tv, en, 'MID', bench)
        maps = {vn: r_map(tv, en, 'MID', vn) for vn in names}
        full = [vn for vn in names if len(maps[vn]) == len(bm) and set(maps[vn]) == set(bm)]
        common = sorted(set(bm).intersection(*[set(maps[vn]) for vn in full])) if full else []
        if not full or not common:
            rc[en] = dict(note='no common support'); continue
        D = np.array([[maps[vn][m] - bm[m] for vn in full] for m in common])
        out = st.reality_check(D)
        out.update(entry=en, cost='MID', signals_common=len(common), variants_in_rc=len(full),
                   variants_total=len(names), benchmark=bench)
        rc[en] = out
    res['reality_check'] = rc
    # (3) landscape by family and TP1 sacrifice / runner
    fam = {v['name']: v for v in c.build_grid()}
    land = []
    for en in ('E1', 'E2'):
        for cn in ('MID',):
            per = defaultdict(list)
            for vn in names + [bench]:
                m = r_map(tv, en, cn, vn)
                if not m:
                    continue
                mean = float(np.mean(list(m.values())))
                per[fam[vn]['family']].append((vn, mean, len(m)))
            for f_, lst in per.items():
                means = [x[1] for x in lst]
                land.append(dict(entry=en, cost=cn, family=f_, n_variants=len(lst),
                                 median_of_variant_means=round(float(np.median(means)), 4),
                                 best_variant=max(lst, key=lambda x: x[1])[0],
                                 best_mean_R=round(max(means), 4),
                                 share_variants_positive=round(float(np.mean([m > 0 for m in means])), 3),
                                 min_n=min(x[2] for x in lst), max_n=max(x[2] for x in lst)))
    # TP1 sacrifice: single exits on common fills (TP1..TP4 all defined)
    sac = {}
    for en in ('E1', 'E2'):
        sing = ['S_TP1|M0', 'S_TP2|M0', 'S_TP3|M0', 'S_TP4|M0']
        maps = {v: r_map(tv, en, 'MID', v) for v in sing}
        common = sorted(set.intersection(*[set(m) for m in maps.values()]))
        sac[en] = dict(n_common=len(common), mean={v: round(float(np.mean([maps[v][m] for m in common])), 4) if common else None
                                                   for v in sing})
        for v in sing[1:]:
            if common:
                sac[en][f'paired_{v}_minus_TP1'] = st.paired_diff({m: maps[v][m] for m in common},
                                                                 {m: maps['S_TP1|M0'][m] for m in common})
    res['tp1_sacrifice_TV_common_fills'] = sac
    # runner vs schema-expressible best (in-sample, descriptive)
    rv = {}
    for en in ('E1', 'E2'):
        cand = {vn: r_map(tv, en, 'MID', vn) for vn in names}
        sch = {vn: m for vn, m in cand.items() if fam[vn]['family'] != 'runner' and len(m) >= 60}
        run = {vn: m for vn, m in cand.items() if fam[vn]['family'] == 'runner' and len(m) >= 60}
        bs = max(sch, key=lambda vn: np.mean(list(sch[vn].values())))
        br = max(run, key=lambda vn: np.mean(list(run[vn].values())))
        common = sorted(set(sch[bs]) & set(run[br]))
        rv[en] = dict(best_schema=bs, best_schema_mean=round(float(np.mean(list(sch[bs].values()))), 4),
                      best_schema_n=len(sch[bs]),
                      best_runner=br, best_runner_mean=round(float(np.mean(list(run[br].values()))), 4),
                      best_runner_n=len(run[br]), n_common=len(common),
                      paired_runner_minus_schema=st.paired_diff({m: run[br][m] for m in common},
                                                                {m: sch[bs][m] for m in common}))
    res['runner_vs_schema_TV'] = rv
    # write
    for key, fname in (('oos_paired', 'oos_paired.csv'), ('tv_paired', 'tv_paired.csv'), ('landscape', 'landscape.csv')):
        rows = res[key] if key != 'landscape' else land
        if not rows:
            continue
        with open(os.path.join(c.OUT, fname), 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=sorted({k for r in rows for k in r.keys()}, key=lambda k: list(rows[0].keys()).index(k) if k in rows[0] else 99))
            w.writeheader(); w.writerows(rows)
    res['landscape'] = land
    json.dump(res, open(os.path.join(c.OUT, 'analysis.json'), 'w'), indent=1, default=str)
    print('OOS paired:')
    for r in res['oos_paired']:
        print(r['entry'], r['cost'], r['finalist'], 'n', r['n_paired'], 'diff', round(r['mean_diff'], 3),
              'CI', round(r['ci95_lo'], 3), round(r['ci95_hi'], 3), 'p', round(r['p_two_sided'], 3), 'holm', r['p_holm_within_entry_cost'])
    print('RC', {k: {kk: v.get(kk) for kk in ('n_obs', 'variants_in_rc', 'max_mean_diff', 'p_value', 'signals_common')} for k, v in rc.items()})
    print('TP1 sacrifice', sac)
    print('runner vs schema', rv)


if __name__ == '__main__':
    main()
