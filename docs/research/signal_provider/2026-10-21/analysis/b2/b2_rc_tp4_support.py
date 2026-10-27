"""White Reality Check on the full-support subset (signals where ALL 196 variants are determined, i.e. the TP4-present
signals), TRAIN+VAL, MID, E1 and E2 separately. vs ZERO and vs the benchmark (S_TP1|M0). In-sample (exploratory).
Output: out/rc_tp4_support.json. usage: python3 -I b2_rc_tp4_support.py"""
import csv, gzip, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import b2_core as c, b2_stats as st, numpy as np  # noqa: E401


def load(p):
    with gzip.open(p, 'rt', newline='') as f:
        return list(csv.DictReader(f))


def main():
    tv = load(os.path.join(c.OUT, 'phase1_trades.csv.gz'))
    names = [v['name'] for v in c.build_grid()]
    out = {}
    for en in ('E1', 'E2'):
        maps = {vn: {} for vn in names}
        for r in tv:
            if r['entry'] == en and r['cost'] == 'MID' and r['total_R'] not in ('', None):
                maps[r['variant']][r['message_id']] = float(r['total_R'])
        common = sorted(set.intersection(*[set(maps[vn]) for vn in names]))
        D = np.array([[maps[vn][m] for vn in names] for m in common])
        bm = np.array([maps['S_TP1|M0'][m] for m in common])
        out[en] = dict(signals_common=len(common), variants=len(names), rc_vs_zero=st.reality_check(D),
                       rc_vs_TP1=st.reality_check(D - bm[:, None]),
                       best_in_support=names[int(np.argmax(D.mean(axis=0)))],
                       best_mean=round(float(D.mean(axis=0).max()), 4), benchmark_mean=round(float(bm.mean()), 4))
    json.dump(out, open(os.path.join(c.OUT, 'rc_tp4_support.json'), 'w'), indent=1, default=str)
    print(json.dumps(out, indent=1, default=str))


if __name__ == '__main__':
    main()
