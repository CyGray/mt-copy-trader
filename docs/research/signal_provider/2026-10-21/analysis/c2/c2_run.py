"""C2 grid runner: builds signal list, runs entry variants and six exit strategies, writes CSVs to c2/out/.
Usage: python3 -I c2_run.py <variant_set>   (variant_set: core | sens)"""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append('/home/kyle/.local/lib/python3.12/site-packages')
import csv, json, os, datetime as dt
import numpy as np
import c2_ticks as T_
import c2_sim as S

SCR = T_.SCRATCH
OUT = os.path.join(SCR, 'c2', 'out')
os.makedirs(OUT, exist_ok=True)


def load_signals():
    a1 = list(csv.DictReader(open(os.path.join(SCR, 'a1', 'signals.csv'))))
    uni = {r['message_id']: r for r in csv.DictReader(open(os.path.join(SCR, 'b1', 'signals_universe.csv')))}
    sigs = []
    for r in a1:
        ts = dt.datetime.strptime(r['date_utc'].replace('Z', ''), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=dt.timezone.utc)
        t_ms = int(ts.timestamp() * 1000)
        u = uni[r['message_id']]
        assert int(u['t_ms']) == t_ms, ('time mismatch', r['message_id'])
        low, high, sl = float(r['entry_low']), float(r['entry_high']), float(r['sl'])
        assert abs(low - float(u['entry_low'])) < 1e-9 and abs(high - float(u['entry_high'])) < 1e-9 and abs(sl - float(u['sl'])) < 1e-9, ('level mismatch', r['message_id'])
        tps = [float(r[f'tp{k}']) if r[f'tp{k}'] not in ('', None) else None for k in range(1, 8)]
        d = 1 if r['direction'].lower() == 'buy' else -1
        sigs.append(dict(msg=r['message_id'], t=t_ms, dir=d, low=low, high=high, sl=sl, mid=(low + high) / 2.0,
                         tps=tps, clean=(u['in_clean'] == '1'), hard=u['hard_flags'], date=r['date_utc']))
    sigs.sort(key=lambda s: (s['t'], int(s['msg'])))
    clean = [s for s in sigs if s['clean']]
    assert len(clean) == 406, len(clean)
    for i, s in enumerate(clean):
        s['split'] = 'TRAIN' if i < 244 else ('VALID' if i < 325 else 'OOS')
    for s in sigs:
        if not s['clean']:
            s['split'] = 'NONCLEAN'
    return sigs


def strategies(sig):
    """Six strategies; each returns dict(tps=[(tp_real, weight)], be=None|4.0, be_after_tp=None|1) or None if skipped."""
    tp = sig['tps']
    out = {}
    for name, k in (('S_TP1', 0), ('S_TP3', 2), ('S_TP4', 3)):
        out[name + '|M0'] = None if tp[k] is None else dict(tps=[(tp[k], 1.0)], be=None, be_after_tp=None)
    out['S_TP4|M5'] = None if tp[3] is None else dict(tps=[(tp[3], 1.0)], be=4.0, be_after_tp=None)
    # full-population fallback: TP4 if present, otherwise the last available TP (TP3, TP2 or TP1)
    avail = [x for x in tp if x is not None]
    fb = avail[3] if len(avail) >= 4 else avail[-1]
    out['S_TP4FB|M0'] = dict(tps=[(fb, 1.0)], be=None, be_after_tp=None)
    out['S_TP4FB|M5'] = dict(tps=[(fb, 1.0)], be=4.0, be_after_tp=None)
    present = [x for x in tp[:4] if x is not None]
    m = len(present)
    if m == 0:
        out['Q_25x4|M0'] = out['Q_25x4|M3'] = None
    else:
        w = [0.25] * (m - 1) + [1.0 - 0.25 * (m - 1)]
        legs = list(zip(present, w))
        out['Q_25x4|M0'] = dict(tps=legs, be=None, be_after_tp=None)
        out['Q_25x4|M3'] = dict(tps=legs, be=None, be_after_tp=(1 if m >= 2 else None))
    return out


STRATS = ['S_TP1|M0', 'S_TP3|M0', 'S_TP4|M0', 'S_TP4|M5', 'Q_25x4|M0', 'Q_25x4|M3', 'S_TP4FB|M0', 'S_TP4FB|M5']

