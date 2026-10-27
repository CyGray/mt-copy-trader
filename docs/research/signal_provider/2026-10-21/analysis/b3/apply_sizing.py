#!/usr/bin/env python3
"""Reusable sizing simulator for ANY trade-R CSV (read-only; writes only the paths you pass).

Input CSV header (case-sensitive):
  time             trade open/fill time, ISO-8601 UTC (e.g. 2025-11-06T14:55:42Z) or epoch ms   [required]
  r_multiple       realised R of the trade (-1 = full stop-loss, +2 = two R gained)              [required]
  risk_distance    realised stop distance |fill - SL| in price units (USD/oz for XAUUSD)           [required]
  sizing_distance  decision-time stop distance used for sizing (default: risk_distance)           [optional]
  close_time       ISO or epoch ms; default time + hold_hours                                      [optional]
  hold_hours       used when close_time is absent (default 24)                                     [optional]
  pnl_per_lot_usd  exact USD per 1.0 lot for the whole trade; overrides r_multiple x distance     [optional]
  entry_price      price for margin (default 4000)                                                 [optional]
  direction        buy|sell, informational                                                         [optional]
Without pnl_per_lot_usd, P&L = lots x 100 x r_multiple x risk_distance (linear; no split rounding).

Example:
  nice -n 10 python3 -I apply_sizing.py --trades work/example_b1_eq3_base.csv --policy pct:0.5 \
      --equity 500,1000,5000,10000,50000 --safety default --out work/example_curves.csv
  policy: pct:<risk %>  |  money:<USD>  |  lots:<lots>; --below-min skip|use_min_if_within_cap
  --safety default|hard (or --safety-json file.json with the settings.safety keys)
  --gates on|off (entry gates of mt5TradeEngine.ts; off = sizing + splits only)
Unverified specs (contract 100 oz, tick 0.01, tick value 1.0, min/step 0.01, max 100 lots, leverage 1:100)
can be overridden with --spec-json and --leverage. Closed equity only (no floating P&L).
"""
import argparse, csv, json, os, sys
from datetime import datetime, timezone
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import risk_model as rm


def parse_time_ms(v):
    v = v.strip()
    if v.lstrip('-').isdigit():
        return int(v)
    return int(datetime.fromisoformat(v.replace('Z', '+00:00')).replace(tzinfo=timezone.utc).timestamp() * 1000)


