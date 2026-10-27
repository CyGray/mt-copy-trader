"""B2 core: signals, chronological splits, entry models E1/E2/E3, cost scenarios, strategy grid,
per-signal evaluation. Uses sim_engine_b2 (B1 engine + entry-side pending patch).

Protocol: TRAIN = first 60% of CLEAN signals by count, VALIDATION = next 20%, OOS = last 20%.
Non-clean (hard-flagged) signals are assigned to splits by time using the clean-split cut times
(used only for the ALL-universe sensitivity).
"""
import csv
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sim_engine_b2 as se  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'a3'))
import symbols as sy  # noqa: E402  per-symbol spec: price divisor, unit, contract, stop bounds

SCRATCH = os.path.dirname(HERE)
B1 = os.path.join(SCRATCH, 'b1')
RAW = os.path.join(SCRATCH, 'a3', 'raw')
CACHE = os.path.join(B1, 'cache')          # read-only use: decoded hours complete for the study period
UNIVERSE = os.path.join(B1, 'signals_universe.csv')
OUT = os.path.join(HERE, 'out')
SPAN_MS = 80 * 3_600_000
MIN_MS = 60_000
HOUR_MS = 3_600_000
PROJ_MIN_DIST = 2.0      # worker/src/lib/entryPolicy.ts validateStopLoss, OPTIMAL_REPORT_SCHEMA example profile
PROJ_MAX_DIST = 25.0     # XAUUSD values; configure_symbol() sets them from the symbol spec
BE_BAND_R = 0.10         # WIN if total_R >= +0.10R, LOSS if <= -0.10R, otherwise BE

# ----------------------------------------------------------------- cost scenarios (latency overrides entry default)
COSTS = {
    'BASE': dict(spread=0.0, slip=0.0, latency=5.0),
    'MID': dict(spread=0.10, slip=0.05, latency=10.0),
    'PESS': dict(spread=0.20, slip=0.10, latency=15.0),
}
# ----------------------------------------------------------------- entry models (never pooled)
ENTRIES = {
    'E1': dict(policy='P1', tol=2.0, expiry=60.0, nominal_guard=1.5),   # market if in range +/- 2.0
    'E2': dict(policy='P2', tol=0.5, expiry=60.0, nominal_guard=None),  # market if +/-0.5, else pending at edge
    'E3': dict(policy='P1', tol=0.5, expiry=60.0, nominal_guard=None),  # strict (report-only)
}


# ----------------------------------------------------------------- signals and splits
def load_signals():
    sigs = []
    for r in csv.DictReader(open(UNIVERSE, encoding='utf-8')):
        tps = [float(r[f'tp{k}']) if r[f'tp{k}'] else None for k in range(1, 8)]
        s = se.Signal(r['message_id'], int(r['t_ms']), r['direction'], float(r['entry_low']),
                      float(r['entry_high']), float(r['sl']), tps, r['hard_flags'])
        s.meta.update(in_clean=int(r['in_clean']), num_tps=int(r['num_tps']), sl_dist=float(r['sl_dist']),
                      info=r['info_flags'], lead_in=int(r['lead_in_prev_header']))
        sigs.append(s)
    sigs.sort(key=lambda s: (s.t_ms, int(s.message_id)))
    return sigs


def assign_splits(sigs):
    clean = [s for s in sigs if s.meta['in_clean'] == 1]
    n = len(clean)
    ntr = int(round(0.6 * n))
    nva = int(round(0.2 * n))
    tr_end = clean[ntr].t_ms
    va_end = clean[ntr + nva].t_ms
    for s in sigs:
        s.meta['split'] = 'train' if s.t_ms < tr_end else ('val' if s.t_ms < va_end else 'oos')
    cuts = dict(n_clean=n, n_train=ntr, n_val=nva, n_oos=n - ntr - nva, train_end_ms=tr_end, val_end_ms=va_end)
    return cuts


def split_counts(sigs, clean_only=True):
    out = {}
    for sp in ('train', 'val', 'oos'):
        out[sp] = sum(1 for s in sigs if s.meta['split'] == sp and (s.meta['in_clean'] == 1 or not clean_only))
    return out


