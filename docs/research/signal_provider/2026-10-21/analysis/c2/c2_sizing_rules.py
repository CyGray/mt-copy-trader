"""C2 analytic check of the repo sizing rule (worker/src/lib/positionSizing.ts computeVolume) with the unverified spec
tick 0.01, tick value 1.0, contract 100 oz, step 0.01, min 0.01. Pure python (no numpy)."""
import math
STEP, MIN = 0.01, 0.01
def round_down(x, step=STEP):
    return math.floor(x / step + 1e-9) * step
def perlot(dist):            # riskPerLot = |entry-SL| / tickSize * tickValueLoss
    return dist / 0.01 * 1.0
def size(equity, risk_pct, dist, max_money=50.0, max_pct=1.0, max_lots=1.0):
    cap = min(max_money, equity * max_pct / 100.0)
    target = equity * risk_pct / 100.0
    vol = round_down(min(target, cap) / perlot(dist))
    vol = min(vol, round_down(max_lots))
    return vol, vol * perlot(dist), cap
print('equity  risk%  target  cap   dist  lots  realised_risk  realised_%  split4_ok(0.04 lots)')
for eq in (500, 1000, 5000, 10000, 50000):
    for d in (2.0, 3.125, 5.0, 6.0, 7.5, 10.0):
        v, rr, cap = size(eq, 0.25, d)
        print(f'{eq:6d}  0.25  {eq*0.0025:6.2f} {cap:5.1f} {d:5.2f} {v:5.2f}  {rr:8.2f}      {100*rr/eq:6.3f}      {"yes" if v >= 0.04 else "no"}')
print()
print('max SL distance (USD) at which 0.25% risk still allows 0.04 lots (4 x 0.01) under the default cap:')
for eq in (500, 1000, 5000):
    tgt = min(eq * 0.0025, min(50.0, eq * 0.01))
    print(' equity', eq, 'dist_max_for_0.04 =', round(tgt / 0.04 / 100, 3), 'USD; for 0.02 =', round(tgt / 0.02 / 100, 3))
print()
print('margin per lot = 100 * price / leverage:')
for price in (3900, 4000, 4300):
    print(' price', price, 'lev 100 ->', 100 * price / 100, 'USD;  lev 200 ->', 100 * price / 200, 'USD;  lev 500 ->', round(100 * price / 500, 1), 'USD')
print()
print('lots needed for 4-way split at 0.25% risk, equity 5000, SL 5.0 USD:', round(12.5 / perlot(5.0), 4), 'lots raw ->', round_down(12.5 / perlot(5.0)))
print('max equity risk default cap check: min(50, equity*1%) at 5000 =', min(50, 5000 * 0.01), ' at 500 =', min(50, 500 * 0.01))
