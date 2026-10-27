"""Benchmark: simulate ~300 strategy variants over all BASE-filled signals (for B2 sizing)."""
import csv, os, sys, time, itertools
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim_engine as se
RAW = '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a3/raw'
store = se.TickStore(RAW, os.path.join(HERE, 'cache'), mem_hours=64)
conv = se.Conventions()
ep = se.EntryParams('P1', latency_s=5, tol=0.5)
uni = {r['message_id']: r for r in csv.DictReader(open(os.path.join(HERE, 'signals_universe.csv')))}
sigs = []
for r in csv.DictReader(open(os.path.join(HERE, 'baseline_outcomes.csv'))):
    if r['scenario'] == 'BASE' and r['status'] == 'FILLED':
        u = uni[r['message_id']]
        tps = [float(u[f'tp{k}']) if u[f'tp{k}'] else None for k in range(1, 8)]
        sigs.append(se.Signal(u['message_id'], int(u['t_ms']), u['direction'], float(u['entry_low']),
                              float(u['entry_high']), float(u['sl']), tps))
variants = []
for p1, be_on, tr_on in itertools.product([20, 33.3, 50, 100], [0, 1], [0, 1]):
    for trail_dist, trail_step in itertools.product([1.0, 2.0, 3.0], [0.5, 1.0]):
        pct2 = 100 - p1
        cps = ((1, float(p1)), (2, pct2)) if p1 < 100 else ((1, 100.0),)
        kw = {}
        if be_on: kw['sl_after'] = ((1, 'entry', 0.0),)
        if tr_on: kw['trailing'] = (('after_tp', 2), trail_dist, trail_step)
        variants.append(se.Strategy(f'v{len(variants)}', checkpoints=cps, missing_tp='skip_trade', **kw))
variants = variants[:300]
t0 = time.time(); n = 0
for s in sigs:
    win = se.load_window(store, s.t_ms, s.t_ms + 80 * 3600_000)
    mk = se.Market(win, s.direction, 0.0)
    fill = se.decide_entry(s, ep, mk)
    if fill.status != 'FILLED':
        continue
    for v in variants:
        se.simulate(s, fill, v, mk, conv=conv, slip=0.0)
        n += 1
dt_ = time.time() - t0
print(f'signals {len(sigs)}, variants {len(variants)}, simulate calls {n}, seconds {dt_:.1f}, ms/call {1000*dt_/max(n,1):.2f}')