# ----------------------------------------------------------------- strategy grid
# checkpoint allocations: name -> ((tp_index, pct), ...)
ALLOCS = {
    'S_TP1': ((1, 100.0),), 'S_TP2': ((2, 100.0),), 'S_TP3': ((3, 100.0),), 'S_TP4': ((4, 100.0),),
    'D_70_30': ((1, 70.0), (2, 30.0)), 'D_50_50': ((1, 50.0), (2, 50.0)), 'D_30_70': ((1, 30.0), (2, 70.0)),
    'D13_50_50': ((1, 50.0), (3, 50.0)), 'D23_50_50': ((2, 50.0), (3, 50.0)),
    'T_50_30_20': ((1, 50.0), (2, 30.0), (3, 20.0)), 'T_40_30_30': ((1, 40.0), (2, 30.0), (3, 30.0)),
    'T_33_33_34': ((1, 33.0), (2, 33.0), (3, 34.0)), 'T_20_30_50': ((1, 20.0), (2, 30.0), (3, 50.0)),
    'Q_25x4': ((1, 25.0), (2, 25.0), (3, 25.0), (4, 25.0)),
}
TRAIL_DISTS = (1.5, 2.5, 4.0, 6.0)
TRAIL_STEP = 0.5
BE_PRICE_USD = 4.0       # fixed-USD proxy for "BE at 1R" (schema-expressible); see REPORT

# Per-symbol scaling (pre-registered rule, a3/symbols.py): every USD parameter above is multiplied by the symbol's
# unit (1.0 gold, 1 pip FX); stop bounds come from min_sl/max_sl; the contract from spec['contract'].
# _BASE keeps the gold originals so configure_symbol() re-derives the live values from them every time.
_BASE = dict(COSTS={k: dict(v) for k, v in COSTS.items()}, TOL={k: v['tol'] for k, v in ENTRIES.items()},
             TRAIL_DISTS=TRAIL_DISTS, TRAIL_STEP=TRAIL_STEP, BE_PRICE_USD=BE_PRICE_USD)
SYMBOL = 'XAUUSD'
UNIT = 1.0               # price units per study "USD": 1.0 for gold, 1 pip for FX (variant labels are in these units)
OUT_DP = 4               # decimals written for fill_px and R_usd in output rows (gold 4, finer for FX)


def configure_symbol(symbol):
    """Set every USD-denominated parameter for one symbol. Returns the spec; the caller must pass
    spec['price_divisor'] to TickStore. configure_symbol('XAUUSD') leaves every value as the gold study had it."""
    global SYMBOL, UNIT, OUT_DP, PROJ_MIN_DIST, PROJ_MAX_DIST, TRAIL_DISTS, TRAIL_STEP, BE_PRICE_USD
    sp = sy.spec(symbol)
    u = sp['unit']
    SYMBOL, UNIT = sp['symbol'], u
    OUT_DP = 4 - int(round(math.log10(u)))
    PROJ_MIN_DIST, PROJ_MAX_DIST = sp['min_sl'], sp['max_sl']
    TRAIL_DISTS = tuple(d * u for d in _BASE['TRAIL_DISTS'])
    TRAIL_STEP = _BASE['TRAIL_STEP'] * u
    BE_PRICE_USD = _BASE['BE_PRICE_USD'] * u
    for cn, b in _BASE['COSTS'].items():
        COSTS[cn] = dict(b, spread=b['spread'] * u, slip=b['slip'] * u)
    for en, t in _BASE['TOL'].items():
        ENTRIES[en] = dict(ENTRIES[en], tol=t * u)
    se.CONTRACT_OZ = float(sp['contract'])
    return sp


def mgmt_options(ks, runner_ks=None):
    """Management options applicable to a checkpoint set ks (sorted tp indices). Returns list of (code, spec)."""
    ks = set(ks)
    opts = [('M0', {})]
    rem_after = lambda k: any(x > k for x in ks)  # noqa: E731  (open position remains after TP k)
    if 1 in ks and rem_after(1):
        opts.append(('M1', dict(sl_after=((1, 'entry', 0.0),))))
        opts.append(('M2', dict(sl_after=((1, 'entry', 0.3 * UNIT),))))   # 0.3 USD buffer (gold), scaled per symbol
    if 2 in ks and rem_after(2):
        opts.append(('M3', dict(sl_after=((2, 'entry', 0.0),))))
        opts.append(('M4', dict(sl_after=((2, 'previous_tp', 0.0),))))
    opts.append(('M5', dict(break_even=('price', BE_PRICE_USD, 0.0))))
    if 1 in ks and rem_after(1):
        for d in TRAIL_DISTS:
            opts.append((f'T1_{d / UNIT:g}', dict(trailing=(('after_tp', 1), d, TRAIL_STEP))))
    if 2 in ks and rem_after(2):
        for d in TRAIL_DISTS:
            opts.append((f'T2_{d / UNIT:g}', dict(trailing=(('after_tp', 2), d, TRAIL_STEP))))
    return opts


