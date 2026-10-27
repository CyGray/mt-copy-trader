"""C2 analysis of c2_trades_*.csv / c2_entries_*.csv. Bootstrap: NB=10000, seed 42. Written independently of B1/B2/B3."""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, collections, math
import numpy as np
from c2_run import OUT, SCR, load_signals

NB = 10000
SEED = 42
STRATS = ['S_TP1|M0', 'S_TP3|M0', 'S_TP4|M0', 'S_TP4|M5', 'Q_25x4|M0', 'Q_25x4|M3', 'S_TP4FB|M0', 'S_TP4FB|M5']
sigs = {s['msg']: s for s in load_signals()}


def mdd(x):
    eq = np.concatenate([[0.0], np.cumsum(x)])
    return float((np.maximum.accumulate(eq) - eq).max()) if len(x) else 0.0


def ci_iid(x, rng):
    n = len(x)
    idx = rng.integers(0, n, size=(NB, n))
    m = x[idx].mean(axis=1)
    return [float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))], m


def ci_day(x, days, rng):
    days = np.asarray(days)
    ud = np.unique(days)
    sums = np.array([x[days == d].sum() for d in ud])
    cnts = np.array([(days == d).sum() for d in ud])
    G = len(ud)
    pick = rng.integers(0, G, size=(NB, G))
    m = sums[pick].sum(axis=1) / cnts[pick].sum(axis=1)
    return [float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))], float((m <= 0).mean())


def p_mean_le0(m_boot):
    return float((m_boot <= 0).mean())


def block_fill(rows):
    pass


def load(fn):
    return list(csv.DictReader(open(fn)))


def summarize(x, days, legs_first_tp1=None):
    x = np.asarray(x, float)
    n = len(x)
    rng = np.random.default_rng(SEED)
    ci, mb = ci_iid(x, rng)
    cid, _ = ci_day(x, days, np.random.default_rng(SEED))
    srt = np.sort(x)[::-1]
    tot = float(x.sum())
    trim = int(math.floor(0.05 * n))
    srt_asc = np.sort(x)
    perm = np.array([mdd(np.random.default_rng(SEED + i).permutation(x)) for i in range(1000)])
    boot = np.array([mdd(x[np.random.default_rng(SEED + 10 + i).integers(0, n, n)]) for i in range(1000)])
    out = dict(n=n, mean=float(x.mean()), median=float(np.median(x)), sd=float(x.std(ddof=1)), win=float((x > 0).mean()),
               total=tot, ci95_iid=ci, ci95_daycluster=cid, p_mean_le0_boot=p_mean_le0(mb),
               mdd_realised=mdd(x), mdd_perm_p95=float(np.percentile(perm, 95)), mdd_boot_p95=float(np.percentile(boot, 95)),
               top1=float(srt[:1].sum()), top3=float(srt[:3].sum()), top5=float(srt[:5].sum()),
               top1_share_of_total=float(srt[:1].sum() / tot) if tot else float('nan'),
               mean_drop_top1=float(srt_asc[:n - 1].mean()) if n > 1 else float('nan'),
               mean_drop_top3=float(srt_asc[:n - 3].mean()) if n > 3 else float('nan'),
               mean_drop_top5=float(srt_asc[:n - 5].mean()) if n > 5 else float('nan'),
               trimmed_mean_5pct=float(srt_asc[trim:n - trim].mean()) if n - 2 * trim > 0 else float('nan'))
    if legs_first_tp1 is not None:
        out['tp1_before_sl_rate'] = float(np.mean(legs_first_tp1))
    return out


def collect(trades, variant, strat, split):
    rows = [r for r in trades if r['variant'] == variant and r['strat'] == strat and r['status'] == 'OK'
            and (split == 'ALL' and r['split'] in ('TRAIN', 'VALID', 'OOS') or r['split'] == split)]
    rows.sort(key=lambda r: (int(r['t_fill']), int(r['msg'])))
    R = [float(r['R']) for r in rows]
    days = [int(sigs[r['msg']]['t']) // 86400000 for r in rows]
    tp1 = [1 if json.loads(r['legs'])[0][0] == 'TP1' else 0 for r in rows] if strat == 'S_TP1|M0' else None
    return rows, R, days, tp1


def main():
    trades = load(os.path.join(OUT, 'c2_trades_core.csv')) + load(os.path.join(OUT, 'c2_trades_sens.csv'))
    entries = load(os.path.join(OUT, 'c2_entries_core.csv')) + load(os.path.join(OUT, 'c2_entries_sens.csv'))
    res = dict(stats={}, entries={})
    variants = []
    for r in trades:
        if r['variant'] not in variants:
            variants.append(r['variant'])
    for v in variants:
        res['stats'][v] = {}
        for st in STRATS:
            res['stats'][v][st] = {}
            for sp in ('TRAIN', 'VALID', 'OOS', 'ALL'):
                rows, R, days, tp1 = collect(trades, v, st, sp)
                if not R:
                    res['stats'][v][st][sp] = dict(n=0)
                    continue
                res['stats'][v][st][sp] = summarize(R, days, tp1)
                res['stats'][v][st][sp]['fills_no_tp'] = sum(1 for r in trades if r['variant'] == v and r['strat'] == st and r['status'] == 'NO_TP' and (sp == 'ALL' or r['split'] == sp))
                res['stats'][v][st][sp]['unresolved'] = sum(int(r['unresolved']) for r in rows)
    # entry counts per variant and split (clean splits only, plus NONCLEAN)
    for r in entries:
        d = res['entries'].setdefault(r['variant'], {}).setdefault(r['split'], collections.Counter())
        d[r['status'] + ('|' + r['kind'] if r['status'] == 'FILLED' else '')] += 1
    for v in res['entries']:
        for sp in res['entries'][v]:
            res['entries'][v][sp] = dict(res['entries'][v][sp])
    json.dump(res, open(os.path.join(OUT, 'c2_analysis.json'), 'w'), indent=1)
    print('wrote c2_analysis.json; variants', len(variants))


if __name__ == '__main__':
    main()
