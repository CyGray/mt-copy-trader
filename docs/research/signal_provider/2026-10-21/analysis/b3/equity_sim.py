#!/usr/bin/env python3
"""Task 4: equity-path simulation, block and iid bootstrap, daily-loss breach and streak sensitivity.
Inputs: work/trades.json (B1 BASE/PESS fills, lot-exact legs from B1 exits). Sizing distance = nominal
signal distance; realised P&L from B1 legs (+ adverse fill, + commission if requested). Closed equity only.
Outputs: tables/T4a_path_sim.csv, T4b_bootstrap.csv, T4c_daily_breach.csv, T4d_full_loss_streaks.csv,
T4e_cost_sensitivity.csv, T4f_losing_streaks.csv; work/equity_summary.json.
Run (background, ~5-10 min): nice -n 10 python3 -I equity_sim.py [quick]"""
import csv, json, math, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import risk_model as rm
EPS = 1e-9
OUT = os.path.join(HERE, 'tables'); os.makedirs(OUT, exist_ok=True)
SPEC = rm.SPEC_UNVERIFIED
EQS = [500, 1000, 5000, 10000, 50000]
POLS = [('pct', v) for v in (0.25, 0.5, 1, 2)] + [('money', v) for v in (2, 5, 10, 25, 50, 100)] + \
       [('lots', v) for v in (0.01, 0.02, 0.03, 0.05, 0.10, 0.20)]
SAFE = {'DEFAULT': rm.DEFAULT_SAFETY, 'HARD': rm.HARD_SAFETY}
GRID_N = 2000  # lots 0.01..20.00

TR = json.load(open(os.path.join(HERE, 'work', 'trades.json')))
def trades(scen, strat):
    t = [x for x in TR if x['scen'] == scen and x['strategy'] == strat]
    return sorted(t, key=lambda x: x['fill_ms'])

def pnl_table(tr_list, infeasible='merge_into_next'):
    """Per trade: list over lot grid of pnl (USD, no adverse/commission) or None if split infeasible."""
    tabs = []
    contract = SPEC['tickValueLoss'] / SPEC['tickSize']
    for t in tr_list:
        pcts = [l['fraction'] * 100 for l in t['legs']]
        moves = [l['move'] for l in t['legs']]
        row = [None] * GRID_N
        for k in range(GRID_N):
            L = round((k + 1) * 0.01, 2)
            status, legs = rm.plan_volume_split(L, pcts, SPEC, infeasible)
            if status == 'skipped':
                continue
            pnl = sum(vol * moves[idx - 1] for idx, vol in legs) * contract
            row[k] = pnl
        tabs.append(row)
    return tabs

def fast_L(kind, val, E, sd, lim):
    """Sizing-only fast path (below_min 'skip'); equals rm.compute_volume_at_distance (self-test below)."""
    per_lot = sd / SPEC['tickSize'] * SPEC['tickValueLoss']
    cap = min(lim['maxRiskMoney'], (E * lim['maxRiskPercent']) / 100)
    maxv = min(SPEC['volumeMax'], lim['maxLots'])
    if kind == 'lots':
        if val > maxv + EPS or val * per_lot > cap + EPS:
            return None
        return val
    target = (E * val) / 100 if kind == 'pct' else val
    vol = math.floor(min(target, cap) / per_lot / SPEC['volumeStep'] + EPS) * SPEC['volumeStep']
    vol = round(vol, 2)
    if vol > maxv + EPS:
        vol = round(math.floor(maxv / SPEC['volumeStep'] + EPS) * SPEC['volumeStep'], 2)
    if vol + EPS < SPEC['volumeMin']:
        return None
    return vol

def selftest_fast_L(n=3000, seed=7):
    rng = random.Random(seed)
    for _ in range(n):
        kind, val = rng.choice(POLS)
        E = rng.choice([300, 500, 1000, 2500, 5000, 10000, 50000])
        sd = rng.choice([2.0, 3.0, 5.0, 7.5, 8.5, 12.0, 0.7])
        lim = rm.effective_limits(rng.choice([rm.DEFAULT_SAFETY, rm.HARD_SAFETY]))
        a = fast_L(kind, val, E, sd, lim)
        r = rm.compute_volume_at_distance(rm.sizing_policy(kind, val, 'skip'), sd, E, SPEC, lim)
        b = r['volume'] if r['ok'] else None
        if (a is None) != (b is None) or (a is not None and abs(a - b) > 1e-9):
            raise AssertionError((kind, val, E, sd, a, b))
    return n

