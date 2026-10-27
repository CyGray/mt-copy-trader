"""B2 statistics: per-group metrics from trade rows, bootstraps (seed 42), block-bootstrap drawdown/streak,
paired differences, White's Reality Check. All R values are total_R from the engine (R = |fill - SL|)."""
import math
import sys

try:
    import numpy as np
except ImportError:  # python3 -I hides the user site where numpy lives on this host
    sys.path.append("/home/kyle/.local/lib/python3.12/site-packages")
    import numpy as np

SEED = 42
NBOOT = 10_000
BLOCK = 5
BE_BAND = 0.10


def _f(x):
    return float(x) if x not in ('', None) else None


def dd_and_streak(R_seq, usd_seq):
    """Closed-equity max drawdown (R, USD) and longest loss streak (R <= -0.10) for one ordered sequence."""
    cum = np.cumsum(R_seq)
    peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    dd_R = float(np.max(peak - cum)) if len(cum) else 0.0
    cu = np.cumsum(usd_seq)
    pu = np.maximum.accumulate(np.concatenate([[0.0], cu]))[1:]
    dd_u = float(np.max(pu - cu)) if len(cu) else 0.0
    run = best = 0
    for x in R_seq:
        run = run + 1 if x <= -BE_BAND else 0
        best = max(best, run)
    return dd_R, dd_u, best


def boot_ci_mean(R, nboot=NBOOT, seed=SEED):
    n = len(R)
    if n < 2:
        return (None, None)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, n, size=(nboot, n))
    means = R[idx].mean(axis=1)
    return (float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5)))


def seq_boot(R, usd, block, nboot=NBOOT, seed=SEED):
    """Resample the closed-equity sequence in blocks (block=1 -> iid). Returns p95/p99 of max DD (R), DD (USD),
    longest loss streak."""
    n = len(R)
    if n < 2:
        return None
    if n < block:          # too few trades for blocks of this length: fall back to iid (only affects tiny horizon cells)
        block = 1
    rng = np.random.default_rng(seed + block)
    nb = int(math.ceil(n / block))
    if block == 1:
        idx = rng.integers(0, n, size=(nboot, n))
    else:
        starts = rng.integers(0, n - block + 1, size=(nboot, nb))
        idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(nboot, nb * block)[:, :n]
    Rb = R[idx]
    Ub = usd[idx]
    cum = np.cumsum(Rb, axis=1)
    peak = np.maximum.accumulate(np.concatenate([np.zeros((nboot, 1)), cum], axis=1), axis=1)[:, 1:]
    dd = (peak - cum).max(axis=1)
    cu = np.cumsum(Ub, axis=1)
    pu = np.maximum.accumulate(np.concatenate([np.zeros((nboot, 1)), cu], axis=1), axis=1)[:, 1:]
    ddu = (pu - cu).max(axis=1)
    L = Rb <= -BE_BAND
    run = np.zeros(nboot, dtype=int)
    best = np.zeros(nboot, dtype=int)
    for j in range(n):
        run = np.where(L[:, j], run + 1, 0)
        best = np.maximum(best, run)
    return dict(dd_R_p50=float(np.percentile(dd, 50)), dd_R_p95=float(np.percentile(dd, 95)),
                dd_R_p99=float(np.percentile(dd, 99)), dd_usd_p95=float(np.percentile(ddu, 95)),
                dd_usd_p99=float(np.percentile(ddu, 99)), streak_p50=float(np.percentile(best, 50)),
                streak_p95=float(np.percentile(best, 95)), streak_p99=float(np.percentile(best, 99)))


