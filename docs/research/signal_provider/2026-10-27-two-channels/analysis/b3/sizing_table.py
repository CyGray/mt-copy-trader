"""Lot-size feasibility per symbol and stop distance with the positionSizing.ts port (b3/risk_model.py).
usage: sizing_table.py OUT_JSON. Specs read via the read-only bridge on 2026-10-27 (Verified); policy 0.25% equity
risk, below-min -> skip (never use_min_if_within_cap), default safety caps (min(50 USD, 1%)) and hard ceilings."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import risk_model as rm
SPECS = {  # bridge SYMBOL_INFO 2026-10-27T02:25Z (tick_value_loss used for losses)
    'XAUUSD': dict(tickSize=0.01, tickValueLoss=1.0, volumeMin=0.01, volumeMax=100.0, volumeStep=0.01),
    'EURUSD': dict(tickSize=0.00001, tickValueLoss=1.0, volumeMin=0.01, volumeMax=100.0, volumeStep=0.01),
    'GBPUSD': dict(tickSize=0.00001, tickValueLoss=1.0, volumeMin=0.01, volumeMax=100.0, volumeStep=0.01),
    'USDJPY': dict(tickSize=0.001, tickValueLoss=0.63435274, volumeMin=0.01, volumeMax=100.0, volumeStep=0.01),
}
CASES = [('XAUUSD', 'Lucas S3 E2 fill 3992.05 / SL 3984', 8.05), ('XAUUSD', 'Lucas S4 E2 fill 4010.95 / SL 4018 (final)', 7.05),
         ('XAUUSD', 'Lucas S4 first-seen SL 4028', 17.05), ('XAUUSD', 'earlier provider median-like 6 USD', 6.0),
         ('EURUSD', 'FX example 30 pips', 0.0030), ('GBPUSD', 'FX example 40 pips', 0.0040), ('USDJPY', 'FX example 30 pips', 0.30)]
pol = rm.sizing_policy('pct', 0.25, 'skip')
out = []
for sym, label, dist in CASES:
    spec = SPECS[sym]
    per_lot = rm.risk_per_lot(dist, spec)
    row = dict(symbol=sym, case=label, stop_distance=dist, risk_per_lot_usd=round(per_lot, 2),
               equity_for_min_lot_at_0_25pct=round(spec['volumeMin'] * per_lot / 0.0025, 0))
    for eq in (1000, 5000, 50000):
        for name, safety in (('default', rm.DEFAULT_SAFETY), ('hard', rm.HARD_SAFETY)):
            r = rm.compute_volume_at_distance(pol, dist, eq, spec, rm.effective_limits(safety))
            row[f'{eq}_{name}'] = (r['volume'], round(r['riskMoney'], 2)) if r['ok'] else r['reason']
    out.append(row)
json.dump(out, open(sys.argv[1], 'w'), indent=1)
for r in out: print(r)
