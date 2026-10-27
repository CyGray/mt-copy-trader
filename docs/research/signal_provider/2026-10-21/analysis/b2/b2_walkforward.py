"""Walk-forward robustness check over the FROZEN finalist family + benchmark (MID costs, E1 and E2 separately).
Each test month (Jan-Sep 2026, UTC, by signal time): pick the family member with the highest mean R over the
previous <=3 calendar months (min 5 determined trades, else benchmark); record its realised R in the test month.
Note: the months overlap TRAIN/VAL/OOS, so this is a robustness check, not an independent test.
usage: python3 -I b2_walkforward.py"""
import collections
import csv
import datetime as dt
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402
import b2_stats as st  # noqa: E402


def month_of(ms):
    d = dt.datetime.fromtimestamp(int(ms) / 1000, dt.timezone.utc)
    return d.year * 12 + d.month - 1


def label(m):
    return f"{m // 12}-{m % 12 + 1:02d}"


def load(path):
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rt', newline='') as f:
        return list(csv.DictReader(f))


def main():
    fin = json.load(open(os.path.join(c.OUT, 'finalists.json')))
    names = [d['variant'] for d in fin['finalists']] + [fin['benchmark']]
    trades = [r for r in load(os.path.join(c.OUT, 'phase1_trades.csv.gz')) if r['variant'] in names and r['cost'] == 'MID']
    trades += [r for r in load(os.path.join(c.OUT, 'oos_trades.csv.gz')) if r['variant'] in names and r['cost'] == 'MID']
    out = []
    for en in ('E1', 'E2'):
        rows = [r for r in trades if r['entry'] == en and r['total_R'] not in ('', None)]
        by = collections.defaultdict(lambda: collections.defaultdict(list))   # month -> variant -> [R]
        for r in rows:
            by[month_of(r['t_ms'])][r['variant']].append(float(r['total_R']))
        months = sorted(set(by))
        test_months = [m for m in months if m >= month_of(1767225600000)]   # 2026-01-01T00:00Z onward
        realised = []
        for m in test_months:
            train_ms = [mm for mm in months if m - 3 <= mm < m]
            cand = {}
            for v in names:
                xs = [x for mm in train_ms for x in by[mm].get(v, [])]
                if len(xs) >= 5:
                    cand[v] = sum(xs) / len(xs)
            pick = max(cand, key=lambda v: (cand[v], v)) if cand else fin['benchmark']
            test = by[m].get(pick, [])
            fixed = {v: by[m].get(v, []) for v in names}
            realised.append(dict(entry=en, month=label(m), picked=pick, n_train_trades=sum(len(by[mm].get(pick, [])) for mm in train_ms),
                                 n_test=len(test), test_sum_R=round(sum(test), 4),
                                 test_mean_R=(round(sum(test) / len(test), 4) if test else ''),
                                 **{f'fixed_{v}_sum_R': round(sum(fixed[v]), 4) for v in names},
                                 **{f'fixed_{v}_n': len(fixed[v]) for v in names}))
        out += realised
    if not out:
        print('no walk-forward rows')
        return
    keys = list(out[0].keys())
    with open(os.path.join(c.OUT, 'walkforward.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(out)
    for en in ('E1', 'E2'):
        rs = [r for r in out if r['entry'] == en]
        tot_n = sum(r['n_test'] for r in rs)
        tot_R = sum(float(r['test_sum_R']) for r in rs)
        print(en, 'months', len(rs), 'test trades', tot_n, 'walk-forward sum R', round(tot_R, 3),
              'mean R', round(tot_R / tot_n, 4) if tot_n else None)
        for v in names:
            n = sum(int(r[f'fixed_{v}_n']) for r in rs)
            s = sum(float(r[f'fixed_{v}_sum_R']) for r in rs)
            print('   fixed', v, 'n', n, 'mean R', round(s / n, 4) if n else None)


if __name__ == '__main__':
    main()
