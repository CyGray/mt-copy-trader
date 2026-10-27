"""Descriptive splits (BUY/SELL, UTC session, weekday, ex-ante regime) and the two PRE-REGISTERED hypotheses
(H1 direction, H2 regime) under the top finalist (E1 and E2, MID). Regime tercile cut-points are fixed on TRAIN.
Writes out/descriptive.csv and out/hypotheses.json. usage: python3 -I b2_descriptive.py"""
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
import numpy as np  # noqa: E402


def load(path):
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rt', newline='') as f:
        return list(csv.DictReader(f))


def session(ms):
    h = dt.datetime.fromtimestamp(int(ms) / 1000, dt.timezone.utc).hour
    if h < 7: return 'Asia 00-07'
    if h < 12: return 'London 07-12'
    if h < 17: return 'NY-overlap 12-17'
    return 'Late 17-24'


def weekday(ms):
    return dt.datetime.fromtimestamp(int(ms) / 1000, dt.timezone.utc).strftime('%a')


def main():
    fin = json.load(open(os.path.join(c.OUT, 'finalists.json')))
    top = fin['finalists'][0]['variant']
    names = [top, fin['benchmark']]
    reg = {r['message_id']: r for r in load(os.path.join(c.OUT, 'regime_features.csv'))}
    trades = [r for r in load(os.path.join(c.OUT, 'phase1_trades.csv.gz')) if r['variant'] in names and r['cost'] == 'MID']
    trades += [r for r in load(os.path.join(c.OUT, 'oos_trades.csv.gz')) if r['variant'] in names and r['cost'] == 'MID']
    # regime cut-points from TRAIN only
    tr_er = [float(reg[r['message_id']]['er4h']) for r in trades
             if r['split'] == 'train' and r['entry'] == 'E1' and r['variant'] == top and reg[r['message_id']]['er4h'] != '']
    tr_er_all = [float(r['er4h']) for r in reg.values() if r['split'] == 'train' and r['in_clean'] == '1' and r['er4h'] != '']
    lo_cut, hi_cut = np.percentile(tr_er_all, [33.3333, 66.6667])
    cuts = dict(er_low_cut=float(lo_cut), er_high_cut=float(hi_cut), n_train_with_regime=len(tr_er_all))

    def regime_of(mid):
        e = reg[mid]['er4h']
        if e == '':
            return 'unknown'
        e = float(e)
        return 'ranging(low ER)' if e <= lo_cut else ('trending(high ER)' if e > hi_cut else 'middle')

    rows = []
    hyp = {}
    for en in ('E1', 'E2'):
        for vn in names:
            for sp in ('train', 'val', 'oos'):
                xs = [r for r in trades if r['entry'] == en and r['variant'] == vn and r['split'] == sp
                      and r['total_R'] not in ('', None)]
                if not xs:
                    continue
                groups = {}
                for r in xs:
                    groups.setdefault(('direction', r['direction'].upper()), []).append(r)
                    groups.setdefault(('session', session(r['t_ms'])), []).append(r)
                    groups.setdefault(('weekday', weekday(r['t_ms'])), []).append(r)
                    groups.setdefault(('regime', regime_of(r['message_id'])), []).append(r)
                groups.setdefault(('all', 'ALL'), xs)
                for (dim, lvl), g in sorted(groups.items()):
                    R = np.array([float(r['total_R']) for r in g])
                    rows.append(dict(entry=en, variant=vn, split=sp, dimension=dim, level=lvl, n=len(R),
                                     mean_R=round(float(R.mean()), 4), win_rate_exBE=round(float(np.mean(R >= 0.10) /
                                                 max(1e-12, np.mean((R >= 0.10) | (R <= -0.10)))), 4) if np.any((R >= 0.10) | (R <= -0.10)) else ''))
                # hypotheses under the top finalist only
                if vn == top:
                    def diff_ci(a, b):
                        if len(a) < 2 or len(b) < 2:
                            return None
                        rng = np.random.default_rng(42)
                        A = np.array(a); B = np.array(b)
                        ia = rng.integers(0, len(A), size=(10000, len(A))); ib = rng.integers(0, len(B), size=(10000, len(B)))
                        d = A[ia].mean(axis=1) - B[ib].mean(axis=1)
                        return dict(diff=round(float(A.mean() - B.mean()), 4), ci95=[round(float(np.percentile(d, 2.5)), 4),
                                    round(float(np.percentile(d, 97.5)), 4)], n_a=len(A), n_b=len(B))
                    sell = [float(r['total_R']) for r in xs if r['direction'] == 'sell']
                    buy = [float(r['total_R']) for r in xs if r['direction'] == 'buy']
                    hi = [float(r['total_R']) for r in xs if regime_of(r['message_id']) == 'trending(high ER)']
                    lo = [float(r['total_R']) for r in xs if regime_of(r['message_id']) == 'ranging(low ER)']
                    hyp.setdefault(en, {}).setdefault(sp, {})['H1_sell_minus_buy'] = diff_ci(sell, buy)
                    hyp.setdefault(en, {}).setdefault(sp, {})['H2_trend_minus_range'] = diff_ci(hi, lo)
    with open(os.path.join(c.OUT, 'descriptive.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    json.dump(dict(top_finalist=top, regime_cuts=cuts, hypotheses=hyp), open(os.path.join(c.OUT, 'hypotheses.json'), 'w'),
              indent=1)
    print('top', top, cuts)
    for en in hyp:
        for sp in hyp[en]:
            print(en, sp, hyp[en][sp])


if __name__ == '__main__':
    main()
