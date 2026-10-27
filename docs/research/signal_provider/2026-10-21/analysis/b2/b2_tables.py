"""Metric tables per split from phase-1/phase-2 trade files. usage: python3 -I b2_tables.py <split> [trades_csv_gz] [fills_csv]"""
import collections
import csv
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402
import b2_stats as st  # noqa: E402


def load_csv(path):
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt', newline='') as f:
        return list(csv.DictReader(f))


def fill_summary(fills, split):
    """Per (entry, cost): clean signals, FILLED count, skip reason counts (Observed/Reconstructed fills)."""
    rows = [f for f in fills if f['split'] == split and f['in_clean'] == '1']
    grp = collections.OrderedDict()
    for f in rows:
        k = (f['entry'], f['cost'])
        g = grp.setdefault(k, dict(entry=f['entry'], cost=f['cost'], n_signals=0, n_filled=0, skips=collections.Counter()))
        g['n_signals'] += 1
        if f['status'] == 'FILLED':
            g['n_filled'] += 1
        else:
            g['skips'][f['status']] += 1
    out = []
    for k, g in grp.items():
        out.append(dict(split=split, entry=g['entry'], cost=g['cost'], n_signals=g['n_signals'], n_filled=g['n_filled'],
                        fill_rate=round(g['n_filled'] / g['n_signals'], 4),
                        skip_breakdown=';'.join(f'{a}:{b}' for a, b in sorted(g['skips'].items()))))
    return out


def metric_table(trades, split, fills_by_group):
    groups = collections.OrderedDict()
    for r in trades:
        if r['split'] != split:
            continue
        groups.setdefault((r['entry'], r['cost'], r['variant']), []).append(r)
    fam = {v['name']: v for v in c.build_grid()}
    out = []
    for (en, cn, vn), rows in groups.items():
        m = st.metrics(rows)
        v = fam[vn]
        base = dict(split=split, entry=en, cost=cn, variant=vn, family=v['family'], alloc=v['alloc'], mgmt=v['mgmt'],
                    runner_pct=v['runner'], schema_expressible=int(v['family'] != 'runner'),
                    n_fills_entry=fills_by_group.get((split, en, cn), 0), n_rows=m['n_rows'])
        base['n_not_taken'] = m['n_rows'] - m['n']
        base.update(m)
        out.append(base)
    return out


def main():
    split = sys.argv[1]
    trades_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(c.OUT, 'phase1_trades.csv.gz')
    fills_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(c.OUT, 'phase1_fills.csv')
    fills = load_csv(fills_path)
    trades = load_csv(trades_path)
    fb = {}
    for f in fills:
        if f['split'] == split and f['in_clean'] == '1' and f['status'] == 'FILLED':
            fb[(split, f['entry'], f['cost'])] = fb.get((split, f['entry'], f['cost']), 0) + 1
    fs = fill_summary(fills, split)
    tab = metric_table(trades, split, fb)
    tag = split
    with open(os.path.join(c.OUT, f'{tag}_fill_summary.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(fs[0].keys()))
        w.writeheader()
        w.writerows(fs)
    keys = list(tab[0].keys())
    with open(os.path.join(c.OUT, f'{tag}_metrics.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for row in tab:
            w.writerow({k: ('' if row.get(k) is None else (round(row[k], 5) if isinstance(row.get(k), float) else row.get(k)))
                        for k in keys})
    print(split, 'groups', len(tab), 'fill summary rows', len(fs))


if __name__ == '__main__':
    main()
