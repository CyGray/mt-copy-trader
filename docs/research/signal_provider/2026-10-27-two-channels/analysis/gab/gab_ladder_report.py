"""Aggregates for gab_ladder.py (no per-trade rows leave the scratch folder). Read-only research.
Trade P&L in USD for N x 0.01 lot: fixed legs 1..N-1 + runner(D, act); act = 1 ('be') or max(1, N-1) ('last')."""
import json, sys, random, statistics as st, datetime as dt, collections
STUDY = "/tmp/claude-1001/twochan/gab/study"
OUT = sys.argv[1] if len(sys.argv) > 1 else None
TRAILS = ('30', '50', '75', '100', '150', '200', '250', '300', '400', '500', '700', '1000', 'None')
WIDEN = ('0', '80', '130')
COSTS = (0.0, 0.40)                                # extra USD per 0.01-lot leg: tick replay is 0.2-0.5 worse per leg than M1 (stop slippage)
R = json.load(open(f"{STUDY}/ladder_m1.json"))


def month(r): return dt.datetime.utcfromtimestamp(r['date']).strftime('%Y-%m')


def trade(sim, W, N, D, actmode, order, cost):
    legs = sim['orders'][order][W]
    act = 1 if actmode == 'be' else max(1, N - 1)
    pnl = sum(legs['fixed'][str(k)][0] for k in range(1, N)) + legs['runner'][f"{D}_{act}"][0]
    return pnl - cost * N


def stats(pnls, seed=7):
    n = len(pnls)
    if n == 0: return dict(n=0)
    wins = sum(p for p in pnls if p > 0); losses = -sum(p for p in pnls if p < 0)
    eq = 0; peak = 0; mdd = 0
    for p in pnls:
        eq += p; peak = max(peak, eq); mdd = max(mdd, peak - eq)
    rnd = random.Random(seed); means = sorted(st.fmean(rnd.choices(pnls, k=n)) for _ in range(2000))
    return dict(n=n, total=round(sum(pnls), 1), mean=round(st.fmean(pnls), 2),
                ci95=[round(means[50], 2), round(means[1949], 2)], pf=round(wins / losses, 2) if losses else None,
                win=round(sum(p > 0 for p in pnls) / n, 3), be_or_better=round(sum(p >= -0.5 for p in pnls) / n, 3),
                max_dd=round(mdd, 1), worst=round(min(pnls), 1), best=round(max(pnls), 1))


def sel(phase=None, months=None, model='market'):
    xs = [r for r in R if r[model]['status'] == 'ok' and (phase is None or r['phase'].startswith(phase))
          and (months is None or month(r) in months)]
    return sorted(xs, key=lambda r: r[model]['t_entry'])


def table(xs, model='market', order='ohlc', cost=0.0):
    rows = {}
    for W in WIDEN:
        for N in range(1, 7):
            for D in TRAILS:
                for am in (('be',) if N <= 2 else ('be', 'last')):
                    rows[f"W{W}_N{N}_D{D}_{am}"] = stats([trade(r[model], W, N, D, am, order, cost) for r in xs])
    return rows


def best(rows, W, N):
    cands = {k: v for k, v in rows.items() if k.startswith(f"W{W}_N{N}_")}
    return max(cands.items(), key=lambda kv: kv[1]['mean'])


