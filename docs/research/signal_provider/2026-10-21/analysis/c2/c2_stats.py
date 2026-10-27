"""C2 statistics on the c2_trades_<set>.csv / c2_entries_<set>.csv outputs.
Bootstrap: 10,000 resamples, seed 42 (numpy default_rng(42)). Drawdown in R units, equity starts at 0."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, collections
import numpy as np
from c2_run import OUT, STRATS

NB = 10000


def mdd(x):
    eq = np.concatenate([[0.0], np.cumsum(x)])
    peak = np.maximum.accumulate(eq)
    return float((peak - eq).max()) if len(x) else 0.0


def boot_ci(x, rng, stat=np.mean, nb=NB, cluster=None):
    x = np.asarray(x, float)
    n = len(x)
    if cluster is None:
        idx = rng.integers(0, n, size=(nb, n))
        stats = stat(x[idx], axis=1)
    else:
        groups = collections.defaultdict(list)
        for v, g in zip(x, cluster):
            groups[g].append(v)
        keys = list(groups)
        G = len(keys)
        stats = np.empty(nb)
        sums = np.array([np.sum(groups[k]) for k in keys])
        cnts = np.array([len(groups[k]) for k in keys])
        pick = rng.integers(0, G, size=(nb, G))
        stats = sums[pick].sum(axis=1) / cnts[pick].sum(axis=1)
    lo, hi = np.percentile(stats, [2.5, 97.5])
    return float(lo), float(hi), float(np.mean(stats))


def summarize(rows_R, rows_day, rows_tp1first, seed=42):
    x = np.asarray(rows_R, float)
    n = len(x)
    if n == 0:
        return dict(n=0)
    rng = np.random.default_rng(seed)
    order = np.argsort(np.arange(n))
    s = np.sort(x)[::-1]
    trim = int(np.floor(0.05 * n))
    trimmed = np.sort(x)[trim:n - trim].mean() if n - 2 * trim > 0 else float('nan')
    lo, hi, _ = boot_ci(x, rng)
    dlo, dhi, _ = boot_ci(x, rng, cluster=rows_day)
    # p95 of max drawdown: (a) random permutations of realised order, (b) iid bootstrap resamples
    perm = np.array([mdd(rng.permutation(x)) for _ in range(2000)])
    bootdd = np.array([mdd(x[rng.integers(0, n, n)]) for _ in range(2000)])
    tot = x.sum()
    return dict(n=n, mean=float(x.mean()), median=float(np.median(x)), sd=float(x.std(ddof=1)) if n > 1 else float('nan'),
                win_rate=float((x > 0).mean()), total_R=float(tot), mdd_realised=mdd(x),
                mdd_perm_p95=float(np.percentile(perm, 95)), mdd_boot_p95=float(np.percentile(bootdd, 95)),
                ci95=[lo, hi], ci95_day_cluster=[dlo, dhi], trimmed_mean_5pct=float(trimmed),
                top1_share=float(s[:1].sum() / tot) if tot else float('nan'),
                top3_sum=float(s[:3].sum()), top5_sum=float(s[:5].sum()),
                mean_drop_top5=float(np.sort(x)[:n - 5].mean()) if n > 5 else float('nan'),
                mean_drop_top5_winners=float(np.delete(x, np.argsort(x)[-5:]).mean()) if n > 5 else float('nan'),
                tp1_first_rate=float(np.mean(rows_tp1first)) if rows_tp1first else float('nan'))


def load(fn):
    return list(csv.DictReader(open(fn)))


def main(vset):
    trades = load(os.path.join(OUT, f'c2_trades_{vset}.csv'))
    entries = load(os.path.join(OUT, f'c2_entries_{vset}.csv'))
    res = {'entries': {}, 'trades': {}}
    # entry counts
    for r in entries:
        key = (r['variant'], r['split'])
        res['entries'].setdefault(r['variant'], {}).setdefault(r['split'], collections.Counter())[r['status']] += 1
        if r['status'] == 'FILLED':
            res['entries'][r['variant']][r['split']][r['kind']] += 1
    for k in list(res['entries']):
        for sp in list(res['entries'][k]):
            res['entries'][k][sp] = dict(res['entries'][k][sp])
    # trades
    by = collections.defaultdict(list)
    for r in trades:
        by[(r['variant'], r['strat'], r['split'])].append(r)
    variants = sorted({r['variant'] for r in trades})
    for v in variants:
        res['trades'][v] = {}
        for strat in STRATS:
            res['trades'][v][strat] = {}
            for sp in ('TRAIN', 'VALID', 'OOS', 'ALL406'):
                if sp == 'ALL406':
                    rows = [r for r in trades if r['variant'] == v and r['strat'] == strat and r['split'] != 'NONCLEAN']
                else:
                    rows = by.get((v, strat, sp), [])
                ok = [r for r in rows if r['status'] == 'OK']
                nt = sum(1 for r in rows if r['status'] == 'NO_TP')
                ok.sort(key=lambda r: (int(r['t_fill']), int(r['msg'])))
                R = [float(r['R']) for r in ok]
                days = [r['t_fill'] and str(int(r['t_fill']) // 86400000) for r in ok]
                tp1 = []
                if strat == 'S_TP1|M0':
                    tp1 = [1 if json.loads(r['legs'])[0][0] == 'TP1' else 0 for r in ok]
                summ = summarize(R, days, tp1) if R else dict(n=0)
                summ['no_tp'] = nt
                summ['unresolved'] = sum(int(r['unresolved']) for r in ok)
                res['trades'][v][strat][sp] = summ
    json.dump(res, open(os.path.join(OUT, f'c2_stats_{vset}.json'), 'w'), indent=1)
    print('wrote stats', vset)


if __name__ == '__main__':
    main(sys.argv[1])
