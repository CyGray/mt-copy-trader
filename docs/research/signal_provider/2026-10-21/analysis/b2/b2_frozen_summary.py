"""Frozen family (finalists + benchmark) summary across TRAIN, VALIDATION, OOS, all costs, both entries, with
exposure (median/p90 hours fill -> last exit). Reads out/*_metrics.csv and trade files; writes out/frozen_summary.csv.
usage: python3 -I b2_frozen_summary.py"""
import csv, gzip, json, os, sys, statistics as S
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import b2_core as c  # noqa: E402


def load(p):
    op = gzip.open if p.endswith('.gz') else open
    with op(p, 'rt', newline='') as f:
        return list(csv.DictReader(f))


def main():
    fin = json.load(open(os.path.join(c.OUT, 'finalists.json')))
    names = [d['variant'] for d in fin['finalists']] + [fin['benchmark']]
    cols = ['n', 'n_fills_entry', 'mean_R', 'ci95_lo', 'ci95_hi', 'win_rate_all', 'loss_rate', 'be_rate', 'win_rate_exBE',
            'pf', 'mdd_R_closed', 'mdd_usd_per_1lot_closed', 'longest_loss_streak', 'blk5_dd_R_p95', 'blk5_dd_R_p99',
            'blk5_streak_p95', 'blk5_streak_p99', 'iid_dd_R_p95', 'mae_R_median', 'drop_top5_mean_R', 'tp1_hit_rate',
            'tp2_hit_rate', 'tp3_hit_rate', 'tp4_hit_rate', 'mean_usd_per_1lot']
    out = []
    for sp in ('train', 'val', 'oos'):
        for r in load(os.path.join(c.OUT, f'{sp}_metrics.csv')):
            if r['variant'] in names and r['entry'] in ('E1', 'E2', 'E3'):
                row = dict(split=sp, entry=r['entry'], cost=r['cost'], variant=r['variant'], schema_expressible=r['schema_expressible'])
                row.update({k: r.get(k, '') for k in cols})
                out.append(row)
    tr_all = load(os.path.join(c.OUT, 'phase1_trades.csv.gz')) + load(os.path.join(c.OUT, 'oos_trades.csv.gz'))
    for row in out:
        h = [(int(r['last_exit_ms']) - int(r['fill_ms'])) / 3.6e6 for r in tr_all
             if r['split'] == row['split'] and r['entry'] == row['entry'] and r['cost'] == row['cost']
             and r['variant'] == row['variant'] and r['total_R'] not in ('', None)]
        row['exposure_median_h'] = round(S.median(h), 2) if h else ''
        row['exposure_p90_h'] = round(sorted(h)[max(0, int(0.9 * len(h)) - 1)], 2) if h else ''
    with open(os.path.join(c.OUT, 'frozen_summary.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        w.writeheader(); w.writerows(out)
    print('rows', len(out))


if __name__ == '__main__':
    main()