if __name__ == '__main__':
    C = sel('C'); ALL = sel(); B = sel('B'); A = sel('A')
    EARLY = sel('C', {'2026-05', '2026-06', '2026-07'}); LATE = sel('C', {'2026-08', '2026-09', '2026-10'})
    agg = dict(meta=dict(pip_usd=0.10, rung_pips=100, horizon_h=120, latency_s=20, legs_lot=0.01,
                         usd_per_leg_per_usd_move=1.0, signals=len(R),
                         counts={k: len(v) for k, v in dict(C=C, ALL=ALL, A=A, B=B, C_may_jul=EARLY, C_aug_oct=LATE).items()},
                         truncated_at_data_end=sum(r['market'].get('truncated', False) for r in ALL),
                         median_risk_usd_per_leg_C={W: round(st.median(r['market']['risk'][W] for r in C), 2) for W in WIDEN}))
    agg['C_market_ohlc'] = table(C)
    agg['C_market_ohlc_cost040'] = table(C, cost=0.40)
    agg['C_market_adverse'] = table(C, order='adverse')
    agg['C_market_favorable'] = table(C, order='favorable')
    agg['C_level_ohlc'] = table(sel('C', model='level'), model='level')
    agg['ALL_market_ohlc'] = table(ALL)
    agg['B_market_ohlc'] = table(B)
    agg['A_market_ohlc'] = table(A)
    # out of sample: pick the trail (and activation) on May-Jul, score on Aug-Oct
    early = table(EARLY); late = table(LATE); oos = {}
    for W in WIDEN:
        for N in range(1, 7):
            k, v = best(early, W, N)
            oos[f"W{W}_N{N}"] = dict(chosen=k, in_sample=v, out_of_sample=late[k], best_late=best(late, W, N))
    agg['C_oos_trail_choice'] = oos
    # by month, chosen headline configs
    bym = collections.defaultdict(dict)
    for W in ('80', '130'):
        for N in range(1, 7):
            k, _ = best(agg['C_market_ohlc'], W, N); _, _, Dk, *am = k.split('_'); am = am[0] if am else 'be'
            for m in sorted({month(r) for r in C}):
                bym[k][m] = stats([trade(r['market'], W, N, Dk[1:], am, 'ohlc', 0) for r in C if month(r) == m])
    agg['C_by_month_best_trail'] = bym
    # leg outcome mix (W, N=6, act be, D best) for the explainer
    mix = {}
    for W in WIDEN:
        c = collections.Counter()
        for r in C:
            o = r['market']['orders']['ohlc'][W]
            c[o['fixed']['1'][2]] += 1
        mix[W] = dict(c)
    agg['C_first_rung_outcome'] = mix
    agg['C_reach_rung'] = {str(k): round(sum(r['market']['orders']['ohlc']['130']['fixed'][str(k)][2] == 'tp' for r in C) / len(C), 3)
                           for k in range(1, 6)}
    if OUT: json.dump(agg, open(OUT, 'w'), indent=1)
    for name in ('C_market_ohlc', 'C_market_ohlc_cost040', 'C_market_adverse', 'C_market_favorable', 'C_level_ohlc', 'ALL_market_ohlc'):
        print('==', name)
        for W in WIDEN:
            for N in range(1, 7):
                k, v = best(agg[name], W, N)
                nt = agg[name][f"W{W}_N{N}_DNone_be"]
                print(f"  W{W:>3} N{N} best {k.split('_', 2)[2]:<12} mean {v['mean']:7.2f} ci {v['ci95']} pf {v['pf']} win {v['win']} "
                      f"dd {v['max_dd']} worst {v['worst']} | no-trail mean {nt['mean']}")
    curve = {}
    for W in WIDEN:
        for am in ('be', 'last'):
            for N in (1, 2, 3, 4, 5, 6):
                if am == 'last' and N <= 2: continue
                curve[f"W{W}_N{N}_{am}"] = {D: agg['C_market_ohlc'][f"W{W}_N{N}_D{D}_{am}"]['mean'] for D in TRAILS}
    agg['C_trail_curve_mean_usd'] = curve
    if OUT: json.dump(agg, open(OUT, 'w'), indent=1)
    print('== trail curve, C market ohlc, mean USD per trade')
    print('  ' + ' '.join(f"{D:>6}" for D in TRAILS))
    for k, v in curve.items(): print(f"  {k:<14}" + ' '.join(f"{x:6.2f}" for x in v.values()))
    for ph in ('A', 'B'):
        for W in ('80', '130'):
            k, v = best(agg[f'{ph}_market_ohlc'], W, 1); print('  phase', ph, k, v['mean'], v['ci95'], 'n', v['n'])
    print('meta', agg['meta']); print('rung reach (W130)', agg['C_reach_rung']); print('first rung', mix)
    print('== OOS (choose May-Jul, test Aug-Oct)')
    for k, v in oos.items(): print(' ', k, v['chosen'], 'IS', v['in_sample']['mean'], 'OOS', v['out_of_sample']['mean'], v['out_of_sample']['ci95'], 'n', v['out_of_sample']['n'])
