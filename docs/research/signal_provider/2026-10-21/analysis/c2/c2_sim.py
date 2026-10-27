"""C2 independent entry/exit simulator, written from the audit specification (not from b1/b2 code).

Conventions. Exits are computed in 'flipped' space x = d*price, d = +1 (BUY) / -1 (SELL), so one code path serves both:
  entry quote (real): BUY ask_eff = ask + s/2 ; SELL bid_eff = bid - s/2     (s = extra spread total; 0 in BASE)
  exit quote  (real): BUY bid_eff = bid - s/2 ; SELL ask_eff = ask + s/2
  market fill (real) = entry quote -/+ adverse slip (slip 0.05 in MID, 0 in BASE)      -> flipped F = d*Eq + slip
  limit fill (real) = limit price exactly (no slippage: a limit cannot fill worse than its price) -> F = d*limit
  stop exit fill = min(Xf, SLf) - slip (flipped) = the gapped tick when worse than SL, minus adverse slippage
  TP exit fill = TP price on touch (no slippage)
  Same tick: stop checked before TP (conservative). BE activation checked after exit checks on that tick.
Entry rules (also in c2_run.py):
  E1: first tick >= t_sig+lat whose entry quote is in [low-2.0, high+2.0] -> market; guard applies. Search cap: CAP.
  E2: decision at first tick i0 >= t_sig+lat: quote in [low-0.5, high+0.5] -> market; BUY ask>high+0.5 (SELL bid<low-0.5)
      -> limit at high (BUY) / low (SELL), valid until T[i0]+60 min; favourable side -> skip. Guard applies.
  E3: as E1 with tolerance 0.5 and no guard.
Guard: |fill-SL| in [2.0, 25.0], SL on the protective side of fill, |fill-SL| <= 1.5*|mid-SL|.
"""
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import sys as _s; _s.path.append("/home/kyle/.local/lib/python3.12/site-packages")
import numpy as np

HOUR = 3600_000
HORIZON_MS = 72 * HOUR
PENDING_VALID_MS = 60 * 60_000
GUARD_MIN, GUARD_MAX, GUARD_K = 2.0, 25.0, 1.5
MID_SLIP = 0.05


BASE = dict(lat=5000, slip=0.0, spread=0.0, name='BASE')
MID = dict(lat=10000, slip=MID_SLIP, spread=0.10, name='MID')


def first_le(arr, a, b, thr):
    if a >= b:
        return -1
    seg = arr[a:b] <= thr
    j = int(seg.argmax())
    return a + j if seg[j] else -1


def first_ge(arr, a, b, thr):
    if a >= b:
        return -1
    seg = arr[a:b] >= thr
    j = int(seg.argmax())
    return a + j if seg[j] else -1


def _persisted(arr, T, j, b, thr, sense, persist):
    """True if the breach at index j persists: every tick in the persistence span is beyond thr.
    persist = ('ticks', n) or ('ms', m). Span truncated at window end b (available ticks only)."""
    if persist is None:
        return True
    if persist[0] == 'ticks':
        hi = min(b, j + persist[1])
    else:
        hi = min(b, int(np.searchsorted(T, T[j] + persist[1], 'right')))
    seg = arr[j:hi]
    return bool((seg <= thr).all()) if sense == 'le' else bool((seg >= thr).all())


def pfirst(arr, T, a, b, thr, sense, persist):
    """First index in [a,b) where the breach is confirmed (persistence rule applied)."""
    while True:
        j = first_le(arr, a, b, thr) if sense == 'le' else first_ge(arr, a, b, thr)
        if j < 0 or _persisted(arr, T, j, b, thr, sense, persist):
            return j
        a = j + 1