def load_trades(path, default_hold_h, default_entry):
    trades = []
    with open(path, newline='') as fh:
        rd = csv.DictReader(fh)
        for i, r in enumerate(rd):
            open_ms = parse_time_ms(r['time'])
            dist = float(r['risk_distance'])
            sd = float(r['sizing_distance']) if r.get('sizing_distance') else dist
            if r.get('close_time'):
                close_ms = parse_time_ms(r['close_time'])
            else:
                hold = float(r['hold_hours']) if r.get('hold_hours') else default_hold_h
                close_ms = open_ms + int(hold * 3600 * 1000)
            if r.get('pnl_per_lot_usd'):
                move = float(r['pnl_per_lot_usd']) / 100.0  # contract 100 oz: pnl/lot = move x 100
            else:
                move = float(r['r_multiple']) * dist
            entry = float(r['entry_price']) if r.get('entry_price') else default_entry
            trades.append({'id': i, 'open_ms': open_ms, 'close_ms': close_ms, 'sd': sd, 'entry_px': entry,
                           'legs': [(100.0, move)]})
    return trades


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--trades', required=True)
    ap.add_argument('--policy', required=True)
    ap.add_argument('--equity', default='500,1000,5000,10000,50000')
    ap.add_argument('--safety', default='default', help='default | hard | (use --safety-json)')
    ap.add_argument('--safety-json')
    ap.add_argument('--spec-json')
    ap.add_argument('--below-min', default='skip', choices=['skip', 'use_min_if_within_cap'])
    ap.add_argument('--gates', default='on', choices=['on', 'off'])
    ap.add_argument('--leverage', type=float, default=100.0)
    ap.add_argument('--margin-factor', type=float, default=1.0)
    ap.add_argument('--commission-rt', type=float, default=0.0, help='USD per lot round trip')
    ap.add_argument('--adverse', type=float, default=0.0, help='extra adverse fill, USD/oz, on every trade')
    ap.add_argument('--per-symbol', type=int)
    ap.add_argument('--hold-hours', type=float, default=24.0)
    ap.add_argument('--out', help='CSV of closed-equity curves (one block per starting equity)')
    a = ap.parse_args(argv)

    kind, val = a.policy.split(':')
    sizing = rm.sizing_policy(kind, float(val), a.below_min)
    safety = rm.HARD_SAFETY if a.safety == 'hard' else rm.DEFAULT_SAFETY
    if a.safety_json:
        safety = json.load(open(a.safety_json))
    spec = dict(rm.SPEC_UNVERIFIED)
    if a.spec_json:
        spec.update(json.load(open(a.spec_json)))
    trades = load_trades(a.trades, a.hold_hours, 4000.0)
    summary, curve_rows = [], []
    for E0 in [float(x) for x in a.equity.split(',')]:
        cfg = rm.make_cfg(safety, spec=spec, leverage=a.leverage, margin_factor=a.margin_factor,
                          commission_rt=a.commission_rt, adverse=a.adverse)
        if a.per_symbol is not None:
            cfg['limits']['maxPerSymbol'] = a.per_symbol
        out = rm.run_path(trades, sizing, E0, cfg, gates=(a.gates == 'on'))
        mdd_pct, mdd_usd = rm.max_drawdown(out['curve'])
        day = {}
        for t in out['taken']:
            d = t['close_ms'] // 86400000
            day[d] = day.get(d, 0.0) + t['pnl']
        breaches = sum(1 for v in day.values() if -v >= cfg['limits']['dailyLossLimit'])
        summary.append({'equity0': E0, 'policy': a.policy, 'taken': len(out['taken']), 'of': len(trades),
                        'skips': out['skips'], 'final_equity': round(out['final_equity'], 2),
                        'return_pct': round(100 * (out['final_equity'] / E0 - 1), 2),
                        'max_dd_closed_pct': round(mdd_pct, 2), 'max_dd_closed_usd': round(mdd_usd, 2),
                        'min_closed_equity': round(min(e for _, e in out['curve']), 2),
                        'days_with_daily_limit_breach': breaches, 'daily_limit_usd': cfg['limits']['dailyLossLimit']})
        for t_ms, eq in out['curve']:
            curve_rows.append({'equity0': E0, 'policy': a.policy, 'time_ms': t_ms, 'closed_equity': round(eq, 4)})
    print(json.dumps(summary, indent=1))
    if a.out:
        with open(a.out, 'w', newline='') as fh:
            w = csv.DictWriter(fh, fieldnames=['equity0', 'policy', 'time_ms', 'closed_equity'])
            w.writeheader(); w.writerows(curve_rows)
    return 0


def write_example(path):
    """Export B1 BASE EQ3 fills as a generic CSV (time, r_multiple, risk_distance, sizing_distance, close_time, pnl_per_lot_usd)."""
    tr = json.load(open(os.path.join(HERE, 'work', 'trades.json')))
    rows = [t for t in tr if t['scen'] == 'BASE' and t['strategy'] == 'EQ3']
    rows.sort(key=lambda t: t['fill_ms'])
    with open(path, 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['time', 'r_multiple', 'risk_distance', 'sizing_distance', 'close_time', 'pnl_per_lot_usd', 'entry_price', 'direction'])
        for t in rows:
            w.writerow([t['fill_ms'], t['total_R'], round(t['r_usd_fill'], 6), t['sl_dist_nominal'], t['close_ms'],
                        t['usd_per_1lot'], t['fill_px'], t['direction']])
    return len(rows)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--write-example':
        print(write_example(os.path.join(HERE, 'work', 'example_b1_eq3_base.csv')))
    else:
        sys.exit(main())
