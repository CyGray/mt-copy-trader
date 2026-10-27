"""Evaluate the FROZEN finalists on an OOS2 universe. No tuning. Clean signals only unless --all.
usage: oos2_eval.py UNIVERSE_CSV OUT_PREFIX [--all] [--symbol SYM] [--raw DIR] [--b2 DIR]
  --symbol  XAUUSD (default, the study) or any symbol in a3/symbols.py (USD parameters scaled, see b2_core)
  --raw     Dukascopy bi5 tree (default: b2_core.RAW, i.e. <study>/a3/raw)
  --b2      directory holding b2_core.py and out/finalists.json (default: ../b2 next to this script)
Output: <prefix>_trades.csv, <prefix>_fills.csv, <prefix>_summary.json. Cache: cache_oos2 next to the prefix
(gold) or cache_oos2_<SYMBOL> (other symbols)."""
import argparse, csv, json, os, sys, random, math, collections
HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('universe')
ap.add_argument('prefix')
ap.add_argument('--all', action='store_true')
ap.add_argument('--symbol', default='XAUUSD')
ap.add_argument('--raw', default=None)
ap.add_argument('--b2', default=os.path.join(os.path.dirname(HERE), 'b2'))
args = ap.parse_args()
B2 = args.b2
sys.path.insert(0, B2)
import b2_core as c
import sim_engine_b2 as se
import numpy as np

uni, prefix = args.universe, args.prefix
c.UNIVERSE = uni
sp = c.configure_symbol(args.symbol)     # XAUUSD: every value unchanged; other symbols: pip-scaled USD parameters
if args.raw:
    c.RAW = args.raw
print(f"symbol={sp['symbol']} price_divisor={sp['price_divisor']:g} unit={sp['unit']:g} contract={sp['contract']:g} "
      f"raw={c.RAW} b2={B2}")
fin = json.load(open(os.path.join(B2, 'out', 'finalists.json')))
names = [d['variant'] for d in fin['finalists']] + [fin['benchmark']]
V = [v for v in c.build_grid() if v['name'] in names]
assert len(V) == len(names)
for v in V:
    v['strategy'] = c.make_strategy(v)
sigs = c.load_signals()
extra = {r['message_id']: r for r in csv.DictReader(open(uni))}
for s in sigs:
    s.meta['split'] = 'oos2'
    s.meta['edit_delay_s'] = float(extra[s.message_id]['edit_delay_s'] or 0)
    s.meta['levels_changed'] = int(extra[s.message_id]['levels_changed'])
use = [s for s in sigs if s.meta['in_clean'] == 1 or args.all]
cache = 'cache_oos2' if sp['symbol'] == 'XAUUSD' else f"cache_oos2_{sp['symbol']}"
store = se.TickStore(c.RAW, os.path.join(os.path.dirname(prefix), cache), mem_hours=64,
                     price_divisor=sp['price_divisor'])
fills, trades = [], []
for s in use:
    fr, tr = c.evaluate_signal(store, s, V)
    for t in tr:
        t['edit_delay_s'] = s.meta['edit_delay_s']; t['levels_changed'] = s.meta['levels_changed']
    fills += fr; trades += tr
fields = list(trades[0].keys()) if trades else []
with open(prefix + '_trades.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(trades)
with open(prefix + '_fills.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(fills[0].keys())); w.writeheader(); w.writerows(fills)

rng = np.random.default_rng(12345)
def boot(x, B=10000):
    x = np.asarray(x, float)
    if len(x) < 2: return (float('nan'),) * 3
    m = x[rng.integers(0, len(x), (B, len(x)))].mean(1)
    p = 2 * min((m <= 0).mean(), (m >= 0).mean())  # approx two-sided vs zero (percentile)
    return float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5)), float(min(1, p))

def rows(entry, cost, variant, flt=None):
    return [float(t['total_R']) for t in trades if t['entry'] == entry and t['cost'] == cost and t['variant'] == variant
            and t['total_R'] != '' and (flt is None or flt(t))]

out = dict(n_signals=len(use), fills={}, results=[], edit_split=[])
for en in ('E1', 'E2', 'E3'):
    for cn in ('BASE', 'MID', 'PESS'):
        nf = sum(1 for f in fills if f['entry'] == en and f['cost'] == cn and f['status'] == 'FILLED')
        out['fills'][f'{en}|{cn}'] = nf
pvals = []
for en in ('E1', 'E2', 'E3'):
    for cn in ('BASE', 'MID', 'PESS'):
        for v in names:
            x = rows(en, cn, v)
            lo, hi, p = boot(x)
            out['results'].append(dict(entry=en, cost=cn, variant=v, n=len(x), mean_R=round(float(np.mean(x)), 4) if x else None,
                                       ci_lo=round(lo, 4), ci_hi=round(hi, 4), p_boot=round(p, 4) if p == p else None,
                                       win_pct=round(100 * float(np.mean([r > 0.1 for r in x])), 1) if x else None))
            if cn == 'MID' and en in ('E1', 'E2'): pvals.append((p, len(out['results']) - 1))
# Holm across the 12 primary tests (6 variants x E1,E2 at MID)
pvals = sorted(p for p in pvals if p[0] == p[0])
m = len(pvals); run = 0
for i, (p, idx) in enumerate(pvals):
    run = max(run, min(1.0, (m - i) * p)); out['results'][idx]['p_holm'] = round(run, 4)
for en in ('E2', 'E1'):
    for v in names:
        a = rows(en, 'MID', v, lambda t: float(t['edit_delay_s']) > 300)
        b = rows(en, 'MID', v, lambda t: float(t['edit_delay_s']) <= 300)
        out['edit_split'].append(dict(entry=en, variant=v, late_n=len(a), late_mean=round(float(np.mean(a)), 3) if a else None,
                                      stable_n=len(b), stable_mean=round(float(np.mean(b)), 3) if b else None))
json.dump(out, open(prefix + '_summary.json', 'w'), indent=1)
print(json.dumps(dict(n_signals=out['n_signals'], fills=out['fills']), indent=1))
for r in out['results']:
    if r['cost'] == 'MID' and r['entry'] in ('E1', 'E2'):
        print(r['entry'], r['variant'], 'n', r['n'], 'mean', r['mean_R'], '[', r['ci_lo'], r['ci_hi'], '] holm', r.get('p_holm'))
for r in out['edit_split']:
    print('edit-split', r)
