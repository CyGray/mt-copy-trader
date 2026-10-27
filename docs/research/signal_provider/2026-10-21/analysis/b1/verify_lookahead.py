"""Engine-level no-look-ahead check (Task 3 part D).

For every signal and for the BASE and PESS entry rules, the engine is run twice:
  (1) on the window starting at signal time t (the production path), and
  (2) on the window starting at t + latency (ticks before t + latency removed).
Entry decision, baseline first touches and TP1/equal-thirds simulation must be identical.
Any dependence on ticks before t + latency would show up as a difference.
"""
import csv, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim_engine as se
RAW = '/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad/a3/raw'
store = se.TickStore(RAW, os.path.join(HERE, 'cache'), mem_hours=64)
conv = se.Conventions()
uni = list(csv.DictReader(open(os.path.join(HERE, 'signals_universe.csv'))))
EP = {'BASE': se.EntryParams('P1', latency_s=5, tol=0.5, extra_spread=0.0, slippage=0.0),
      'PESS': se.EntryParams('P1', latency_s=15, tol=0.5, extra_spread=0.2, slippage=0.1)}
STR = se.Strategy('tp1', checkpoints=((1, 100.0),), missing_tp='skip_trade')
EQ = se.Strategy('eq3', checkpoints=((1, 100/3), (2, 100/3), (3, 100/3)), missing_tp='merge_into_last_available')

def run(sig, ep, t_from):
    win = se.load_window(store, t_from, sig.t_ms + 80 * 3600_000)
    mk = se.Market(win, sig.direction, ep.extra_spread)
    fill = se.decide_entry(sig, ep, mk)
    key = [fill.status, fill.fill_ms, fill.fill_px]
    if fill.status == 'FILLED':
        bl = se.baseline_touch(sig, fill, mk, 72.0)
        key += [bl['status'], bl.get('sl_idx') and int(mk.ms[bl['sl_idx']]),
                sorted((k, int(mk.ms[v])) for k, v in bl['tp_idx'].items() if v is not None)]
        key += [se.simulate(sig, fill, STR, mk, conv=conv, slip=ep.slippage)['total_R'] if True else None]
        key += [se.simulate(sig, fill, EQ, mk, conv=conv, slip=ep.slippage).get('total_R')]
    return key

checked = bad = 0
for r in uni:
    tps = [float(r[f'tp{k}']) if r[f'tp{k}'] else None for k in range(1, 8)]
    sig = se.Signal(r['message_id'], int(r['t_ms']), r['direction'], float(r['entry_low']), float(r['entry_high']),
                    float(r['sl']), tps)
    for scen, ep in EP.items():
        lat_ms = int(round(ep.latency_s * 1000))
        a = run(sig, ep, sig.t_ms)
        b = run(sig, ep, sig.t_ms + lat_ms)
        checked += 1
        if a != b:
            bad += 1
            print('DIFF', r['message_id'], scen, a, b)
print(f'look-ahead check: {checked} (signal x scenario) runs, {bad} differences')
