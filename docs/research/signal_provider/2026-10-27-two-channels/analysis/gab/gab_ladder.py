"""Owner's ladder plan on GAB FX gold signals (2026-10-29 mandate). Read-only research.

Plan per signal: stop = posted stop widened by W pips (1 pip = 0.10 USD); N legs of 0.01 lot; leg k (k < N)
closes at +100k pips from the fill; the last leg is a runner with a trailing stop D pips behind the best price;
when the price first reaches +100 pips every open leg's stop moves to the fill price (breakeven).
Runner trail starts either at +100 ('be') or when the last fixed leg closes ('last'; same as 'be' for N <= 2).

Prices: Dukascopy M1 bid/ask. A buy fills on the ask and exits on the bid; sells are mirrored (price -> -price) so
one engine handles both. Inside a minute the path is an assumption: 'ohlc' (O-L-H-C on an up bar, O-H-L-C on a
down bar), 'adverse' (always O-L-H-C in trade direction), 'favorable' (always O-H-L-C). Stops fill at their level
inside a bar and at the open on a gap; targets fill at their level. The same engine runs on ticks (--ticks) to
validate the M1 path assumption."""
import json, os, sys, bisect, collections, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gab_sim_m1 import day, phase, LAT, FILL_WINDOW

PIP = 0.10
STEP = 100 * PIP                                   # one ladder rung, USD per ounce
WIDEN = (0, 80, 130)                               # pips added to the posted stop (0 = reference)
TRAILS = (30, 50, 75, 100, 150, 200, 250, 300, 400, 500, 700, 1000, None)   # pips; None = no trail (breakeven only)
ACTS = (1, 2, 3, 4, 5)                             # rung at which the runner's trail starts
KMAX = 5                                           # fixed legs for N = 6
HORIZON = int(os.environ.get("LADDER_HORIZON_H", "120")) * 3600
LAST_DAY = dt.date(2026, 10, 27)                   # last downloaded M1 day
STUDY = "/tmp/claude-1001/twochan/gab/study"


def m1_bars(t0, t1):
    """(ts, bid ohlc, ask ohlc) from t0 to t1; stops quietly at the end of the downloaded data."""
    d = dt.datetime.utcfromtimestamp(t0).date(); end = dt.datetime.utcfromtimestamp(t1).date()
    out = []; truncated = False
    while d <= end:
        if d > LAST_DAY: truncated = True; break
        ok, rows = day(d)
        if not ok: raise LookupError(d)
        for ts in sorted(rows):
            if t0 <= ts < t1 and 'BID' in rows[ts] and 'ASK' in rows[ts]:
                B = rows[ts]['BID']; A = rows[ts]['ASK']     # (o, c, l, h)
                out.append((ts, (B[0], B[3], B[2], B[1]), (A[0], A[3], A[2], A[1])))   # -> (o, h, l, c)
        d += dt.timedelta(days=1)
    return out, truncated


def mirror(b):
    o, h, l, c = b
    return (-o, -l, -h, -c)


def path_points(bars, order):
    """Exit-side price points with a flag: True = reached continuously (fills at the level), False = jump (gap)."""
    P = []; F = []; T = []
    for ts, X in bars:
        o, h, l, c = X
        if order == 'adverse' or (order == 'ohlc' and c >= o): seq = (l, h, c)
        else: seq = (h, l, c)
        P.append(o); F.append(False); T.append(ts)
        for v in seq:
            P.append(v); F.append(True); T.append(ts)
    return P, F, T


def next_true(cond):
    """nxt[i] = first j >= i with cond[j], else len."""
    n = len(cond); nxt = [n] * (n + 1)
    for i in range(n - 1, -1, -1):
        nxt[i] = i if cond[i] else nxt[i + 1]
    return nxt