# variant: name, mode, costp(lat, slip, spread), cap_ms, guard, shift_ms, persist
H = S.HOUR
SPREAD_COST = lambda sp, base: dict(lat=base['lat'], slip=base['slip'], spread=sp)
MIDPS = dict(lat=10000, slip=0.05, spread=0.10, pend_slip=True)
BASEPS = dict(lat=5000, slip=0.0, spread=0.0, pend_slip=True)
CORE = [
    # primary (spec-literal): E1/E3 decided at first tick; E1 guard; E3 no guard; E2 no guard (spec gives no guard for E2)
    ('BASE_E1_FT', 'E1', S.BASE, 0, None, 0, None),
    ('MID_E1_FT', 'E1', S.MID, 0, None, 0, None),
    ('BASE_E3_FT', 'E3', S.BASE, 0, None, 0, None),
    ('MID_E3_FT', 'E3', S.MID, 0, None, 0, None),
    ('BASE_E2_noguard', 'E2', S.BASE, 72 * H, False, 0, None),
    ('MID_E2_noguard', 'E2', S.MID, 72 * H, False, 0, None),
    # sensitivities on entry rules
    ('MID_E2_noguard_pendslip', 'E2', MIDPS, 72 * H, False, 0, None),
    ('BASE_E2_guard', 'E2', S.BASE, 72 * H, None, 0, None),
    ('MID_E2_guard', 'E2', S.MID, 72 * H, None, 0, None),
    ('MID_E1_FT_noguard', 'E1', S.MID, 0, False, 0, None),
    ('BASE_E1_wait60m', 'E1', S.BASE, 60 * 60000, None, 0, None),
    ('BASE_E3_wait60m', 'E3', S.BASE, 60 * 60000, None, 0, None),
    ('MID_E1_wait60m', 'E1', S.MID, 60 * 60000, None, 0, None),
    ('MID_E3_wait60m', 'E3', S.MID, 60 * 60000, None, 0, None),
    ('MID_E1_wait72h', 'E1', S.MID, 72 * H, None, 0, None),
    ('MID_E3_wait72h', 'E3', S.MID, 72 * H, None, 0, None),
]
SENS = [
    # spread / timestamp / spike-filter sensitivities, on the primary MID E2 (no guard) model
    ('MID_E2_spread030', 'E2', dict(lat=10000, slip=0.05, spread=0.30), 72 * H, False, 0, None),
    ('MID_E2_spread050', 'E2', dict(lat=10000, slip=0.05, spread=0.50), 72 * H, False, 0, None),
    ('MID_E2_shift-60s', 'E2', S.MID, 72 * H, False, -60000, None),
    ('MID_E2_shift+60s', 'E2', S.MID, 72 * H, False, 60000, None),
    ('MID_E1_FT_shift-60s', 'E1', S.MID, 0, None, -60000, None),
    ('MID_E1_FT_shift+60s', 'E1', S.MID, 0, None, 60000, None),
    ('MID_E3_FT_shift-60s', 'E3', S.MID, 0, None, -60000, None),
    ('MID_E3_FT_shift+60s', 'E3', S.MID, 0, None, 60000, None),
    ('MID_E2_noguard_persist2tk', 'E2', S.MID, 72 * H, False, 0, ('ticks', 2)),
    ('MID_E2_noguard_persist1s', 'E2', S.MID, 72 * H, False, 0, ('ms', 1000)),
    ('BASE_E2_noguard_persist2tk', 'E2', S.BASE, 72 * H, False, 0, ('ticks', 2)),
]
PRE = 2 * 60000 + 2 * H  # window margin


def window_for(sig, shift, spread):
    """Quote arrays for one signal at a given spread. Eq = real entry quote, Xq = flipped exit quote (d*exit quote)."""
    raise NotImplementedError