def build_grid():
    """Returns list of variant dicts: name, family, alloc, mgmt, cps, runner_pct, close_all_at, kwargs, missing_tp."""
    V = []
    for an, cps in ALLOCS.items():
        ks = [k for k, _ in cps]
        if len(cps) == 1:
            V.append(dict(alloc=an, mgmt='M0', family='single', cps=cps, runner=0.0, close_all_at=None,
                          kw={}, missing_tp='skip_trade'))
            V.append(dict(alloc=an, mgmt='M5', family='single', cps=cps, runner=0.0, close_all_at=None,
                          kw=dict(break_even=('price', BE_PRICE_USD, 0.0)), missing_tp='skip_trade'))
            continue
        for code, kw in mgmt_options(ks):
            V.append(dict(alloc=an, mgmt=code, family='multi', cps=cps, runner=0.0, close_all_at=None,
                          kw=kw, missing_tp='merge_into_last_available'))
    # close-all-at-checkpoint (schema-expressible as a shorter checkpoint list)
    for an, ca, base in (('CA_T33_at_TP2', 2, ALLOCS['T_33_33_34']), ('CA_Q25_at_TP3', 3, ALLOCS['Q_25x4'])):
        ks = [k for k, _ in base]
        for code, kw in mgmt_options(ks):
            if code in ('M0', 'M1', 'M5'):
                V.append(dict(alloc=an, mgmt=code, family='close_all', cps=base, runner=0.0, close_all_at=ca,
                              kw=kw, missing_tp='merge_into_last_available'))
    # runners (NOT schema-expressible: research only). Runner = r% of initial volume with no TP cap.
    # Per runner share: no-trailing (SL stays at BE after TP1 and at previous TP after TP2/TP3) or trailing
    # activated after TP1 or TP2 with distance in TRAIL_DISTS (USD for gold, pips for FX; step 0.5 units).
    for r in (10.0, 20.0, 30.0, 40.0):
        for rn, rcps in (('RUN2', ((1, (100 - r) / 2), (2, (100 - r) / 2))),
                         ('RUN3', ((1, (100 - r) / 3), (2, (100 - r) / 3), (3, (100 - r) / 3)))):
            nt_sl = ((1, 'entry', 0.0), (2, 'previous_tp', 0.0)) if rn == 'RUN2' else \
                ((1, 'entry', 0.0), (2, 'previous_tp', 0.0), (3, 'previous_tp', 0.0))
            V.append(dict(alloc=f'{rn}_r{r:g}', mgmt='RUN_NOTRAIL', family='runner', cps=rcps, runner=r,
                          close_all_at=None, kw=dict(sl_after=nt_sl), missing_tp='merge_into_last_available'))
            for d in TRAIL_DISTS:
                V.append(dict(alloc=f'{rn}_r{r:g}', mgmt=f'RUN_T1_{d / UNIT:g}', family='runner', cps=rcps, runner=r,
                              close_all_at=None, kw=dict(trailing=(('after_tp', 1), d, TRAIL_STEP)),
                              missing_tp='merge_into_last_available'))
                V.append(dict(alloc=f'{rn}_r{r:g}', mgmt=f'RUN_T2_{d / UNIT:g}', family='runner', cps=rcps, runner=r,
                              close_all_at=None, kw=dict(trailing=(('after_tp', 2), d, TRAIL_STEP)),
                              missing_tp='merge_into_last_available'))
    for v in V:
        v['name'] = f"{v['alloc']}|{v['mgmt']}"
        v['unit'] = UNIT                  # kwargs hold prices in this unit; make_strategy refuses a mismatch
    return V


def make_strategy(v, units='fraction', total_lots=0.10):
    if v.get('unit', UNIT) != UNIT:
        raise ValueError(f"variant {v['name']} was built with unit {v['unit']}, configured unit is {UNIT}")
    kw = dict(v['kw'])
    return se.Strategy(v['name'], checkpoints=v['cps'], runner_pct=v['runner'], close_all_at=v['close_all_at'],
                       missing_tp=v['missing_tp'], units=units, total_lots=total_lots,
                       horizon_h=72.0, **kw)


def grid_summary(V):
    fam = {}
    for v in V:
        fam[v['family']] = fam.get(v['family'], 0) + 1
    return dict(total=len(V), by_family=fam, schema_expressible=sum(1 for v in V if v['family'] != 'runner'))


# ----------------------------------------------------------------- per-signal evaluation
def get_window(store, sig):
    return se.load_window(store, sig.t_ms, sig.t_ms + SPAN_MS)