def metrics(rows):
    """rows: list of dicts (trade rows, strings allowed) for ONE group (entry, cost, variant, split).
    Only trades with a defined total_R are used; undetermined/NO_PRICE_DATA are counted separately."""
    tr = [r for r in rows if r.get('total_R') not in ('', None)]
    n_def = len(tr)
    out = dict(n_rows=len(rows), n=n_def, n_horizon_close=sum(1 for r in tr if r.get('final_exit') == 'MTM'))
    if n_def == 0:
        return out
    tr.sort(key=lambda r: (int(r['fill_ms']), int(r['message_id'])))
    R = np.array([float(r['total_R']) for r in tr])
    U = np.array([float(r['usd_per_1lot']) for r in tr])
    ex_order = sorted(range(n_def), key=lambda i: (int(tr[i]['last_exit_ms'] or 0), int(tr[i]['message_id'])))
    Rc = R[ex_order]
    Uc = U[ex_order]
    win = int(np.sum(R >= BE_BAND))
    loss = int(np.sum(R <= -BE_BAND))
    be = n_def - win - loss
    lo, hi = boot_ci_mean(R)
    dd_R, dd_u, streak = dd_and_streak(Rc, Uc)
    pos = R[R > 0].sum()
    neg = -R[R < 0].sum()
    mae = np.array([float(r['mae_all_R']) for r in tr if r.get('mae_all_R') not in ('', None)])
    mfe = np.array([float(r['mfe_all_R']) for r in tr if r.get('mfe_all_R') not in ('', None)])
    tp_hits = {}
    for k in range(1, 8):
        tp_hits[k] = float(np.mean([str(k) in (r.get('tp_ks') or '').split('|') for r in tr]))
    srt = np.sort(R)[::-1]
    drop5 = float(R[np.argsort(-R, kind='stable')[5:]].mean()) if n_def > 5 else None
    out.update(
        win=win, loss=loss, be=be,
        win_rate_all=win / n_def, loss_rate=loss / n_def, be_rate=be / n_def,
        win_rate_exBE=(win / (win + loss)) if (win + loss) else None,
        mean_R=float(R.mean()), median_R=float(np.median(R)), sd_R=float(R.std(ddof=1)) if n_def > 1 else None,
        ci95_lo=lo, ci95_hi=hi, sum_R=float(R.sum()),
        pf=(float(pos / neg) if neg > 0 else None),
        mean_usd_per_1lot=float(U.mean()), sum_usd_per_1lot=float(U.sum()),
        mdd_R_closed=dd_R, mdd_usd_per_1lot_closed=dd_u, longest_loss_streak=streak,
        mae_R_median=float(np.median(mae)) if len(mae) else None,
        mae_R_p10=float(np.percentile(mae, 10)) if len(mae) else None,
        mfe_R_median=float(np.median(mfe)) if len(mfe) else None,
        drop_top5_mean_R=drop5, top5_sum_R=float(srt[:5].sum()),
    )
    for k in range(1, 8):
        out[f'tp{k}_hit_rate'] = tp_hits[k]
    sb = seq_boot(Rc, Uc, BLOCK)
    si = seq_boot(Rc, Uc, 1)
    if sb:
        out.update({f'blk5_{k}': v for k, v in sb.items()})
    if si:
        out.update({f'iid_{k}': v for k, v in si.items()})
    return out


def paired_diff(rA, rB, nboot=NBOOT, seed=SEED):
    """rA, rB: dict message_id -> R for the same fill set. Returns mean diff (A-B), CI, two-sided bootstrap p."""
    ids = sorted(set(rA) & set(rB))
    if len(ids) < 2:
        return dict(n_paired=len(ids))
    d = np.array([rA[i] - rB[i] for i in ids])
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(d), size=(nboot, len(d)))
    m = d[idx].mean(axis=1)
    p = 2 * min(np.mean(m <= 0), np.mean(m >= 0))
    return dict(n_paired=len(ids), mean_diff=float(d.mean()), ci95_lo=float(np.percentile(m, 2.5)),
                ci95_hi=float(np.percentile(m, 97.5)), p_two_sided=float(min(1.0, p)))


def reality_check(D, nboot=NBOOT, block=BLOCK, seed=SEED):
    """White (2000) Reality Check. D: (n_obs x V) matrix of per-signal differences vs the benchmark (no NaN).
    Returns observed max mean difference, p-value (circular block bootstrap of observations)."""
    n, V = D.shape
    mu = D.mean(axis=0)
    obs = float(mu.max())
    Dc = D - mu[None, :]
    rng = np.random.default_rng(seed)
    nb = int(math.ceil(n / block))
    starts = rng.integers(0, n, size=(nboot, nb))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]) % n
    idx = idx.reshape(nboot, nb * block)[:, :n]
    stats = np.empty(nboot)
    chunk = 500
    for a in range(0, nboot, chunk):
        b = min(nboot, a + chunk)
        bm = Dc[idx[a:b]].mean(axis=1)          # (chunk, V)
        stats[a:b] = bm.max(axis=1)
    p = float(np.mean(stats >= obs))
    return dict(n_obs=n, n_variants=V, max_mean_diff=obs, p_value=p)