def path_summary(tr_list, pol, E0, safety, gates=True, adverse=0.0, comm=0.0, infeasible='merge_into_next', per_symbol=None):
    cfg = rm.make_cfg(safety, adverse=adverse, commission_rt=comm, infeasible_split=infeasible)
    if per_symbol is not None:
        cfg['limits']['maxPerSymbol'] = per_symbol
    trs = [{'id': t['message_id'], 'open_ms': t['fill_ms'], 'close_ms': t['close_ms'], 'sd': t['sl_dist_nominal'],
            'entry_px': t['fill_px'], 'legs': [(l['fraction'] * 100, l['move']) for l in t['legs']]} for t in tr_list]
    sizing = rm.sizing_policy(pol[0], pol[1], 'skip')
    out = rm.run_path(trs, sizing, E0, cfg, gates=gates)
    mdd_pct, mdd_usd = rm.max_drawdown(out['curve'])
    taken = out['taken']
    losses = [t for t in taken if t['pnl'] < 0]
    # daily realised loss per UTC day from the closed curve
    day = {}
    for t in taken:
        d = t['close_ms'] // 86400000
        day[d] = day.get(d, 0.0) + t['pnl']
    lim_daily = cfg['limits']['dailyLossLimit']
    breach_days = sum(1 for v in day.values() if -v >= lim_daily)
    min_eq = min(e for _, e in out['curve'])
    return {'taken': len(taken), 'skipped': sum(out['skips'].values()), 'skip_reasons': json.dumps(out['skips'], sort_keys=True),
            'final_equity': round(out['final_equity'], 2), 'return_pct': round(100 * (out['final_equity'] / E0 - 1), 2),
            'max_dd_closed_pct': round(mdd_pct, 2), 'max_dd_closed_usd': round(mdd_usd, 2),
            'min_closed_equity': round(min_eq, 2),
            'median_planned_risk_pct': round(sorted(t['risk_pct_planned'] for t in taken)[len(taken) // 2], 3) if taken else '',
            'daily_loss_limit_usd': lim_daily, 'days_with_daily_limit_breach': breach_days,
            'win_loss_taken': f"{sum(1 for t in taken if t['pnl'] > 0)}/{len(losses)}", 'ruin_50pct': min_eq <= 0.5 * E0,
            'bust_le_0': min_eq <= 0}

def write_csv(path, rows):
    with open(path, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

def pctl(xs, q):
    v = sorted(xs); p = (len(v) - 1) * q; lo = int(p); hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (p - lo)

def run_bootstrap(pool_tabs, pool_sd, idx_list, kind, val, E0, lim, adverse=0.0, comm=0.0):
    E = E0; peak = E0; mdd = 0.0; mn = E0; streak = 0; maxstreak = 0; taken = 0; wins = 0
    for i in idx_list:
        L = fast_L(kind, val, E, pool_sd[i], lim)
        if L is None:
            continue
        pnl = pool_tabs[i][int(round(L * 100)) - 1]
        if pnl is None:
            continue
        pnl = pnl - adverse * 100 * L - comm * L
        E += pnl; taken += 1
        if pnl < 0:
            streak += 1; maxstreak = max(maxstreak, streak)
        else:
            streak = 0; wins += 1
        if E > peak: peak = E
        if peak > 0:
            mdd = max(mdd, (peak - E) / peak)
        mn = min(mn, E)
    return {'mdd_pct': 100 * mdd, 'ret_pct': 100 * (E / E0 - 1), 'maxstreak': maxstreak, 'taken': taken,
            'ruin50': mn <= 0.5 * E0, 'bust': mn <= 0}

def make_indices(n, reps, seed, kind, block=5):
    rng = random.Random(seed)
    out = []
    for _ in range(reps):
        if kind == 'iid':
            out.append([rng.randrange(n) for _ in range(n)])
        else:
            seq = []
            while len(seq) < n:
                s = rng.randrange(0, n - block + 1)
                seq.extend(range(s, s + block))
            out.append(seq[:n])
    return out

def daily_breach(pool_pnl_static, day_sizes, reps, seed, limit):
    """Day-slot bootstrap: each observed UTC day with n_d fills draws n_d trades iid (static pnl at E0).
    Gate: once cumulative realised day loss reaches the limit, no further entries that day."""
    rng = random.Random(seed)
    n_slots = len(day_sizes); hits_per_rep = 0; slot_hits = 0
    any_hit = 0
    for _ in range(reps):
        any_day = False
        for nd in day_sizes:
            cum = 0.0; hit = False
            for _k in range(nd):
                if hit:
                    break
                p = pool_pnl_static[rng.randrange(len(pool_pnl_static))]
                if p is None:
                    continue
                cum += p
                if -cum >= limit:
                    hit = True
            if hit:
                slot_hits += 1; any_day = True
        any_hit += 1 if any_day else 0
    return slot_hits / (reps * n_slots), any_hit / reps

def main(quick=False):
    reps = 200 if quick else 10000
    n_self = selftest_fast_L()
    summ = {'fast_L_selftest_cases': n_self, 'reps': reps, 'seed': 42}
    base_eq3 = trades('BASE', 'EQ3'); base_tp1 = trades('BASE', 'TP1_100')
    pess_eq3 = trades('PESS', 'EQ3'); pess_tp1 = trades('PESS', 'TP1_100')
    summ['n_base_fills'] = len(base_eq3); summ['n_pess_fills'] = len(pess_eq3)

    # T4a deterministic path grid (BASE, gates on) + T4e cost sensitivity
    rows_a = []
    for sname, safety in SAFE.items():
        for strat, tr in (('EQ3', base_eq3), ('TP1_100', base_tp1)):
            for E0 in EQS:
                for kind, val in POLS:
                    s = path_summary(tr, (kind, val), E0, safety, gates=True)
                    rows_a.append(dict(safety=sname, strategy=strat, scen='BASE', equity0=E0, policy=f'{kind}_{val}',
                                       gates='on', adverse_usd=0, commission_rt_per_lot=0, **s))
    write_csv(os.path.join(OUT, 'T4a_path_sim.csv'), rows_a)
    rows_e = []
    variants = [('BASE', 0.0, 0.0, base_eq3, 'BASE'), ('BASE+adverse1', 1.0, 0.0, base_eq3, 'BASE'),
                ('BASE+adverse2', 2.0, 0.0, base_eq3, 'BASE'), ('BASE+comm3.5/side', 0.0, 7.0, base_eq3, 'BASE'),
                ('PESS(B1 spread/slip/lat15)', 0.0, 0.0, pess_eq3, 'PESS'), ('PESS+comm3.5/side', 0.0, 7.0, pess_eq3, 'PESS')]
    for vname, adv, comm, tr, _ in variants:
        for E0 in EQS:
            for pol in [('pct', 0.5), ('pct', 1), ('money', 25), ('lots', 0.05), ('lots', 0.10)]:
                s = path_summary(tr, pol, E0, rm.DEFAULT_SAFETY, gates=True, adverse=adv, comm=comm)
                rows_e.append(dict(variant=vname, equity0=E0, policy=f'{pol[0]}_{pol[1]}', safety='DEFAULT', strategy='EQ3', **s))
    write_csv(os.path.join(OUT, 'T4e_cost_sensitivity.csv'), rows_e)

    # Bootstrap tables (BASE, EQ3 and TP1_100). Pools: lot-exact pnl tables on the 0.01 grid.
    t_eq3 = pnl_table(base_eq3); t_tp1 = pnl_table(base_tp1)
    sd_eq3 = [t['sl_dist_nominal'] for t in base_eq3]; sd_tp1 = [t['sl_dist_nominal'] for t in base_tp1]
    idx = {'iid': make_indices(len(base_eq3), reps, 42, 'iid'), 'block5': make_indices(len(base_eq3), reps, 42, 'block', 5)}
    rows_b = []; rows_c_stream = []
    for strat, tab, sd in (('EQ3', t_eq3, sd_eq3), ('TP1_100', t_tp1, sd_tp1)):
        for sname, safety in SAFE.items():
            lim = rm.effective_limits(safety)
            for typ in ('iid', 'block5'):
                for E0 in EQS:
                    for kind, val in POLS:
                        res = [run_bootstrap(tab, sd, seq, kind, val, E0, lim) for seq in idx[typ]]
                        mdd = [r['mdd_pct'] for r in res]; ret = [r['ret_pct'] for r in res]
                        ms = [r['maxstreak'] for r in res]
                        rows_b.append({
                            'strategy': strat, 'safety': sname, 'resample': typ, 'reps': reps, 'equity0': E0,
                            'policy': f'{kind}_{val}', 'taken_mean': round(sum(r['taken'] for r in res) / reps, 1),
                            'maxdd_p50_pct': round(pctl(mdd, 0.5), 2), 'maxdd_p95_pct': round(pctl(mdd, 0.95), 2),
                            'maxdd_p99_pct': round(pctl(mdd, 0.99), 2),
                            'P_dd_ge_10pct': round(sum(m >= 10 for m in mdd) / reps, 4),
                            'P_dd_ge_20pct': round(sum(m >= 20 for m in mdd) / reps, 4),
                            'P_dd_ge_30pct': round(sum(m >= 30 for m in mdd) / reps, 4),
                            'P_ruin_equity_le_50pct': round(sum(r['ruin50'] for r in res) / reps, 4),
                            'P_bust_equity_le_0': round(sum(r['bust'] for r in res) / reps, 4),
                            'return_p50_pct': round(pctl(ret, 0.5), 2),
                            'losing_streak_p50': pctl(ms, 0.5), 'losing_streak_p95': pctl(ms, 0.95),
                            'losing_streak_p99': pctl(ms, 0.99)})
                        if kind == 'pct' and val == 1 and sname == 'DEFAULT':
                            rows_c_stream.append({'strategy': strat, 'resample': typ, 'losing_streak_p50': pctl(ms, 0.5),
                                                  'losing_streak_p95': pctl(ms, 0.95), 'losing_streak_p99': pctl(ms, 0.99),
                                                  'losing_streak_max': max(ms), 'reps': reps})
    write_csv(os.path.join(OUT, 'T4b_bootstrap.csv'), rows_b)
    write_csv(os.path.join(OUT, 'T4f_losing_streaks.csv'), rows_c_stream)

    # Day-slot bootstrap: daily realised-loss gate triggers (static pnl at E0, DEFAULT caps)
    by_day = {}
    for t in base_eq3:
        by_day.setdefault(t['fill_ms'] // 86400000, []).append(t)
    day_sizes = [len(v) for v in by_day.values()]
    rows_d = []
    lim_def = rm.effective_limits(rm.DEFAULT_SAFETY)
    for E0 in EQS:
        for kind, val in [('pct', 0.25), ('pct', 0.5), ('pct', 1), ('pct', 2), ('money', 10), ('money', 25), ('money', 50), ('lots', 0.05), ('lots', 0.10)]:
            static = []
            for i, t in enumerate(base_eq3):
                L = fast_L(kind, val, E0, sd_eq3[i], lim_def)
                static.append(None if L is None else t_eq3[i][int(round(L * 100)) - 1])
            for label, lim_val in (('100 USD', 100.0), ('1% of E0', 0.01 * E0), ('2% of E0', 0.02 * E0), ('3% of E0', 0.03 * E0)):
                slot_p, any_p = daily_breach(static, day_sizes, reps if not quick else 200, 42, lim_val)
                rows_d.append({'equity0': E0, 'policy': f'{kind}_{val}', 'daily_limit': label, 'daily_limit_usd': round(lim_val, 2),
                               'P_gate_triggers_per_day_slot': round(slot_p, 4),
                               'P_gate_triggers_any_day_in_sample_days': round(any_p, 4),
                               'n_day_slots': len(day_sizes), 'reps': reps if not quick else 200})
    write_csv(os.path.join(OUT, 'T4c_daily_breach.csv'), rows_d)

    # Full-loss streaks: N consecutive SL hits, sized on nominal median distance, realised at median + adverse
    rows_s = []
    sig_sd = [s['sl_dist'] for s in json.load(open(os.path.join(HERE, 'work', 'signals_clean.json')))]
    for dname, d_nom in (('median_406', pctl(sig_sd, 0.5)), ('p90_406', pctl(sig_sd, 0.9))):
     for sname, safety in SAFE.items():
        lim = rm.effective_limits(safety)
        for E0 in EQS:
            for kind, val in POLS:
                for adv in (0.0, 2.0):
                    row = {'safety': sname, 'equity0': E0, 'policy': f'{kind}_{val}', 'adverse_usd': adv,
                           'sizing_distance_name': dname, 'sizing_distance_usd': d_nom}
                    E = E0
                    for N in range(1, 11):
                        L = fast_L(kind, val, E, d_nom, lim)
                        if L is not None:
                            E = E - L * (d_nom + adv) * 100
                        if N in (3, 5, 8, 10):
                            row[f'loss_pct_after_{N}_full_losses'] = round(100 * (1 - E / E0), 2)
                            row[f'equity_after_{N}_usd'] = round(E, 2)
                    rows_s.append(row)
    write_csv(os.path.join(OUT, 'T4d_full_loss_streaks.csv'), rows_s)

    # Deterministic gate variants (per-symbol 1 vs 3) for the policies that matter, HARD and DEFAULT
    rows_g = []
    for sname, safety in SAFE.items():
        for E0 in EQS:
            for pol in [('pct', 0.5), ('pct', 1), ('money', 25), ('lots', 0.05)]:
                for ps in (1, 3):
                    s = path_summary(base_eq3, pol, E0, safety, gates=True, per_symbol=ps)
                    rows_g.append(dict(safety=sname, equity0=E0, policy=f'{pol[0]}_{pol[1]}', per_symbol=ps, strategy='EQ3', **s))
    write_csv(os.path.join(OUT, 'T4g_per_symbol_gate.csv'), rows_g)
    summ['daily_day_slots'] = len(day_sizes)
    json.dump(summ, open(os.path.join(HERE, 'work', 'equity_summary.json'), 'w'), indent=1)
    print(json.dumps(summ))

if __name__ == '__main__':
    main(quick=('quick' in sys.argv))