def run(variant_set):
    variants = {'core': CORE, 'sens': SENS, 'extra': EXTRA, 'extra2': EXTRA2}[variant_set]
    sigs = load_signals()
    store = T_.HourStore(max_hours=600)
    entry_rows, trade_rows = [], []
    for n, sig in enumerate(sigs):
        cache = {}
        for vname, mode, costp, cap, guard, shift, persist in variants:
            t_eff = sig['t'] + shift
            key = (shift, costp['spread'], costp['slip'], costp['lat'])
            if key not in cache:
                ts, asks, bids = store.window(t_eff - PRE, t_eff + 147 * H)
                half = costp['spread'] / 2.0
                if sig['dir'] > 0:
                    Eq = asks + half
                    Xreal = bids - half
                else:
                    Eq = bids - half
                    Xreal = asks + half
                cache[key] = dict(T=ts, Eq=Eq, Xq=sig['dir'] * Xreal)
            win = cache[key]
            sg = dict(sig, t=t_eff)
            if len(win['T']) == 0:
                entry_rows.append(dict(variant=vname, msg=sig['msg'], split=sig['split'], status='NO_PRICE_DATA'))
                continue
            fill = S.decide_entry(sg, dict(T=win['T'], Eq=win['Eq']), mode, costp, cap, guard_override=guard)
            entry_rows.append(dict(variant=vname, msg=sig['msg'], split=sig['split'], dir=sig['dir'], t=sig['t'],
                                   status=fill['status'], kind=fill.get('kind', ''), fill_real=fill.get('fill_real', ''),
                                   t_fill=fill.get('t_fill', ''), R_dist=fill.get('R_dist', ''), reason=fill.get('reason', '')))
            if fill['status'] != 'FILLED':
                continue
            for sname, st in strategies(sig).items():
                if st is None:
                    trade_rows.append(dict(variant=vname, msg=sig['msg'], split=sig['split'], strat=sname, status='NO_TP', R=''))
                    continue
                res = S.simulate(win, fill, sg, st, costp, persist=persist)
                trade_rows.append(dict(variant=vname, msg=sig['msg'], split=sig['split'], strat=sname, status='OK',
                                       kind=fill['kind'], fill_real=fill['fill_real'], t_fill=fill['t_fill'],
                                       R=res['R'], unresolved=int(res['unresolved']), exit_ms=res['exit_ms'],
                                       max_gap_min=res['max_gap_min'], legs=json.dumps(res['legs'])))
        if n % 50 == 0:
            print('signal', n, 'of', len(sigs), flush=True)
    for name, rows in (('entries', entry_rows), ('trades', trade_rows)):
        fn = os.path.join(OUT, f'c2_{name}_{variant_set}.csv')
        keys = sorted({k for r in rows for k in r})
        with open(fn, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=keys)
            w.writeheader()
            w.writerows(rows)
        print('wrote', fn, len(rows), flush=True)


EXTRA = [
    # +1 USD adverse fill tests (provider's claim): entries only, and entries plus stop exits
    ('BASE_E2_noguard_adv1entry', 'E2', dict(lat=5000, slip=0.0, spread=0.0, entry_slip=1.0, pend_slip=True), 72 * H, False, 0, None),
    ('BASE_E2_noguard_adv1all', 'E2', dict(lat=5000, slip=1.0, spread=0.0, entry_slip=1.0, pend_slip=True), 72 * H, False, 0, None),
    ('BASE_E1_FT_adv1entry', 'E1', dict(lat=5000, slip=0.0, spread=0.0, entry_slip=1.0, pend_slip=True), 0, None, 0, None),
    ('BASE_E3_FT_adv1entry', 'E3', dict(lat=5000, slip=0.0, spread=0.0, entry_slip=1.0, pend_slip=True), 0, None, 0, None),
    ('BASE_E2_noguard_adv05entry', 'E2', dict(lat=5000, slip=0.0, spread=0.0, entry_slip=0.5, pend_slip=True), 72 * H, False, 0, None),
]
PESS = dict(lat=15000, slip=0.10, spread=0.20, pend_slip=True)
EXTRA2 = [
    ('PESS_E1_FT', 'E1', PESS, 0, None, 0, None),
    ('PESS_E2_noguard_pendslip', 'E2', PESS, 72 * H, False, 0, None),
    ('PESS_E3_FT', 'E3', PESS, 0, None, 0, None),
]
if __name__ == '__main__':
    if sys.argv[1] == 'extra2':
        pass
    if sys.argv[1] == 'extra':
        CORE_BAK = CORE
        CORE = EXTRA
    run(sys.argv[1])