def run_legs(e, P, F, T, sls):
    """Resolve every leg on one price path. e = fill (exit-side units), P/F/T from path_points or ticks.
    Returns {W: {'fixed': {k: (pnl, ts, why)}, 'runner': {(D, act): (pnl, ts, why)}}} with pnl in USD per 0.01 lot."""
    n = len(P)
    if n == 0: return None
    peak = []; m = float('-inf')
    for p in P:
        m = p if p > m else m
        peak.append(m)
    def first_peak_ge(x):
        return bisect.bisect_left(peak, x)           # peak is non-decreasing
    arm = first_peak_ge(e + STEP)
    le_e = next_true([p <= e for p in P])
    dd_next = {D: next_true([pk - p >= D * PIP for pk, p in zip(peak, P)]) for D in TRAILS if D is not None}
    end_px = P[-1]; end_ts = T[-1]

    def fill(i, level):
        return level if F[i] else min(P[i], level)

    out = {}
    for W, sl in sls.items():
        sl_hit = n
        for i in range(min(arm, n)):
            if P[i] <= sl: sl_hit = i; break
        res = {'fixed': {}, 'runner': {}}
        def stopped_before_arm():
            return sl_hit < n and sl_hit < arm
        for k in range(1, KMAX + 1):
            tp = e + k * STEP; t_tp = first_peak_ge(tp)
            if stopped_before_arm(): res['fixed'][k] = (fill(sl_hit, sl) - e, T[sl_hit], 'sl'); continue
            t_be = le_e[arm] if arm < n else n
            if t_tp < n and t_tp <= t_be: res['fixed'][k] = (tp - e, T[t_tp], 'tp')
            elif t_be < n: res['fixed'][k] = (fill(t_be, e) - e, T[t_be], 'be')
            else: res['fixed'][k] = (end_px - e, end_ts, 'horizon')
        for act in ACTS:
            ta = first_peak_ge(e + act * STEP)
            for D in TRAILS:
                if stopped_before_arm(): res['runner'][(D, act)] = (fill(sl_hit, sl) - e, T[sl_hit], 'sl'); continue
                t_be = le_e[arm] if arm < n else n
                if t_be < ta or ta >= n:                      # breakeven (or horizon) before the trail starts
                    r = (fill(t_be, e) - e, T[t_be], 'be') if t_be < n else (end_px - e, end_ts, 'horizon')
                else:
                    t_tr = dd_next[D][ta] if D is not None else n
                    t_b2 = le_e[ta]
                    j = min(t_tr, t_b2)
                    if j >= n: r = (end_px - e, end_ts, 'horizon')
                    else:
                        lvl = max(e, peak[j] - D * PIP) if D is not None and t_tr <= t_b2 else e
                        r = (fill(j, lvl) - e, T[j], 'trail' if lvl > e else 'be')
                res['runner'][(D, act)] = r
        out[W] = res
    return out


def m1_signal(r, model, orders):
    buy = r['side'] == 'BUY'
    start = r['date'] + LAT; start_bar = start - start % 60 + 60
    try:
        raw, truncated = m1_bars(start_bar, start_bar + HORIZON + FILL_WINDOW)
    except LookupError as ex:
        return {'status': 'incomplete_data', 'missing': str(ex)}
    if not raw: return {'status': 'no_data'}
    bars = [(ts, B if buy else mirror(A), A if buy else mirror(B)) for ts, B, A in raw]   # (ts, X exit side, E entry side)
    sl0 = r['sl'] if buy else -r['sl']
    if model == 'market' or r['market_only']:
        i0 = 0; e = bars[0][2][0]
        if bars[0][1][0] <= sl0: return {'status': 'beyond_posted_sl_at_entry'}
        path_from = 0; pre_hit = None
    else:
        lim = r['entry_hi'] if buy else -r['entry_lo']
        i0 = None
        for i, (ts, X, E) in enumerate(bars):
            if ts - start > FILL_WINDOW: break
            if X[2] <= sl0 and E[2] > lim: return {'status': 'sl_before_fill'}
            if E[2] <= lim: i0 = i; e = min(lim, E[0]); break
        if i0 is None: return {'status': 'no_fill'}
        path_from = i0 + 1; pre_hit = bars[i0][1][2]            # exit-side low of the fill bar
    t_entry = bars[i0][0]
    seg = [(ts, X) for ts, X, E in bars[path_from:] if ts < t_entry + HORIZON]
    sls = {W: sl0 - W * PIP for W in WIDEN}
    res = {'status': 'ok', 'entry': e, 'risk': {W: e - s for W, s in sls.items()}, 't_entry': t_entry,
           'truncated': truncated and (not seg or seg[-1][0] < t_entry + HORIZON - 3600), 'orders': {}}
    for order in orders:
        if model == 'market':
            P, F, T = path_points(seg, order)
            F[0] = True                                          # the first open is the fill price itself
        else:
            P, F, T = path_points(seg, order)
        legs = run_legs(e, P, F, T, sls)
        if pre_hit is not None and legs is not None:
            for W, s in sls.items():                             # pessimistic: a stop touched in the fill minute counts
                if pre_hit <= s:
                    legs[W] = {'fixed': {k: (s - e, t_entry, 'sl') for k in range(1, KMAX + 1)},
                               'runner': {key: (s - e, t_entry, 'sl') for key in legs[W]['runner']}}
        res['orders'][order] = legs
    return res


