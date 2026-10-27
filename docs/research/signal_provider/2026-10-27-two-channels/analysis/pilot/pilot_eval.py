"""Pre-registered PILOT evaluation (descriptive; no selection). usage: pilot_eval.py UNIVERSE_CSV RAWDIR OUT_PREFIX
Fixed set: S_TP1..4|M0, S_TP4|M5, Q_25x4|M0, Q_25x4|M3; E1/E2/E3 x BASE/MID/PESS; gold engine unchanged.
Also a no-strategy touch check from the signal time: first touch of entry zone, stop, each TP (bid/ask sides)."""
import csv, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, 'b2'))
import b2_core as c, sim_engine_b2 as se, numpy as np
uni, raw, prefix = sys.argv[1:4]
c.UNIVERSE = uni
NAMES = ['S_TP1|M0', 'S_TP2|M0', 'S_TP3|M0', 'S_TP4|M0', 'S_TP4|M5', 'Q_25x4|M0', 'Q_25x4|M3'] + [x for x in os.environ.get('PILOT_EXTRA', '').split(',') if x]
V = [v for v in c.build_grid() if v['name'] in NAMES]; assert len(V) == len(NAMES)
for v in V: v['strategy'] = c.make_strategy(v)
sigs = c.load_signals()
for s in sigs: s.meta['split'] = 'pilot'
store = se.TickStore(raw, prefix + '_cache', mem_hours=64)
fills, trades, touch = [], [], []
for s in sigs:
    fr, tr = c.evaluate_signal(store, s, V); fills += fr; trades += tr
    win = c.get_window(store, s)
    ms_, bid, ask = win.ms, win.bid, win.ask
    def first(mask):
        i = np.flatnonzero(mask); return (int(ms_[i[0]]) - s.t_ms) / 60000 if len(i) else None
    buy = s.direction == 'buy'
    t = dict(message_id=s.message_id, direction=s.direction, known_until_h=round((win.known_until - s.t_ms) / 3.6e6, 2),
             n_ticks=int(len(ms_)),
             entry_zone_min=first((ask <= s.entry_high) if buy else (bid >= s.entry_low)),
             stop_min=first((bid <= s.sl) if buy else (ask >= s.sl)))
    for k, tp in enumerate([x for x in s.tps if x is not None], 1):
        t[f'tp{k}_min'] = first((bid >= tp) if buy else (ask <= tp))
    t['min_bid_6h'] = float(bid[ms_ < s.t_ms + 6 * 3.6e6].min()); t['max_ask_6h'] = float(ask[ms_ < s.t_ms + 6 * 3.6e6].max())
    touch.append(t)
for name, rows in (('trades', trades), ('fills', fills)):
    with open(f'{prefix}_{name}.csv', 'w', newline='') as f:
        if not rows:
            continue                      # e.g. no signal could be filled: nothing to write
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
rng = np.random.default_rng(12345)
def boot(x, B=10000):
    x = np.asarray(x, float)
    if len(x) < 2: return None, None
    m = x[rng.integers(0, len(x), (B, len(x)))].mean(1); return float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))
res = []
for en in ('E1', 'E2', 'E3'):
    for cn in ('BASE', 'MID', 'PESS'):
        for v in NAMES:
            rr = [t for t in trades if t['entry'] == en and t['cost'] == cn and t['variant'] == v]
            x = [float(t['total_R']) for t in rr if t['total_R'] != '']
            lo, hi = boot(x)
            res.append(dict(entry=en, cost=cn, variant=v, n=len(x), mean_R=round(float(np.mean(x)), 3) if x else None,
                            ci_lo=None if lo is None else round(lo, 3), ci_hi=None if hi is None else round(hi, 3),
                            per_signal={t['message_id']: (t['status'], t['final_exit'], t['total_R']) for t in rr}))
out = dict(n_signals=len(sigs), fills={f"{f['message_id']}|{f['entry']}|{f['cost']}": (f['status'], f['reason'], f['fill_px'], f['kind']) for f in fills},
           touch=touch, results=res)
json.dump(out, open(prefix + '_summary.json', 'w'), indent=1)
print(json.dumps(touch, indent=1))
for r in res:
    if r['cost'] == 'MID': print(r['entry'], r['variant'], r['n'], r['mean_R'], r['per_signal'])
