"""Synthetic self-tests for c2_sim (hand-computed expectations)."""
import sys as _s; _s.path.append("/home/kyle/.local/lib/python3.12/site-packages")
import sys
sys.path.insert(0, '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/c2')
import numpy as np
import c2_sim as S

def mk_win(ticks, d):
    """ticks: list of (t_ms, bid, ask). Returns win dict as the runner builds it (BASE costs)."""
    T = np.array([t for t, _, _ in ticks], np.int64)
    bid = np.array([b for _, b, _ in ticks], float)
    ask = np.array([a for _, _, a in ticks], float)
    Eq = ask if d > 0 else bid
    Xreal = bid if d > 0 else ask
    return dict(T=T, Eq=Eq, Xq=d * Xreal)

ok = True
def check(name, got, exp, tol=1e-9):
    global ok
    good = (abs(got - exp) <= tol) if isinstance(exp, float) else (got == exp)
    ok &= good
    print(('PASS' if good else 'FAIL'), name, got, exp)

t0 = 1_000_000_000_000
H = 3600_000
# BUY signal: range 100.0-100.0, SL 97, TP1 103, TP2 106
sig = dict(t=t0, dir=1, low=100.0, high=100.0, sl=97.0, mid=100.0)
ticks = [(t0 + 6000, 100.2, 100.4), (t0 + 7000, 100.1, 100.3), (t0 + 8000, 103.1, 103.3), (t0 + 9000, 105.5, 105.7), (t0 + 20000, 102.0, 102.2)]
w = mk_win(ticks, 1)
f = S.decide_entry(sig, dict(T=w['T'], Eq=w['Eq']), 'E1', S.BASE, cap_ms=72*H)
check('E1 BASE fills at first in-band ask (100.4 - tol band ok)', f['status'], 'FILLED')
check('E1 BASE fill price = ask 100.4? (tick t0+6000 is before lat? lat=5s -> 6s ok)', f['fill_real'], 100.4)
r = S.simulate(w, f, sig, dict(tps=[(103.0, 1.0)], be=None), S.BASE)
check('S_TP1 BASE R = (103 - 100.4)/|100.4-97| = (103-100.4)/3.4', r['R'], (103.0 - 100.4) / 3.4)
# MID: spread 0.10 so ask_eff=ask+0.05, bid_eff = bid-0.05, slip 0.05 -> fill = ask+0.10
wm = dict(T=w['T'], Eq=w['Eq'] + 0.05, Xq=w['Xq'])
ticks_mid = [(t0 + 6000, 100.2, 100.4), (t0 + 11000, 100.2, 100.4), (t0 + 12000, 103.1, 103.3)]
wmid = dict(T=np.array([t for t,_,_ in ticks_mid], np.int64), Eq=np.array([a for _,_,a in ticks_mid]) + 0.05, Xq=np.array([b for _,b,_ in ticks_mid]) - 0.05)
fm = S.decide_entry(sig, dict(T=wmid['T'], Eq=wmid['Eq']), 'E1', S.MID, cap_ms=72*H)
check('E1 MID fill = ask+0.05+0.05 = 100.5', fm['fill_real'], 100.5)
# SL test: gap below SL on BUY -> fill at gapped bid minus slip
ticks_gap = [(t0 + 6000, 100.2, 100.4), (t0 + 9000, 95.0, 95.2)]
wg = mk_win(ticks_gap, 1)
fg = S.decide_entry(sig, dict(T=wg['T'], Eq=wg['Eq']), 'E3', S.BASE, cap_ms=72*H)
rg = S.simulate(wg, fg, sig, dict(tps=[(103.0, 1.0)], be=None), S.BASE)
check('gapped SL fills at 95.0 (tick price), R=(95-100.4)/3.4', rg['R'], (95.0 - 100.4) / 3.4)
rg2 = S.simulate(wg, fg, sig, dict(tps=[(103.0, 1.0)], be=None), S.MID)
# BE: activation at bid>=fill+4 (104.4) then bid<=fill -> BE exit at fill-? (BASE slip 0)
ticks_be = [(t0 + 6000, 100.2, 100.4), (t0 + 7000, 104.6, 104.8), (t0 + 8000, 100.3, 100.5)]
wb = mk_win(ticks_be, 1)
fb = S.decide_entry(sig, dict(T=wb['T'], Eq=wb['Eq']), 'E3', S.BASE, cap_ms=72*H)
rb = S.simulate(wb, fb, sig, dict(tps=[(110.0, 1.0)], be=4.0), S.BASE)
check('BE: activate bid 104.6>=104.4; BE stop gapped to bid 100.3 -> R=(100.3-100.4)/3.4', rb['R'], (100.3-100.4)/3.4)
check('BE leg kind', rb['legs'][0][0], 'BE')
# Q split with two TPs present: 25% TP1, 75% TP2 (merged)
ticks_q = [(t0 + 6000, 100.2, 100.4), (t0 + 7000, 103.2, 103.4), (t0 + 8000, 106.5, 106.7)]
wq = mk_win(ticks_q, 1)
fq = S.decide_entry(sig, dict(T=wq['T'], Eq=wq['Eq']), 'E3', S.BASE, cap_ms=72*H)
rq = S.simulate(wq, fq, sig, dict(tps=[(103.0, 0.25), (106.0, 0.75)], be=None), S.BASE)
check('Q 25/75 merged: R = (0.25*(103-100.4) + 0.75*(106-100.4))/3.4', rq['R'], (0.25*(103-100.4) + 0.75*(106-100.4))/3.4)
# SELL mirror: SL above, TP below
sigS = dict(t=t0, dir=-1, low=100.0, high=100.0, sl=103.0, mid=100.0)
ticks_s = [(t0 + 6000, 99.6, 99.8), (t0 + 7000, 97.0, 97.2), (t0 + 8000, 96.7, 96.9)]
ws = mk_win(ticks_s, -1)
fs = S.decide_entry(sigS, dict(T=ws['T'], Eq=ws['Eq']), 'E3', S.BASE, cap_ms=72*H)
check('SELL fill at bid 99.6', fs['fill_real'], 99.6)
rs = S.simulate(ws, fs, sigS, dict(tps=[(97.0, 1.0)], be=None), S.BASE)
check('SELL TP at 97.0 touched by ask 96.9: R=(99.6-97)/3.4', rs['R'], (99.6 - 97.0) / 3.4)
# Pending BUY limit (E2): first tick above range (ask 101 > 100.5), later ask 99.9 <= limit 100 -> fill at 100.0
sig2 = dict(t=t0, dir=1, low=99.0, high=100.0, sl=97.0, mid=99.5)
ticks_p = [(t0 + 6000, 100.8, 101.0), (t0 + 7000, 99.8, 99.9)]
wp = mk_win(ticks_p, 1)
fp = S.decide_entry(sig2, dict(T=wp['T'], Eq=wp['Eq']), 'E2', S.BASE, cap_ms=72*H)
check('E2 pending BUY fills at limit 100.0 (not 99.9)', fp['fill_real'], 100.0)
check('E2 pending kind LMT', fp['kind'], 'LMT')
print('ALL PASS' if ok else 'SOME FAILED')