def tick_signal(r, hours=24):
    """Market model on ticks for the first `hours` (tick download covers 0-24 h after each signal)."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'a3'))
    from dukas_lib import window_ticks
    from gab_sim import covered_until
    raw_dir = "/tmp/claude-1001/twochan/gold/raw"
    buy = r['side'] == 'BUY'; s = r['date'] + LAT; t0 = (s - s % 60 + 60) * 1000   # same fill minute as the M1 replay
    end = covered_until(t0, t0 + hours * 3600_000)
    if end < t0 + hours * 3600_000: return {'status': 'incomplete_data'}
    P = []; T = []; e = None
    for ts, b, a in window_ticks(raw_dir, t0, end):
        bid, ask = b / 1000.0, a / 1000.0
        if e is None: e = ask if buy else -bid
        P.append(bid if buy else -ask); T.append(ts // 1000)
    if e is None: return {'status': 'no_data'}
    sl0 = r['sl'] if buy else -r['sl']
    if P[0] <= sl0: return {'status': 'beyond_posted_sl_at_entry'}
    sls = {W: sl0 - W * PIP for W in WIDEN}
    return {'status': 'ok', 'entry': e, 't_entry': T[0], 'legs': run_legs(e, P, [False] * len(P), T, sls)}


def enc(legs):
    if legs is None: return None
    return {str(W): {'fixed': {str(k): v for k, v in x['fixed'].items()},
                     'runner': {f"{D}_{a}": v for (D, a), v in x['runner'].items()}} for W, x in legs.items()}


def work(args):
    r, mode = args
    base = dict(id=r['id'], date=r['date'], side=r['side'], phase=phase(r))
    if mode == 'ticks':
        t = tick_signal(r)
        if t.get('legs') is not None: t['legs'] = enc(t['legs'])
        return dict(base, ticks=t)
    out = dict(base)
    for model, orders in (('market', ('ohlc', 'adverse', 'favorable')), ('level', ('ohlc', 'adverse', 'favorable'))):
        x = m1_signal(r, model, orders)
        if x.get('status') == 'ok':
            x['risk'] = {str(k): v for k, v in x['risk'].items()}
            x['orders'] = {o: enc(l) for o, l in x['orders'].items()}
        out[model] = x
    return out


if __name__ == '__main__':
    from multiprocessing import Pool
    mode = sys.argv[1] if len(sys.argv) > 1 else 'm1'
    S = [r for r in json.load(open(f"{STUDY}/signals.json"))
         if r['symbol'] == 'XAUUSD' and r['check'] == 'ok' and 'dup_of' not in r]
    with Pool(4) as pool:
        res = pool.map(work, [(r, mode) for r in S], chunksize=4)
    name = f"{STUDY}/ladder_{mode}.json"
    json.dump(res, open(name, "w"))
    key = 'ticks' if mode == 'ticks' else 'market'
    print("signals", len(res), collections.Counter(x[key]['status'] for x in res), "->", name)