def decide_entry(sig, win, mode, costp, cap_ms, guard_override=None):
    """sig: dict(t, dir, low, high, sl, mid). win: dict(T int64 ms, Eq real entry quote array for this cost).
    Returns dict(status, idx, kind, fill_real, F, t_fill, R, reason)."""
    T, Eq = win['T'], win['Eq']
    d = sig['dir']
    i0 = int(np.searchsorted(T, sig['t'] + costp['lat'], 'left'))
    if i0 >= len(T):
        return dict(status='NO_PRICE_DATA', reason='no tick at/after latency')
    low, high = sig['low'], sig['high']
    kind = 'MKT'
    if mode in ('E1', 'E3'):
        tol = 2.0 if mode == 'E1' else 0.5
        guard = (mode == 'E1') if guard_override is None else guard_override
        if cap_ms == 0:  # first-tick-only (market decided at the first tick after latency)
            q = Eq[i0]
            if not (low - tol <= q <= high + tol):
                return dict(status='SKIPPED_NO_BAND_TICK', reason='first tick outside band')
            k = i0
        else:  # wait for the first in-band tick within cap_ms of the signal
            end = int(np.searchsorted(T, sig['t'] + cap_ms, 'right'))
            seg = Eq[i0:end]
            m = (seg >= low - tol) & (seg <= high + tol)
            if not m.any():
                return dict(status='SKIPPED_NO_BAND_TICK', reason='no in-band tick within cap')
            k = i0 + int(m.argmax())
    elif mode == 'E2':
        guard = True if guard_override is None else guard_override
        q0 = Eq[i0]
        lo_b, hi_b = low - 0.5, high + 0.5
        if lo_b <= q0 <= hi_b:
            k = i0
        elif d > 0 and q0 > hi_b:
            kind = 'LMT'
            limit = high
            end = int(np.searchsorted(T, T[i0] + PENDING_VALID_MS, 'right'))
            k = first_le(Eq, i0 + 1, end, limit)
        elif d < 0 and q0 < lo_b:
            kind = 'LMT'
            limit = low
            end = int(np.searchsorted(T, T[i0] + PENDING_VALID_MS, 'right'))
            k = first_ge(Eq, i0 + 1, end, limit)
        else:
            return dict(status='SKIPPED_FAVOURABLE_SIDE', reason='price beyond range on favourable side at first tick')
        if k < 0:
            return dict(status='PENDING_EXPIRED', reason='limit not reached within 60 min of first tick')
    else:
        raise ValueError(mode)
    if kind == 'MKT':
        F = d * Eq[k] + costp.get('entry_slip', costp['slip'])
        fill_real = d * F
    else:
        pslip = costp.get('entry_slip', costp['slip']) if costp.get('pend_slip') else 0.0  # B2-style: adverse slip on the limit fill
        fill_real = limit + d * pslip
        F = d * limit + pslip
    dist = abs(fill_real - sig['sl'])
    sl_ok = (sig['sl'] < fill_real) if d > 0 else (sig['sl'] > fill_real)
    base = dict(idx=k, kind=kind, fill_real=float(fill_real), F=float(F), t_fill=int(T[k]), R_dist=float(dist))
    if guard:
        if not sl_ok:
            return dict(status='SKIPPED_GUARD_SL_SIDE', reason='SL wrong side of fill', **base)
        if dist < GUARD_MIN or dist > GUARD_MAX or dist > GUARD_K * abs(sig['mid'] - sig['sl']):
            return dict(status='SKIPPED_GUARD_DIST', reason='fill-SL distance guard', **base)
    return dict(status='FILLED', reason='', **base)


def simulate(win, fill, sig, strat, costp, persist=None):
    """win: dict(T, Xq = flipped exit quote d*Xreal). strat: dict(tps=[(tp_real, weight)...], be=None|dist, be_after_tp=None|idx).
    Returns dict(R, legs=[(kind, ms, price_real, weight)], unresolved, max_gap_min)."""
    T, Xq = win['T'], win['Xq']
    d = sig['dir']
    k, F, fill_real = fill['idx'], fill['F'], fill['fill_real']
    R = abs(fill_real - sig['sl'])
    end = int(np.searchsorted(T, fill['t_fill'] + HORIZON_MS, 'right'))
    SLf = d * sig['sl']
    slf = SLf
    be_done = False
    pos = k + 1
    legs = []
    remaining = 1.0
    tpk = 0
    tps = strat['tps']
    unresolved = False
    exit_idx = None
    while remaining > 1e-12:
        if pos >= end:
            unresolved = True
            last = end - 1 if end - 1 > k else k
            legs.append(('MTM', last, d * Xq[last] if last > k else fill_real, remaining))
            exit_idx = last
            remaining = 0.0
            break
        s_idx = pfirst(Xq, T, pos, end, slf, 'le', persist)
        t_idx = pfirst(Xq, T, pos, end, d * tps[tpk][0], 'ge', persist) if tpk < len(tps) else -1
        a_idx = pfirst(Xq, T, pos, end, F + strat['be'], 'ge', persist) if (strat.get('be') is not None and not be_done) else -1
        cands = [(x, o) for x, o in ((s_idx, 0), (t_idx, 1), (a_idx, 2)) if x >= 0]
        if not cands:
            pos = end
            continue
        idx, typ = min(cands)
        if typ == 0:
            fx = min(Xq[idx], slf) - costp['slip']
            legs.append(('BE' if be_done else 'SL', idx, d * fx, remaining))
            exit_idx = idx
            remaining = 0.0
            break
        if typ == 1:
            w = tps[tpk][1]
            legs.append(('TP%d' % (tpk + 1), idx, tps[tpk][0], w))
            exit_idx = idx
            remaining -= w
            if strat.get('be_after_tp') is not None and tpk == strat['be_after_tp'] and not be_done:
                slf = F
                be_done = True
            tpk += 1
            pos = idx + 1
            if remaining <= 1e-12:
                remaining = 0.0
                break
            continue
        slf = F
        be_done = True
        pos = idx + 1
    total = sum(w * (px - fill_real) * d for _, _, px, w in legs)
    maxgap = float(np.max(np.diff(T[k:exit_idx + 1]))) / 60000.0 if (exit_idx is not None and exit_idx > k) else 0.0
    return dict(R=total / R if R > 0 else float('nan'), legs=[(kk, int(T[i]), float(px), float(w)) for kk, i, px, w in legs],
                unresolved=unresolved, max_gap_min=maxgap, exit_ms=int(T[exit_idx]) if exit_idx is not None else None)