def evaluate_signal(store, sig, variants, entries=('E1', 'E2', 'E3'), costs=('BASE', 'MID', 'PESS'), conv=None,
                    horizon_h=72.0):
    """Returns (fill_rows, trade_rows). Fill rows: one per (entry, cost). Trade rows: one per (entry, cost, variant)."""
    conv = conv or se.Conventions(contract_oz=se.CONTRACT_OZ)
    win = get_window(store, sig)
    mks = {}
    fill_rows, trade_rows = [], []
    fav = sig.fav
    for en in entries:
        ecfg = ENTRIES[en]
        for cn in costs:
            c = COSTS[cn]
            ep = se.EntryParams(ecfg['policy'], latency_s=c['latency'], tol=ecfg['tol'],
                                expiry_min=ecfg['expiry'], extra_spread=c['spread'], slippage=c['slip'])
            if c['spread'] not in mks:
                mks[c['spread']] = se.Market(win, sig.direction, c['spread'])
            mk = mks[c['spread']]
            fill = se.decide_entry(sig, ep, mk)
            base = dict(message_id=sig.message_id, t_ms=sig.t_ms, split=sig.meta['split'],
                        in_clean=sig.meta['in_clean'], direction=sig.direction, entry=en, cost=cn,
                        nominal_R=abs(sig.entry_mid - sig.sl), sl_dist_signal=sig.meta['sl_dist'])
            if fill.status != 'FILLED':
                fill_rows.append(dict(base, status=fill.status, reason=fill.reason, fill_ms='', fill_px='',
                                      R_usd='', kind=fill.kind))
                continue
            ref = fill.fill_px - fav * c['slip']          # decision price (market price or limit), as entryPolicy.ts
            dist = abs(ref - sig.sl)
            status, reason = 'FILLED', ''
            if dist < PROJ_MIN_DIST:
                status, reason = 'SKIPPED_proj_sl_too_close', 'sl_too_close'
            elif dist > PROJ_MAX_DIST:
                status, reason = 'SKIPPED_proj_sl_too_far', 'sl_too_far'
            R = abs(fill.fill_px - sig.sl)
            if status == 'FILLED' and ecfg['nominal_guard'] and R > ecfg['nominal_guard'] * base['nominal_R']:
                status, reason = 'SKIPPED_risk_gt_guard_x_nominal', 'risk_gt_1.5x_nominal'
            fill_rows.append(dict(base, status=status, reason=reason, fill_ms=fill.fill_ms,
                                  fill_px=round(fill.fill_px, OUT_DP), R_usd=round(R, OUT_DP), kind=fill.kind))
            if status != 'FILLED':
                continue
            tbase = dict(base, fill_ms=fill.fill_ms, fill_px=round(fill.fill_px, OUT_DP), R_usd=round(R, OUT_DP),
                         kind=fill.kind)
            for v in variants:
                res = se.simulate(sig, fill, v['strategy'], mk, conv=conv, slip=c['slip'])
                trade_rows.append(trade_row(tbase, v, res, fill, c, mk))
    return fill_rows, trade_rows


def trade_row(base, v, res, fill, c, mk):
    row = dict(base, variant=v['name'], alloc=v['alloc'], mgmt=v['mgmt'], family=v['family'],
               status=res['status'], reason=res.get('reason', ''), total_R='', usd_per_1lot='',
               last_exit_ms='', final_exit='', exit_seq='', tp_ks='', mae_all_R='', mfe_all_R='',
               mae_pre_R='', mfe_pre_R='', min_to_first_tp='', min_to_stop='', flags=';'.join(res.get('flags', [])),
               horizon_reason=res.get('horizon_reason', ''))
    if 'total_R' in res:
        row['total_R'] = round(res['total_R'], 6)
        row['usd_per_1lot'] = round(res['usd_per_1lot'], 4)
        ex = res.get('exits', [])
        row['last_exit_ms'] = max(e[1] for e in ex) if ex else ''
        row['final_exit'] = res.get('final_exit', '')
        row['exit_seq'] = res.get('exit_seq', '')
        ks = sorted({int(e[0][2:]) for e in ex if e[0].startswith('TP') and e[0][2:].isdigit()})
        row['tp_ks'] = '|'.join(str(k) for k in ks)
        for key in ('mae_all_R', 'mfe_all_R', 'mae_pre_R', 'mfe_pre_R', 'min_to_first_tp', 'min_to_stop'):
            val = res.get(key)
            row[key] = '' if val is None else round(val, 6)
    return row
